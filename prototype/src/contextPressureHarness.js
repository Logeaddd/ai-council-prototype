import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextPromptSections, buildMemberContext } from "./contextBuilder.js";
import { listSessionHistoryCatalogue, searchSessionContextArchive, writeContextArchive, writeGroupSession } from "./storage.js";
import { queryPublicEvents, readPublicEventHotCache, rebuildPublicEventIndex } from "./publicEventJournal.js";
import { readTaskState, updateTaskStateFromSession } from "./taskState.js";
import { appendSessionTranscriptChunk, readSummaryCache, updateDeterministicSummaries } from "./summaryCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..");

export function runContextPressureBaseline(options = {}) {
  const seed = normalizeSeed(options.seed);
  const outputRoot = path.resolve(options.outputDir || path.join(prototypeRoot, "eval", "context-pressure"));
  const runDir = path.join(outputRoot, `baseline-${seed}-${Date.now()}`);
  const groupPath = path.join(runDir, "group");
  const startedAt = new Date().toISOString();
  fs.mkdirSync(groupPath, { recursive: true });

  try {
    const fixture = createRetainedHistoryFixture(groupPath, seed);
    const scenarios = [
      runBuriedSourceScenario(groupPath, fixture),
      runSupersededInstructionScenario(groupPath, fixture),
      runPersistedInvalidationScenario(groupPath, fixture),
      runRepeatedEvidenceScenario(groupPath, fixture),
      runLongActiveSessionWorkingSetScenario(groupPath, fixture),
      runContinuationCacheScenario(groupPath, fixture),
      runMultiMemberResumeScenario(groupPath, fixture)
    ];
    const report = {
      schema: "ai-council.context-pressure-baseline.v1",
      status: scenarios.every((scenario) => scenario.status === "measured") ? "passed" : "failed",
      scope: "deterministic_context_pipeline_only",
      startedAt,
      completedAt: new Date().toISOString(),
      seed,
      groupPath,
      scenarios,
      aggregate: aggregateScenarios(scenarios),
      limitations: [
        "This baseline calls the real retained-session, public-journal, index-rebuild, hot-cache, archive-search and buildMemberContext paths.",
        "It does not score model understanding or delivery quality. Those remain T117 real-provider acceptance concerns.",
        "The active working set is derived from the live session on every build; it is bounded context selection, not a second memory store.",
        "It does not score model understanding or whether a Provider chooses to retrieve a source that remains omitted. Those remain real-provider acceptance concerns."
      ]
    };
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    return { runDir, groupPath, report };
  } catch (error) {
    const report = {
      schema: "ai-council.context-pressure-baseline.v1",
      status: "infrastructure_error",
      scope: "deterministic_context_pipeline_only",
      startedAt,
      completedAt: new Date().toISOString(),
      seed,
      groupPath,
      error: String(error?.stack || error?.message || error).slice(0, 4000)
    };
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    return { runDir, groupPath, report };
  }
}

function createRetainedHistoryFixture(groupPath, seed) {
  const anchor = `T112_EXACT_ANCHOR_${seed}`;
  const historySession = completeSession({
    id: `history_${seed}`,
    question: `Historical project context containing ${anchor}.`,
    messages: Array.from({ length: 160 }, (_, index) => message({
      id: `history_message_${index}`,
      round: Math.floor(index / 3) + 1,
      modelCallIndex: index + 1,
      text: index === 11
        ? `${anchor} is the exact historical source that must remain retrievable after long filler.`
        : `FILLER_${index}_${seed} ${fillerText(seed + index, 900)}`
    }))
  });
  writeGroupSession(historySession, groupPath);
  writeContextArchive(historySession, groupPath);

  const indexPath = path.join(groupPath, "shared", "memory", "events", "public-events.index.json");
  fs.rmSync(indexPath, { force: true });
  const rebuiltIndex = rebuildPublicEventIndex(groupPath);
  const journalHits = queryPublicEvents(groupPath, { query: anchor, limit: 5 });
  const archiveHits = searchSessionContextArchive(groupPath, anchor, { limit: 5 });
  const hotCache = readPublicEventHotCache(groupPath, { limit: 40 });
  if (!journalHits.length) throw new Error(`Context pressure fixture could not retrieve ${anchor} from the rebuilt public index.`);

  return {
    anchor,
    historySession,
    rebuiltIndex,
    retainedCharacters: historySession.messages.reduce((total, item) => total + String(item?.response?.argument || "").length, 0),
    journalHits,
    archiveHits,
    hotCache,
    retrievedContext: journalHits.map(publicHitToRetrievedContext),
    historyCatalogue: listSessionHistoryCatalogue(groupPath, { limit: 12 })
  };
}

function runBuriedSourceScenario(groupPath, fixture) {
  const session = activeSession("buried_source", "Continue the retained project without losing the exact earlier requirement.");
  const context = buildRealContext(session, fixture, {
    retrievedContext: fixture.retrievedContext,
    recentMessageLimit: 3
  });
  const target = fixture.journalHits[0];
  const injected = context.contextReceipt.decisions.some((decision) => (
    decision.status === "injected"
      && decision.source.eventId === target.id
      && decision.section === "relevant_archived_context"
  ));
  return measured("buried_exact_source", {
    retainedHistoryMessages: fixture.historySession.messages.length,
    rebuiltIndexEvents: fixture.rebuiltIndex.events.length,
    archiveSearchHits: fixture.archiveHits.length,
    journalSearchHits: fixture.journalHits.length,
    retainedCharacters: fixture.retainedCharacters,
    exactEventId: target.id,
    exactSourceInjected: injected,
    receiptTokens: context.contextReceipt.budget.estimatedContextTokens,
    promptContainsAnchor: contextPrompt(context).includes(fixture.anchor)
  }, injected);
}

function runSupersededInstructionScenario(groupPath, fixture) {
  const oldRule = "T112_OLD_RULE_RENDER_RED";
  const currentRule = "T112_CURRENT_RULE_RENDER_TEAL";
  const session = activeSession("superseded_instruction", `Earlier request said ${oldRule}.`, [
    message({ id: "old_rule_message", round: 1, modelCallIndex: 1, text: `The team retained ${oldRule}.` }),
    message({ id: "current_discussion", round: 2, modelCallIndex: 2, text: "Waiting for the user’s current instruction." })
  ]);
  const context = buildRealContext(session, fixture, {
    latestBossInstruction: `The current instruction supersedes the old request: ${currentRule}.`,
    recentMessageLimit: 6
  });
  const initialPrompt = contextPrompt(context);
  const oldSource = context.invalidationSourceRefs.find((source) => source.type === "member_message" && source.id === "old_rule_message");
  const replacement = buildRealContext(session, fixture, {
    latestBossInstruction: `The current instruction supersedes the old request: ${currentRule}.`,
    recentMessageLimit: 6,
    contextInvalidations: oldSource ? [{
      source: { type: oldSource.type, id: oldSource.id },
      supersededBy: { type: "session_question", id: session.id },
      reason: "current_user_instruction_replaces_retained_rule"
    }] : []
  });
  const prompt = contextPrompt(replacement);
  const currentSource = replacement.contextReceipt.decisions.find((decision) => decision.source.type === "latest_boss_instruction");
  const replacementOldSource = replacement.contextReceipt.policy.invalidatedSources.find((item) => item.source.id === "old_rule_message");
  return measured("superseded_instruction_visibility", {
    currentInstructionPresent: prompt.includes(currentRule),
    staleInstructionPresent: prompt.includes(oldRule),
    staleInstructionInitiallyPresent: initialPrompt.includes(oldRule),
    sourceReferenceOffered: Boolean(oldSource),
    currentSourceRecorded: currentSource?.status === "injected",
    staleSourceRecorded: replacementOldSource?.status === "invalidated",
    conflictPolicyState: replacement.contextReceipt.policy
  }, Boolean(currentSource && oldSource)
    && initialPrompt.includes(oldRule)
    && !prompt.includes(oldRule)
    && replacementOldSource?.status === "invalidated");
}

function runRepeatedEvidenceScenario(groupPath, fixture) {
  const repeated = Array.from({ length: 96 }, (_, index) => ({
    id: `tool_repeat_${index}`,
    tool: "execute_command",
    command: "node verify.js",
    source_agent_id: "writer",
    round: index + 1,
    status: index === 95 ? "completed" : "failed",
    result: { stdout: `attempt ${index} ${fillerText(index, 180)}` }
  }));
  const session = activeSession("repeated_evidence", "Use the latest real build evidence, not the repeated old attempts.");
  session.toolExecutionResults = repeated;
  const context = buildRealContext(session, fixture, { recentMessageLimit: 2 });
  const decisions = context.contextReceipt.decisions.filter((item) => item.source.type === "tool_result");
  const deduplicated = decisions.filter((item) => item.status === "deduplicated").length;
  const injected = decisions.filter((item) => item.status === "injected" || item.status === "shortened").length;
  return measured("repeated_execution_evidence", {
    storedResults: repeated.length,
    deduplicated,
    injected,
    latestEvidenceVisible: injected > 0,
    compression: context.executionEvidenceCompression,
    receiptTokens: context.contextReceipt.budget.estimatedContextTokens
  }, deduplicated === repeated.length - 1 && injected <= 1);
}

function runLongActiveSessionWorkingSetScenario(groupPath, fixture) {
  const architectureMarker = `T113_ACTIVE_ARCHITECTURE_${fixture.anchor}`;
  const handoffMarker = `T113_ACTIVE_HANDOFF_${fixture.anchor}`;
  const messages = [
    message({
      id: "active_architecture_decision",
      round: 1,
      modelCallIndex: 1,
      agentId: "architect",
      agentName: "Architect",
      text: `Architecture decision: ${architectureMarker}.`
    }),
    {
      ...message({
        id: "active_delivery_handoff",
        round: 2,
        modelCallIndex: 2,
        agentId: "delivery_owner",
        agentName: "Delivery Owner",
        text: `Delivery handoff: ${handoffMarker}.`
      }),
      response: {
        status: "speak",
        argument: `Delivery handoff: ${handoffMarker}.`,
        task_contract: { mode: "delivery", objective: "Preserve cross-member continuity.", next_action: "Continue the verified task." },
        delegation_handoff: { delegation_id: "active_handoff", summary: handoffMarker }
      }
    },
    ...Array.from({ length: 22 }, (_, index) => ({
      ...message({
        id: `active_progress_${index}`,
        round: index + 3,
        modelCallIndex: index + 3,
        agentId: index % 2 ? "reviewer" : "delivery_owner",
        agentName: index % 2 ? "Reviewer" : "Delivery Owner",
        text: `Transient tool progress ${index}.`
      }),
      interim: true
    }))
  ];
  const session = activeSession("long_active_session", "Continue the active task with its recorded ownership.", messages);
  const context = buildRealContext(session, fixture, {
    recentMessageLimit: 6,
    activeWorkingMemoryTokens: 1200
  });
  const prompt = contextPrompt(context);
  const workingSection = context.contextReceipt.sections.find((section) => section.id === "active_working_memory");
  const workingDecisions = context.contextReceipt.decisions.filter((item) => item.section === "active_working_memory");
  const recentIds = new Set(context.recentTranscript.map((item) => item.id));
  return measured("long_active_session_working_set", {
    activeSessionMessages: messages.length,
    rawRecentMessages: context.recentTranscript.length,
    architectureWasOutsideRecentWindow: !recentIds.has("active_architecture_decision"),
    handoffWasOutsideRecentWindow: !recentIds.has("active_delivery_handoff"),
    architectureVisible: prompt.includes(architectureMarker),
    handoffVisible: prompt.includes(handoffMarker),
    activeWorkingSources: workingSection?.sources.map((source) => source.id) || [],
    activeWorkingDecisions: {
      injected: workingDecisions.filter((item) => item.status === "injected").length,
      omitted: workingDecisions.filter((item) => item.status === "retrieved_but_omitted").length
    },
    receiptTokens: context.contextReceipt.budget.estimatedContextTokens
  }, !recentIds.has("active_architecture_decision")
    && !recentIds.has("active_delivery_handoff")
    && prompt.includes(architectureMarker)
    && prompt.includes(handoffMarker)
    && workingSection?.sources.some((source) => source.id === "active_architecture_decision")
    && workingSection?.sources.some((source) => source.id === "active_delivery_handoff"));
}

function runPersistedInvalidationScenario(groupPath, fixture) {
  const oldRule = "T113_OLD_PERSISTED_RULE";
  const currentRule = "T113_CURRENT_PERSISTED_RULE";
  const source = { type: "member_message", id: "persisted_old_rule" };
  const supersededBy = { type: "latest_boss_instruction", id: "persisted_invalidation:latest" };
  const savedSession = completeSession({
    id: "persisted_invalidation",
    question: "Record the replacement relationship.",
    messages: [message({ id: source.id, round: 1, modelCallIndex: 1, text: oldRule })]
  });
  savedSession.finalDecision.answer = `The prior retained summary requires ${oldRule}.`;
  savedSession.contextInvalidations = [{ source, supersededBy, reason: "user_replaced_persisted_rule" }];
  updateTaskStateFromSession(groupPath, savedSession);
  appendSessionTranscriptChunk(groupPath, savedSession);
  updateDeterministicSummaries(groupPath, savedSession, { seats: [] });
  const summaryCache = readSummaryCache(groupPath, baseAgent(), { seats: [] });
  const persisted = readTaskState(groupPath);
  const active = activeSession("reopened_invalidation", "Apply the current persisted requirement.", [
    message({ id: source.id, round: 1, modelCallIndex: 1, text: oldRule })
  ]);
  const context = buildRealContext(active, fixture, {
    latestBossInstruction: currentRule,
    contextInvalidations: persisted.invalidations,
    groupSharedSummary: summaryCache.groupSharedSummary,
    groupSharedSummaryRecord: summaryCache.groupSharedSummaryRecord,
    compressedTranscriptChunks: summaryCache.compressedTranscriptChunks,
    recentMessageLimit: 4
  });
  const prompt = contextPrompt(context);
  const invalidated = context.contextReceipt.policy.invalidatedSources;
  return measured("persisted_invalidation_reopen", {
    taskStateInvalidations: persisted.invalidations.length,
    persistedGroupSummaryContainsOldRule: summaryCache.groupSharedSummary.includes(oldRule),
    persistedChunkContainsOldRule: summaryCache.compressedTranscriptChunks.some((chunk) => chunk.summary.includes(oldRule)),
    oldSourceExcluded: !prompt.includes(oldRule),
    currentInstructionPresent: prompt.includes(currentRule),
    receiptInvalidation: invalidated[0] || null
  }, persisted.invalidations.length === 1
    && summaryCache.groupSharedSummary.includes(oldRule)
    && summaryCache.compressedTranscriptChunks.some((chunk) => chunk.summary.includes(oldRule))
    && !prompt.includes(oldRule)
    && prompt.includes(currentRule)
    && invalidated.length >= 3);
}

function runContinuationCacheScenario(groupPath, fixture) {
  const session = activeSession("continuation_cache", "continue", [
    message({ id: "resume_message", round: 1, modelCallIndex: 1, text: "Resume from the saved group work." })
  ]);
  const context = buildRealContext(session, fixture, {
    continuationContext: {
      previousSessionId: fixture.historySession.id,
      previousQuestion: fixture.historySession.question,
      sourcePath: `sessions/${fixture.historySession.id}.json`,
      summary: "Saved history is available."
    },
    recentMessageLimit: 2
  });
  const continuation = context.contextReceipt.decisions.some((item) => item.source.type === "continuation" && item.source.sessionId === fixture.historySession.id);
  const cache = context.contextReceipt.sections.find((section) => section.id === "recent_public_activity_cache");
  return measured("continuation_after_cache_rebuild", {
    continuationSourceInjected: continuation,
    hotCacheEvents: fixture.hotCache.events.length,
    hotCacheSourceCount: cache?.sourceCount || 0,
    cacheHasHistoricalSession: fixture.hotCache.events.some((event) => event.sessionId === fixture.historySession.id)
  }, continuation && Boolean(cache?.sourceCount));
}

function runMultiMemberResumeScenario(groupPath, fixture) {
  const architectureMarker = `T115_ARCHITECTURE_MARKER_${fixture.anchor}`;
  const ownershipMarker = `T115_DELIVERY_OWNER_MARKER_${fixture.anchor}`;
  const reviewMarker = `T115_REVIEW_MARKER_${fixture.anchor}`;
  const session = activeSession("multi_member_resume", "continue", [
    message({
      id: "architect_public_record",
      round: 1,
      modelCallIndex: 1,
      agentId: "architect",
      agentName: "Architect",
      text: `Architecture decision: ${architectureMarker}.`
    }),
    message({
      id: "delivery_owner_public_record",
      round: 2,
      modelCallIndex: 2,
      agentId: "delivery_owner",
      agentName: "Delivery Owner",
      text: `Execution checkpoint: ${ownershipMarker}.`
    }),
    message({
      id: "reviewer_public_record",
      round: 3,
      modelCallIndex: 3,
      agentId: "reviewer",
      agentName: "Reviewer",
      text: `Review checkpoint: ${reviewMarker}.`
    })
  ]);
  const members = [
    { id: "architect", name: "Architect", role: "Architecture" },
    { id: "delivery_owner", name: "Delivery Owner", role: "Delivery owner" },
    { id: "reviewer", name: "Reviewer", role: "Reviewer", isReviewer: true }
  ];
  const contexts = members.map((member) => buildRealContext(session, fixture, {
    agent: member,
    continuationContext: {
      previousSessionId: fixture.historySession.id,
      previousQuestion: fixture.historySession.question,
      sourcePath: `sessions/${fixture.historySession.id}.json`,
      summary: `Resume ${architectureMarker}, ${ownershipMarker}, and ${reviewMarker}.`
    },
    recentMessageLimit: 6
  }));
  const memberMetrics = contexts.map((context, index) => {
    const prompt = contextPrompt(context);
    return {
      memberId: members[index].id,
      seesArchitecture: prompt.includes(architectureMarker),
      seesOwnerCheckpoint: prompt.includes(ownershipMarker),
      seesReviewCheckpoint: prompt.includes(reviewMarker),
      continuationInjected: context.contextReceipt.decisions.some((item) => item.source.type === "continuation" && item.source.sessionId === fixture.historySession.id),
      receipt: receiptMetrics(context.contextReceipt)
    };
  });
  const valid = memberMetrics.every((item) => (
    item.seesArchitecture
      && item.seesOwnerCheckpoint
      && item.seesReviewCheckpoint
      && item.continuationInjected
      && item.receipt.injectedSources > 0
  ));
  return measured("multi_member_visibility_and_resume", {
    members: memberMetrics,
    retainedHistorySessionId: fixture.historySession.id,
    publicMarkers: [architectureMarker, ownershipMarker, reviewMarker]
  }, valid);
}

function buildRealContext(session, fixture, options = {}) {
  return buildMemberContext(baseAgent(options.agent), session, {
    groupSettings: {
      recentMessageLimit: options.recentMessageLimit ?? 6,
      contextArchiveInjectionLimit: 6,
      contextArchiveInjectionTokens: 2400
    },
    latestBossInstruction: options.latestBossInstruction || "",
    continuationContext: options.continuationContext,
    contextInvalidations: options.contextInvalidations,
    memberShortSummary: options.memberShortSummary,
    memberShortSummaryRecord: options.memberShortSummaryRecord,
    groupSharedSummary: options.groupSharedSummary,
    groupSharedSummaryRecord: options.groupSharedSummaryRecord,
    compressedTranscriptChunks: options.compressedTranscriptChunks,
    publicMemorySummary: options.publicMemorySummary,
    retrievedContext: options.retrievedContext || [],
    historyCatalogue: fixture.historyCatalogue,
    publicEventHotCache: fixture.hotCache,
    transcriptVisibility: "full"
  });
}

function baseAgent(overrides = {}) {
  return {
    id: "pressure_agent",
    name: "Pressure Agent",
    role: "General delivery member",
    providerLimits: { contextWindow: 18000, maxOutputTokens: 1200 },
    tokenLimits: { maxInputTokensPerCall: 15000 },
    ...overrides
  };
}

function activeSession(id, question, messages = []) {
  return {
    id,
    question,
    createdAt: "2026-07-14T00:00:00.000Z",
    messages,
    interimMessages: [],
    artifacts: [],
    unresolvedObjections: {},
    fileOperationExecutionResults: [],
    toolExecutionResults: [],
    rejectedToolRequests: []
  };
}

function completeSession({ id, question, messages }) {
  return {
    ...activeSession(id, question, messages),
    status: "completed",
    completedAt: "2026-07-14T01:00:00.000Z",
    finalDecision: { final_state: "usable_with_risks", answer: "Retained context fixture." },
    executionState: { taskId: id, taskQuestion: question }
  };
}

function message({ id, round, modelCallIndex, text, agentId = "writer", agentName = "Writer" }) {
  return {
    id,
    round,
    modelCallIndex,
    agentId,
    agentName,
    createdAt: `2026-07-14T00:${String(Math.floor(modelCallIndex / 60)).padStart(2, "0")}:${String(modelCallIndex % 60).padStart(2, "0")}.000Z`,
    response: { status: "speak", argument: text }
  };
}

function publicHitToRetrievedContext(hit = {}) {
  return {
    source: hit.source,
    sourceType: hit.type,
    eventId: hit.id,
    sessionId: hit.sessionId,
    round: hit.round,
    snippet: hit.text,
    sourcePath: hit.sourcePath,
    score: hit.score,
    createdAt: hit.occurredAt
  };
}

function contextPrompt(context) {
  return buildContextPromptSections(context).map((section) => section.content).join("\n");
}

function measured(id, metrics, valid) {
  return {
    id,
    status: valid ? "measured" : "failed",
    metrics
  };
}

function aggregateScenarios(scenarios) {
  return {
    measured: scenarios.filter((scenario) => scenario.status === "measured").length,
    failed: scenarios.filter((scenario) => scenario.status !== "measured").map((scenario) => scenario.id),
    staleInstructionVisibility: scenarios.find((scenario) => scenario.id === "superseded_instruction_visibility")?.metrics || {},
    duplicateEvidence: scenarios.find((scenario) => scenario.id === "repeated_execution_evidence")?.metrics || {},
    activeWorkingMemory: scenarios.find((scenario) => scenario.id === "long_active_session_working_set")?.metrics || {},
    multiMemberResume: scenarios.find((scenario) => scenario.id === "multi_member_visibility_and_resume")?.metrics || {}
  };
}

function receiptMetrics(receipt = {}) {
  const decisions = Array.isArray(receipt.decisions) ? receipt.decisions : [];
  const policy = receipt.policy || {};
  return {
    injectedSources: decisions.filter((item) => item.status === "injected" || item.status === "shortened").length,
    omittedSources: decisions.filter((item) => item.status === "omitted" || item.status === "deduplicated" || item.status === "invalidated").length,
    invalidatedSources: Array.isArray(policy.invalidatedSources) ? policy.invalidatedSources.length : 0,
    estimatedContextTokens: Number(receipt.budget?.estimatedContextTokens || 0)
  };
}

function fillerText(seed, length) {
  let state = (seed >>> 0) || 1;
  const words = [];
  while (words.join(" ").length < length) {
    state = (state * 1664525 + 1013904223) >>> 0;
    words.push(`w${state.toString(36)}`);
  }
  return words.join(" ").slice(0, length);
}

function normalizeSeed(value) {
  const number = Number.parseInt(String(value ?? 20260714), 10);
  return Number.isFinite(number) ? Math.abs(number) : 20260714;
}
