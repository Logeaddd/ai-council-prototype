import { estimateMessagesTokens, estimateTokens, hasCoreOverflow, resolveEffectiveLimits } from "./tokenLimits.js";

const DEFAULT_RECENT_MESSAGES = 6;

export function buildMemberContext(agent, session, options = {}) {
  const limits = resolveEffectiveLimits(agent, options.groupSettings || {});
  const originalQuestion = session.question || options.question || "";
  const latestBossInstruction = options.latestBossInstruction || "";
  const continuationContext = normalizeContinuationContext(options.continuationContext);
  const latestArtifacts = selectLatestArtifacts(session.artifacts || []);
  const unresolvedObjections = session.unresolvedObjections || {};
  const fileOperationExecutionResults = session.fileOperationExecutionResults || [];
  const stable = {
    roleIdentity: agent.role || agent.name,
    memberName: agent.name,
    roleInstructions: agent.instructions || agent.roleDescription || "",
    globalRequirement: options.globalRequirement || "",
    harnessSummary: options.harnessSummary || ""
  };
  const core = {
    originalQuestion,
    latestBossInstruction,
    latestArtifacts,
    unresolvedObjections,
    executionStandard: options.executionStandard || "",
    verificationStandard: options.verificationStandard || "",
    fileOperationExecutionResults
  };
  const summaries = {
    memberShortSummary: options.memberShortSummary || "",
    groupSharedSummary: options.groupSharedSummary || "",
    continuationContext,
    privateBossMessages: Array.isArray(options.privateBossMessages) ? options.privateBossMessages : []
  };
  const stableMessages = contextMessagesFromStable(stable);
  const coreMessages = contextMessagesFromCore(core);
  const summaryMessages = contextMessagesFromSummaries(summaries);
  const requestedRecentTranscript = selectRecentTranscript(session.messages || [], options.recentMessageLimit);
  const recentTranscript = fitRecentTranscriptToLimit({
    stableMessages,
    coreMessages,
    summaryMessages,
    recentTranscript: requestedRecentTranscript,
    limits
  });
  const recentMessages = recentTranscript.map((message) => ({
    role: "user",
    content: formatTranscriptMessage(message)
  }));
  const tokenEstimate = {
    stable: estimateMessagesTokens(stableMessages),
    core: estimateMessagesTokens(coreMessages),
    summaries: estimateMessagesTokens(summaryMessages),
    recentTranscript: estimateMessagesTokens(recentMessages)
  };
  const nonCompressibleCoreTokens = tokenEstimate.stable + tokenEstimate.core;

  return {
    agentId: agent.id,
    agentName: agent.name,
    mandatoryRedTeam: Boolean(agent.mandatoryRedTeam),
    limits,
    stable,
    core,
    summaries,
    recentTranscript,
    compression: {
      applied: recentTranscript.length < requestedRecentTranscript.length,
      originalRecentMessages: requestedRecentTranscript.length,
      keptRecentMessages: recentTranscript.length,
      droppedRecentMessages: requestedRecentTranscript.length - recentTranscript.length,
      targetTokens: compressionTargetTokens(limits)
    },
    tokenEstimate: {
      ...tokenEstimate,
      nonCompressibleCore: nonCompressibleCoreTokens,
      total: tokenEstimate.stable + tokenEstimate.core + tokenEstimate.summaries + tokenEstimate.recentTranscript
    },
    coreOverflow: hasCoreOverflow(nonCompressibleCoreTokens, limits),
    providerCacheBreakpoint: "after_original_question"
  };
}

export function buildContextPromptSections(context) {
  return [
    ["Stable context", [
      `Role: ${context.stable.roleIdentity}`,
      `Member: ${context.stable.memberName}`,
      context.stable.roleInstructions ? `Role instructions: ${context.stable.roleInstructions}` : "",
      context.stable.harnessSummary ? `Harness summary: ${context.stable.harnessSummary}` : "",
      context.stable.globalRequirement ? `Boss global requirement: ${context.stable.globalRequirement}` : ""
    ]],
    ["Non-compressible core", [
      `Original question: ${context.core.originalQuestion}`,
      context.core.latestBossInstruction ? `Latest boss instruction: ${context.core.latestBossInstruction}` : "",
      `Latest artifacts: ${JSON.stringify(context.core.latestArtifacts)}`,
      `Unresolved objections: ${JSON.stringify(context.core.unresolvedObjections)}`,
      context.core.executionStandard ? `Execution standard: ${context.core.executionStandard}` : "",
      context.core.verificationStandard ? `Verification standard: ${context.core.verificationStandard}` : "",
      context.core.fileOperationExecutionResults?.length ? `File operation execution results: ${JSON.stringify(context.core.fileOperationExecutionResults)}` : ""
    ]],
    ["Summaries", [
      context.summaries.memberShortSummary ? `Member summary: ${context.summaries.memberShortSummary}` : "",
      context.summaries.groupSharedSummary ? `Group summary: ${context.summaries.groupSharedSummary}` : ""
    ]],
    ["Cycle continuation", formatContinuationContext(context.summaries.continuationContext)],
    ["Private boss messages", context.summaries.privateBossMessages.map(formatPrivateBossMessage)],
    ["Recent transcript", context.recentTranscript.map(formatTranscriptMessage)]
  ].map(([title, lines]) => ({
    title,
    content: lines.filter(Boolean).join("\n")
  })).filter((section) => section.content);
}

function selectLatestArtifacts(artifacts) {
  const latestByKey = new Map();
  for (const artifact of artifacts) {
    const key = `${artifact.type || "text"}:${artifact.title || artifact.source_agent_id || artifact.id || "artifact"}`;
    const previous = latestByKey.get(key);
    if (!previous || (artifact.round || 0) >= (previous.round || 0)) {
      latestByKey.set(key, artifact);
    }
  }
  return [...latestByKey.values()];
}

function selectRecentTranscript(messages, limit = DEFAULT_RECENT_MESSAGES) {
  return messages.slice(-Math.max(0, limit || DEFAULT_RECENT_MESSAGES));
}

function fitRecentTranscriptToLimit({ stableMessages, coreMessages, summaryMessages, recentTranscript, limits }) {
  const targetTokens = compressionTargetTokens(limits);
  if (!targetTokens) return recentTranscript;
  const stableTokens = estimateMessagesTokens(stableMessages);
  const coreTokens = estimateMessagesTokens(coreMessages);
  const summaryTokens = estimateMessagesTokens(summaryMessages);
  let kept = [...recentTranscript];
  while (kept.length) {
    const recentTokens = estimateMessagesTokens(kept.map((message) => ({
      role: "user",
      content: formatTranscriptMessage(message)
    })));
    if (stableTokens + coreTokens + summaryTokens + recentTokens <= targetTokens) break;
    kept = kept.slice(1);
  }
  return kept;
}

function compressionTargetTokens(limits) {
  const inputLimit = Number(limits?.effectiveInputLimit || 0);
  const threshold = Number(limits?.compressionThreshold || 0);
  if (!inputLimit || !threshold) return 0;
  return Math.max(1, Math.floor(inputLimit * threshold));
}

function contextMessagesFromStable(stable) {
  return [
    { role: "system", content: stable.roleIdentity },
    { role: "system", content: stable.memberName },
    { role: "system", content: stable.roleInstructions },
    { role: "system", content: stable.globalRequirement },
    { role: "system", content: stable.harnessSummary }
  ].filter((message) => message.content);
}

function contextMessagesFromCore(core) {
  return [
    { role: "user", content: core.originalQuestion },
    { role: "user", content: core.latestBossInstruction },
    { role: "user", content: JSON.stringify(core.latestArtifacts) },
    { role: "user", content: JSON.stringify(core.unresolvedObjections) },
    { role: "user", content: core.executionStandard },
    { role: "user", content: core.verificationStandard },
    { role: "user", content: JSON.stringify(core.fileOperationExecutionResults || []) }
  ].filter((message) => message.content);
}

function contextMessagesFromSummaries(summaries) {
  return [
    { role: "user", content: summaries.memberShortSummary },
    { role: "user", content: summaries.groupSharedSummary },
    { role: "user", content: formatContinuationContext(summaries.continuationContext).join("\n") },
    ...summaries.privateBossMessages.map((message) => ({
      role: isFromBoss(message) ? "user" : "assistant",
      content: formatPrivateBossMessage(message)
    }))
  ].filter((message) => message.content);
}

function normalizeContinuationContext(value) {
  if (!value || typeof value !== "object") return null;
  return {
    previousSessionId: String(value.previousSessionId || value.sessionId || "").trim(),
    previousQuestion: String(value.previousQuestion || value.question || "").trim(),
    finalState: String(value.finalState || value.final_state || "").trim(),
    finalAnswer: String(value.finalAnswer || value.answer || "").trim(),
    summary: String(value.summary || "").trim(),
    blockingIssues: normalizeTextList(value.blockingIssues || value.blocking_issues),
    risks: normalizeTextList(value.risks || value.unresolved_risks),
    nextActions: normalizeTextList(value.nextActions || value.next_actions)
  };
}

function formatContinuationContext(context) {
  if (!context) return [];
  return [
    context.previousSessionId ? `Previous session: ${context.previousSessionId}` : "",
    context.previousQuestion ? `Previous question: ${context.previousQuestion}` : "",
    context.finalState ? `Previous final state: ${context.finalState}` : "",
    context.finalAnswer ? `Previous final answer: ${context.finalAnswer}` : "",
    context.summary ? `Previous compressed summary: ${context.summary}` : "",
    ...context.blockingIssues.map((item) => `Previous blocking issue: ${item}`),
    ...context.risks.map((item) => `Previous risk: ${item}`),
    ...context.nextActions.map((item) => `Previous next action: ${item}`)
  ].filter(Boolean);
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

function isFromBoss(message) {
  return !message.from || message.from === "boss";
}

function formatPrivateBossMessage(message) {
  const when = message.createdAt || "unknown time";
  if (isFromBoss(message)) {
    return `Private from boss to you at ${when}: ${message.text || ""}`;
  }
  return `Your earlier private reply to boss at ${when}: ${message.text || ""}`;
}

function formatTranscriptMessage(message) {
  const response = message.response || {};
  if (response.status === "skip") return `Round ${message.round} / ${message.agentName}: skip`;
  if (response.status === "error" || response.status === "unavailable") {
    return `Round ${message.round} / ${message.agentName}: ${response.status}: ${response.reason || ""}`;
  }
  return `Round ${message.round} / ${message.agentName}: ${response.argument || response.position || ""}`;
}
