import { callAgent } from "./modelClient.js";
import { buildFinalPrompt, buildRoundPrompt } from "./promptBuilder.js";
import { buildContextPromptSections, buildMemberContext } from "./contextBuilder.js";
import { parseFinalDecision, parseRoundResponse } from "./responseParser.js";
import { makeId, nowIso } from "./types.js";
import { isConsensusParticipant, isSupportingResponse, latestResponses, markAutoCompletedResponses, scoreConsensus, shouldStop, updateUnresolvedObjections } from "./consensusEngine.js";
import { appendMemoryCandidates, writeGroupSession, writeSession } from "./storage.js";
import { assessBudgetUsage, assessSizeUsage } from "./tokenLimits.js";
import { appendSessionTranscriptChunk, readSummaryCache, updateDeterministicSummaries } from "./summaryCache.js";
import { appendSessionUsage, estimateCost, estimateMemberAccruedCost } from "./usageStats.js";
import { applyObjectionLedger, isReviewerLike } from "./objectionLedger.js";
import { computeFinalState } from "./finalState.js";
import { parseFileOperationProposals } from "./fileOperations.js";
import { runAutoFileOperations } from "./fileOperationAutoRunner.js";
import { enqueueFileOperationProposals } from "./fileOperationQueue.js";
import { readPrivateContextMessages } from "./privateChat.js";
import fs from "node:fs";
import path from "node:path";

export async function runCouncil(question, group, baseDir, options = {}) {
  let finalResult;
  for await (const event of runCouncilEvents(question, group, baseDir, options)) {
    if (event.type === "done") finalResult = event.result;
  }
  return finalResult;
}

export async function* runCouncilEvents(question, group, baseDir, options = {}) {
  const enabledAgents = group.agents.filter((agent) => agent.enabled);
  const firstRoundAgents = selectFirstRoundAgents(enabledAgents, {
    startAfterAgentId: options.startAfterAgentId,
    startAtAgentId: options.startAtAgentId
  });
  const globalRequirement = options.globalRequirement || group.settings?.globalRequirement || "";
  const continuationContext = normalizeContinuationContext(options.continuationContext);
  const workspaceGroup = options.groupPath ? readWorkspaceGroup(options.groupPath) : undefined;
  const session = {
    id: makeId("session"),
    question,
    continuationContext,
    groupId: group.id,
    groupSnapshot: redactGroupForSession(group),
    status: "running",
    activeAgentIds: firstRoundAgents.map((agent) => agent.id),
    unresolvedObjections: {},
    consensusByRound: [],
    artifacts: [],
    fileOperationProposals: [],
    rejectedFileOperationProposals: [],
    pendingFileOperationProposals: [],
    messages: []
  };

  let consensus = scoreConsensus(enabledAgents, session);
  for (let round = 1; round <= group.settings.maxRounds; round += 1) {
    const agentsToCall = selectAgents(enabledAgents, session, round, firstRoundAgents);
    const results = [];

    for (const agent of agentsToCall) {
      throwIfAborted(options.signal);
      const seat = findWorkspaceSeat(workspaceGroup, agent);
      const memberContext = buildMemberContext(agent, session, {
        question,
        groupSettings: group.settings,
        globalRequirement,
        continuationContext,
        latestBossInstruction: options.latestBossInstruction || "",
        ...loadSummaryContext(options.groupPath, agent),
        privateBossMessages: loadPrivateBossMessages(options.groupPath, agent)
      });
      const contextStatus = summarizeContextStatus(memberContext, {
        groupPath: options.groupPath,
        seat,
        agent
      });
      yield {
        type: "agent_start",
        round,
        agentId: agent.id,
        agentName: agent.name,
        contextStatus,
        createdAt: nowIso()
      };

      if (memberContext.coreOverflow) {
        const message = buildUnavailableMessage(agent, round, `non_compressible_core_exceeds_input_limit:${contextStatus.nonCompressibleCoreTokens}/${contextStatus.effectiveInputLimit}`, contextStatus);
        results.push(message);
        session.messages.push(message);
        recordObjections(session, agent, message.response, round, group.settings);
        yield {
          type: "agent_message",
          message,
          createdAt: message.createdAt
        };
        continue;
      }

      const budgetBlockReason = limitBlockReason(memberContext, contextStatus, {
        groupPath: options.groupPath,
        seat,
        agent
      });
      if (budgetBlockReason) {
        const message = buildUnavailableMessage(agent, round, budgetBlockReason, contextStatus);
        results.push(message);
        session.messages.push(message);
        recordObjections(session, agent, message.response, round, group.settings);
        yield {
          type: "agent_message",
          message,
          createdAt: message.createdAt
        };
        continue;
      }

      const messages = buildRoundPrompt(agent, question, session, round, {
        globalRequirement,
        resumeInstruction: options.startAtAgentId === agent.id ? options.resumeInstruction : "",
        contextSections: buildContextPromptSections(memberContext),
        fileOperationContext: Boolean(options.groupPath),
        fileOperationPermissionTier: effectiveWorkspacePermissionTier(workspaceGroup, agent),
        groupSettings: group.settings
      });
      const modelCallRecord = notifyModelCall(options, {
        phase: "round",
        round,
        agentId: agent.id,
        agentName: agent.name,
        inputMessages: messages
      });
      const streamingCall = startAgentCallWithDeltaQueue(agent, messages, group.settings.agentTimeoutMs, options.signal);
      while (!streamingCall.done() || streamingCall.hasDeltas()) {
        const delta = await streamingCall.nextDelta();
        if (!delta) continue;
        yield {
          type: "agent_delta",
          round,
          agentId: agent.id,
          agentName: agent.name,
          delta,
          createdAt: nowIso()
        };
      }
      const rawText = await streamingCall.result();
      completeModelCall(modelCallRecord, rawText);
      let response = rawText.error
        ? { status: "unavailable", reason: rawText.error, retryable: true }
        : parseRoundResponse(rawText.text);

      if (round === 1 && isReviewerLike(agent) && response.status === "skip") {
        response = {
          status: "speak",
          position: "reviewer_required",
          argument: "An explicitly assigned reviewer cannot skip in round 1.",
          objections: ["reviewer_required"],
          suggested_revision: "Provide at least one concrete in-scope risk or explicitly state what was checked.",
          confidence: 0,
          memory_candidates: []
        };
      }

      const artifacts = collectMessageArtifacts(response, agent, round);
      session.artifacts.push(...artifacts);
      const fileOperationResult = collectFileOperationProposals(response, agent, round, options.groupPath);
      session.fileOperationProposals.push(...fileOperationResult.accepted);
      const queueResult = queueFileOperationProposals(fileOperationResult, options.groupPath);
      session.pendingFileOperationProposals.push(...queueResult.queued);
      session.rejectedFileOperationProposals.push(...queueResult.rejected);

      const message = {
        round,
        agentId: agent.id,
        agentName: agent.name,
        response,
        artifacts,
        fileOperationProposals: fileOperationResult.accepted,
        pendingFileOperationProposals: queueResult.queued,
        rejectedFileOperationProposals: [...fileOperationResult.rejected, ...queueResult.rejected],
        displayText: formatDisplayText(agent, response),
        rawText: rawText.error ? "" : rawText.text,
        error: rawText.error,
        contextStatus,
        createdAt: nowIso()
      };
      results.push(message);
      session.messages.push(message);
      recordObjections(session, agent, message.response, round, group.settings);
      yield {
        type: "agent_message",
        message,
        createdAt: message.createdAt
      };
    }

    if (!results.length) break;

    markAutoCompletedResponses(session, enabledAgents);
    consensus = scoreConsensus(enabledAgents, session);
    session.consensusByRound.push({ round, ...consensus });
    yield {
      type: "round_complete",
      round,
      consensus,
      createdAt: nowIso()
    };
    if (shouldStop(consensus, enabledAgents, session, group.settings, round)) break;
  }

  throwIfAborted(options.signal);
  const judge = selectFinalizer(enabledAgents, session);
  const fallback = fallbackFinalDecision(session, consensus);
  const finalSeat = findWorkspaceSeat(workspaceGroup, judge);
  const finalContext = buildMemberContext(judge, session, {
    question,
    groupSettings: group.settings,
    globalRequirement,
    continuationContext,
    latestBossInstruction: options.latestBossInstruction || "",
    ...loadSummaryContext(options.groupPath, judge),
    privateBossMessages: loadPrivateBossMessages(options.groupPath, judge)
  });
  const finalContextStatus = summarizeContextStatus(finalContext, {
    groupPath: options.groupPath,
    seat: finalSeat,
    agent: judge
  });
  const finalBudgetBlockReason = limitBlockReason(finalContext, finalContextStatus, {
    groupPath: options.groupPath,
    seat: finalSeat,
    agent: judge
  });
  yield {
    type: "final_start",
    agentId: judge.id,
    agentName: judge.name,
    contextStatus: finalContextStatus,
    createdAt: nowIso()
  };
  if (finalContext.coreOverflow) {
    session.finalDecision = {
      ...fallback,
      risks: [
        ...fallback.risks,
        `final_judge_unavailable:non_compressible_core_exceeds_input_limit:${finalContextStatus.nonCompressibleCoreTokens}/${finalContextStatus.effectiveInputLimit}`
      ]
    };
  } else if (finalBudgetBlockReason) {
    session.finalDecision = {
      ...fallback,
      risks: [
        ...fallback.risks,
        `final_judge_unavailable:${finalBudgetBlockReason}`
      ]
    };
  } else {
    const finalMessages = buildFinalPrompt(judge, session, consensus, {
      globalRequirement,
      contextSections: buildContextPromptSections(finalContext)
    });
    const modelCallRecord = notifyModelCall(options, {
      phase: "final",
      agentId: judge.id,
      agentName: judge.name,
      inputMessages: finalMessages
    });
    const finalRaw = await safeCall(judge, finalMessages, group.settings.agentTimeoutMs, options.signal);
    completeModelCall(modelCallRecord, finalRaw);
    session.finalDecision = finalRaw.error
      ? { ...fallback, risks: [...fallback.risks, finalRaw.error] }
      : parseFinalDecision(finalRaw.text, fallback);
  }
  applyEngineFinalState(session, consensus, group.settings);
  if (options.groupPath) {
    const fileExecution = runAutoFileOperations({
      groupPath: options.groupPath,
      session,
      group: workspaceGroup || group
    });
    session.finalDecision.file_execution_state = fileExecution.state;
    session.finalDecision.file_execution_results = fileExecution.results;
  }
  session.finalDecision.memory_candidates = limitMemoryCandidates(session.finalDecision.memory_candidates);
  session.status = "completed";

  const sessionPath = options.groupPath
    ? writeGroupSession(session, options.groupPath)
    : writeSession(session, baseDir);
  const transcriptChunk = options.groupPath
    ? appendSessionTranscriptChunk(options.groupPath, session)
    : undefined;
  const summaryUpdate = options.groupPath
    ? updateDeterministicSummaries(options.groupPath, session, workspaceGroup)
    : undefined;
  const usageRecord = options.groupPath
    ? appendSessionUsage(options.groupPath, session, workspaceGroup)
    : undefined;
  const memoryRecords = appendMemoryCandidates(session.finalDecision, session, baseDir);

  const result = { session, sessionPath, memoryRecords, transcriptChunk, summaryUpdate, usageRecord };
  yield {
    type: "final_decision",
    session,
    finalDecision: session.finalDecision,
    contextStatus: finalContextStatus,
    createdAt: nowIso()
  };
  yield {
    type: "done",
    result,
    createdAt: nowIso()
  };
}

function notifyModelCall(options = {}, record = {}) {
  if (typeof options.onModelCall !== "function") return undefined;
  const safeRecord = { ...record };
  options.onModelCall(safeRecord);
  return safeRecord;
}

function completeModelCall(record, raw = {}) {
  if (!record) return;
  if (raw.error) record.error = raw.error;
  else record.rawText = raw.text || "";
}

function effectiveWorkspacePermissionTier(workspaceGroup, agent) {
  if (!workspaceGroup) return "text";
  const permissions = workspaceGroup.permissions || {};
  return permissions.seatTiers?.[agent.id] || permissions.defaultTier || "text";
}

function selectAgents(enabledAgents, session, round, firstRoundAgents = enabledAgents) {
  const roundEligibleAgents = enabledAgents.filter((agent) => participatesInRound(agent, enabledAgents));
  const firstRoundEligible = firstRoundAgents.filter((agent) => participatesInRound(agent, enabledAgents));
  if (round === 1) return firstRoundEligible;
  const latest = latestResponses(session);
  return roundEligibleAgents.filter((agent) => {
    if (agent.mandatoryRedTeam) return reviewerNeedsFollowUp(session, agent, latest.get(agent.id));
    if (!isConsensusParticipant(agent)) return false;
    return !isSupportingResponse(latest.get(agent.id));
  });
}

function participatesInRound(agent, enabledAgents) {
  if (!agent.judge) return true;
  if (agent.consensusParticipant === true) return true;
  if (isReviewerLike(agent)) return true;
  return enabledAgents.length <= 1;
}

function reviewerNeedsFollowUp(session, agent, latestResponse) {
  if (!latestResponse) return true;
  if (latestResponse.status === "unavailable" || latestResponse.status === "error") return false;
  const ledger = session.objectionLedger?.[agent.id];
  if (ledger && Object.keys(ledger).length) {
    return Object.values(ledger).some((item) => item.status !== "resolved" && item.blocks_final);
  }
  return Boolean(session.unresolvedObjections?.[agent.id]?.length);
}

function recordObjections(session, agent, response, round, groupSettings) {
  updateUnresolvedObjections(session, agent, response);
  applyObjectionLedger(session, agent, response, { round, groupSettings });
}

function selectFirstRoundAgents(enabledAgents, options = {}) {
  const startId = options.startAtAgentId || options.startAfterAgentId;
  if (!startId) return enabledAgents;
  const index = enabledAgents.findIndex((agent) => agent.id === startId);
  if (index < 0) return enabledAgents;
  return enabledAgents.slice(index + (options.startAfterAgentId ? 1 : 0));
}

function selectFinalizer(enabledAgents, session) {
  const explicitJudge = enabledAgents.find((agent) => agent.judge);
  if (explicitJudge) return explicitJudge;
  const byId = new Map(enabledAgents.map((agent) => [agent.id, agent]));
  for (const message of [...(session.messages || [])].reverse()) {
    const agent = byId.get(message.agentId);
    if (agent) return agent;
  }
  return enabledAgents[0];
}

function normalizeContinuationContext(value) {
  if (!value || typeof value !== "object") return null;
  const blockingIssues = normalizeTextList(value.blockingIssues || value.blocking_issues);
  const risks = normalizeTextList(value.risks || value.unresolved_risks);
  const nextActions = normalizeTextList(value.nextActions || value.next_actions);
  const normalized = {
    previousSessionId: String(value.previousSessionId || value.sessionId || "").trim(),
    previousQuestion: String(value.previousQuestion || value.question || "").trim(),
    finalState: String(value.finalState || value.final_state || "").trim(),
    finalAnswer: String(value.finalAnswer || value.answer || "").trim(),
    summary: String(value.summary || "").trim(),
    blockingIssues,
    risks,
    nextActions
  };
  return Object.values(normalized).some((item) => Array.isArray(item) ? item.length : Boolean(item)) ? normalized : null;
}

function normalizeTextList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      return String(item.issue || item.text || item.reason || item.id || JSON.stringify(item)).trim();
    }
    return String(item || "").trim();
  }).filter(Boolean);
}

function startAgentCallWithDeltaQueue(agent, messages, timeoutMs, signal) {
  const queue = createAsyncQueue();
  let result;
  let thrown;
  let done = false;
  const callPromise = safeCall(agent, messages, timeoutMs, signal, (delta) => queue.push(delta))
    .then((value) => {
      result = value;
    })
    .catch((error) => {
      thrown = error;
    })
    .finally(() => {
      done = true;
      queue.close();
    });
  return {
    done: () => done,
    hasDeltas: () => queue.hasItems(),
    nextDelta: () => queue.shift(),
    async result() {
      await callPromise;
      if (thrown) throw thrown;
      return result;
    }
  };
}

async function safeCall(agent, messages, timeoutMs, signal, onDelta) {
  try {
    const text = await callAgent(agent, messages, { timeoutMs, signal, onDelta });
    return { text };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { error: `agent_call_failed:${agent.id}:${error.message}` };
  }
}

function createAsyncQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        items.push(item);
      }
    },
    shift() {
      if (items.length) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()(null);
    },
    hasItems() {
      return items.length > 0;
    }
  };
}

function fallbackFinalDecision(session, consensus) {
  const redTeamObjections = Object.entries(session.unresolvedObjections)
    .flatMap(([agentId, objections]) => objections.map((objection) => `${agentId}: ${objection}`));
  return {
    answer: "The council completed, but the finalizer did not provide a valid final answer.",
    consensus_score: consensus.score,
    supporting_agents: consensus.supportingAgents,
    dissenting_agents: consensus.dissentingAgents,
    minority_report: redTeamObjections.join("; ") || "No unresolved minority report.",
    risks: redTeamObjections,
    next_actions: ["Review the session transcript."],
    memory_candidates: []
  };
}

function applyEngineFinalState(session, consensus, settings) {
  const finalState = computeFinalState(session, settings);
  session.finalDecision.consensus_score = consensus.score;
  session.finalDecision.final_state = finalState.final_state;
  session.finalDecision.blocking_issues = finalState.blocking_issues;
  session.finalDecision.unresolved_risks = finalState.unresolved_risks;
  session.finalDecision.risks = mergeRiskTexts(
    session.finalDecision.risks,
    finalState.blocking_issues,
    finalState.unresolved_risks
  );
  if (finalState.blocking_issues.length) {
    const report = finalState.blocking_issues
      .map((item) => `${item.source_agent_name || item.source_agent_id || "reviewer"}: ${item.issue}`)
      .join("; ");
    session.finalDecision.minority_report = [session.finalDecision.minority_report, report]
      .filter((text) => text && text !== "No unresolved minority report.")
      .join("; ");
  }
}

function mergeRiskTexts(existing = [], blockingIssues = [], unresolvedRisks = []) {
  const seen = new Set();
  const values = [
    ...existing,
    ...blockingIssues.map((item) => `BLOCKER ${item.id}: ${item.issue}`),
    ...unresolvedRisks.map((item) => `${item.severity || "risk"} ${item.id}: ${item.issue}`)
  ];
  return values.filter((value) => {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeContextStatus(memberContext, options = {}) {
  const size = assessSizeUsage(memberContext.tokenEstimate.total, memberContext.limits);
  const budget = summarizeBudgetStatus(memberContext, {
    ...options,
    totalTokens: memberContext.tokenEstimate.total,
    reservedOutputTokens: memberContext.limits.reservedOutputTokens
  });
  return {
    effectiveInputLimit: memberContext.limits.effectiveInputLimit,
    effectiveOutputLimit: memberContext.limits.effectiveOutputLimit,
    reservedOutputTokens: memberContext.limits.reservedOutputTokens,
    totalTokens: memberContext.tokenEstimate.total,
    nonCompressibleCoreTokens: memberContext.tokenEstimate.nonCompressibleCore,
    compressionApplied: Boolean(memberContext.compression?.applied),
    droppedRecentMessages: memberContext.compression?.droppedRecentMessages || 0,
    coreOverflow: memberContext.coreOverflow,
    sizeStatus: size.status,
    sizeRatio: size.ratio,
    budgetStatus: budget.status,
    tokenBudgetStatus: budget.tokenStatus,
    tokenBudgetRatio: budget.tokenRatio,
    costBudgetStatus: budget.costStatus,
    costBudgetRatio: budget.costRatio,
    estimatedCost: budget.projectedCost,
    accruedCost: budget.accruedCost,
    providerCacheBreakpoint: memberContext.providerCacheBreakpoint
  };
}

function summarizeBudgetStatus(memberContext, options = {}) {
  const requiredTokens = Number(options.totalTokens || 0) + Number(options.reservedOutputTokens || 0);
  const token = assessBudgetUsage(requiredTokens, memberContext.limits.tokenBudget, memberContext.limits);
  const cost = summarizeCostBudgetUsage(memberContext, options);
  return {
    status: mostSevereBudgetStatus(token.status, cost.status),
    tokenStatus: token.status,
    tokenRatio: token.ratio,
    costStatus: cost.status,
    costRatio: cost.ratio,
    projectedCost: cost.projectedCost,
    accruedCost: cost.accruedCost
  };
}

function summarizeCostBudgetUsage(memberContext, options = {}) {
  const budget = memberContext.limits.costBudget;
  if (!budget || !options.groupPath || !options.seat) return { status: "unknown", ratio: undefined };
  const pricing = options.agent?.pricing || options.agent?.providerLimits?.pricing || {};
  const projectedCost = estimateCost({
    inputTokens: options.totalTokens,
    outputTokens: options.reservedOutputTokens,
    pricing
  });
  if (projectedCost === undefined) return { status: "unknown", ratio: undefined };
  const accruedCost = estimateMemberAccruedCost(options.groupPath, options.seat, pricing);
  const total = accruedCost + projectedCost;
  const usage = assessBudgetUsage(total, budget, memberContext.limits);
  return {
    status: usage.status,
    ratio: usage.ratio,
    projectedCost,
    accruedCost
  };
}

function mostSevereBudgetStatus(...statuses) {
  const rank = { unknown: 0, normal: 1, warning: 2, confirm: 3, pause: 4 };
  return statuses.reduce((winner, status) => {
    return (rank[status] || 0) > (rank[winner] || 0) ? status : winner;
  }, "unknown");
}

function limitBlockReason(memberContext, contextStatus, options = {}) {
  return tokenBudgetBlockReason(memberContext, contextStatus)
    || costBudgetBlockReason(memberContext, contextStatus, options);
}

function tokenBudgetBlockReason(memberContext, contextStatus) {
  const budget = memberContext.limits.tokenBudget;
  if (!budget) return "";
  const required = contextStatus.totalTokens + contextStatus.reservedOutputTokens;
  if (required <= budget) return "";
  return `token_budget_exceeded:${required}/${budget}`;
}

function costBudgetBlockReason(memberContext, contextStatus, options = {}) {
  const budget = memberContext.limits.costBudget;
  if (!budget || !options.groupPath || !options.seat) return "";
  const pricing = options.agent?.pricing || options.agent?.providerLimits?.pricing || {};
  const projectedCost = estimateCost({
    inputTokens: contextStatus.totalTokens,
    outputTokens: contextStatus.reservedOutputTokens,
    pricing
  });
  if (projectedCost === undefined) return "";
  const accruedCost = estimateMemberAccruedCost(options.groupPath, options.seat, pricing);
  const total = accruedCost + projectedCost;
  if (total <= budget) return "";
  return `cost_budget_exceeded:${formatCost(total)}/${formatCost(budget)}`;
}

function findWorkspaceSeat(group, agent) {
  if (!group?.seats) return undefined;
  return group.seats.find((seat) => {
    return seat.seatId === agent.id
      || seat.displayName === agent.name
      || seat.currentModel === agent.model
      || seat.role === agent.role;
  });
}

function formatCost(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function loadSummaryContext(groupPath, agent) {
  if (!groupPath) return {};
  try {
    const group = readWorkspaceGroup(groupPath);
    const cache = readSummaryCache(groupPath, agent, group);
    return {
      memberShortSummary: cache.memberShortSummary,
      groupSharedSummary: [
        cache.groupSharedSummary,
        formatCompressedTranscriptChunks(cache.compressedTranscriptChunks)
      ].filter(Boolean).join("\n\n")
    };
  } catch {
    return {};
  }
}

function loadPrivateBossMessages(groupPath, agent) {
  const seatId = agent?.id;
  if (!groupPath || !seatId) return [];
  // Browser-only seats may not exist in group.json; use the same display-name
  // based seat payload that private-chat writes use, or the inbox path diverges.
  const seat = {
    seatId,
    id: agent.id,
    displayName: agent.name || agent.role || seatId,
    role: agent.role || ""
  };
  try {
    return readPrivateContextMessages(groupPath, seatId, { limit: 12, seat });
  } catch {
    return [];
  }
}
function readWorkspaceGroup(groupPath) {
  const filePath = path.join(groupPath, "group.json");
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatCompressedTranscriptChunks(chunks = []) {
  const summaries = chunks
    .filter((chunk) => chunk.summary)
    .slice(-3)
    .map((chunk) => `Compressed rounds ${chunk.fromRound ?? "?"}-${chunk.toRound ?? "?"}: ${chunk.summary}`);
  return summaries.join("\n");
}

function buildUnavailableMessage(agent, round, reason, contextStatus) {
  const response = {
    status: "unavailable",
    reason,
    retryable: false
  };
  return {
    round,
    agentId: agent.id,
    agentName: agent.name,
    response,
    artifacts: [],
    displayText: formatDisplayText(agent, response),
    rawText: "",
    error: reason,
    contextStatus,
    createdAt: nowIso()
  };
}

function collectMessageArtifacts(response, agent, round) {
  return (response.artifacts || []).map((artifact, index) => ({
    id: `${agent.id}-r${round}-a${index + 1}`,
    round,
    source_agent_id: agent.id,
    source_agent_name: agent.name,
    type: artifact.type || "text",
    title: artifact.title || undefined,
    content: artifact.content
  }));
}

function collectFileOperationProposals(response, agent, round, groupPath) {
  if (!groupPath) return { accepted: [], rejected: [] };
  const result = parseFileOperationProposals({
    groupRoot: groupPath,
    source: response,
    proposedBy: { seatId: agent.id, name: agent.name, role: agent.role }
  });
  return {
    accepted: result.accepted.map((proposal) => ({
      ...proposal,
      round,
      source_agent_id: agent.id,
      source_agent_name: agent.name
    })),
    rejected: result.rejected.map((rejection) => ({
      ...rejection,
      round,
      source_agent_id: agent.id,
      source_agent_name: agent.name
    }))
  };
}

function queueFileOperationProposals(fileOperationResult, groupPath) {
  if (!groupPath) return { queued: [], rejected: [] };
  return enqueueFileOperationProposals({
    groupPath,
    accepted: fileOperationResult.accepted,
    rejected: fileOperationResult.rejected
  });
}

function formatDisplayText(agent, response) {
  const content = response.status === "skip"
    ? (response.reason || "No new objection.")
    : response.status === "error" || response.status === "unavailable"
      ? (response.reason || "Agent unavailable.")
      : (response.argument || response.position || "I have an update.");
  return `${agent.name}\u8bf4\uff1a${content}`;
}

function limitMemoryCandidates(candidates) {
  const seen = new Set();
  const cleaned = [];
  for (const candidate of candidates ?? []) {
    const text = String(candidate ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
    if (cleaned.length >= 5) break;
  }
  return cleaned;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

function redactGroupForSession(group) {
  return {
    ...group,
    agents: group.agents.map((agent) => {
      const { apiKey, ...safeAgent } = agent;
      return {
        ...safeAgent,
        ...(apiKey ? { apiKeySet: true } : {})
      };
    })
  };
}
