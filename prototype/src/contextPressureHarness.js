import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextPromptSections, buildMemberContext } from "./contextBuilder.js";
import { listSessionHistoryCatalogue, searchSessionContextArchive, writeContextArchive, writeGroupSession } from "./storage.js";
import { queryPublicEvents, readPublicEventHotCache, rebuildPublicEventIndex } from "./publicEventJournal.js";

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
      runRepeatedEvidenceScenario(groupPath, fixture),
      runContinuationCacheScenario(groupPath, fixture)
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
        "Superseded-instruction conflicts are measured here; T113 owns policy changes and explicit invalidation."
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
    messages: Array.from({ length: 130 }, (_, index) => message({
      id: `history_message_${index}`,
      round: Math.floor(index / 3) + 1,
      modelCallIndex: index + 1,
      text: index === 11
        ? `${anchor} is the exact historical source that must remain retrievable after long filler.`
        : `FILLER_${index}_${seed} ${fillerText(seed + index, 720)}`
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
  const prompt = contextPrompt(context);
  const currentSource = context.contextReceipt.decisions.find((decision) => decision.source.type === "latest_boss_instruction");
  const oldSource = context.contextReceipt.decisions.find((decision) => decision.source.id === "old_rule_message");
  return measured("superseded_instruction_visibility", {
    currentInstructionPresent: prompt.includes(currentRule),
    staleInstructionPresent: prompt.includes(oldRule),
    currentSourceRecorded: currentSource?.status === "injected",
    staleSourceRecorded: oldSource?.status === "injected",
    conflictPolicyState: context.contextReceipt.policy
  }, Boolean(currentSource && oldSource));
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

function buildRealContext(session, fixture, options = {}) {
  return buildMemberContext(baseAgent(), session, {
    groupSettings: {
      recentMessageLimit: options.recentMessageLimit ?? 6,
      contextArchiveInjectionLimit: 6,
      contextArchiveInjectionTokens: 2400
    },
    latestBossInstruction: options.latestBossInstruction || "",
    continuationContext: options.continuationContext,
    retrievedContext: options.retrievedContext || [],
    historyCatalogue: fixture.historyCatalogue,
    publicEventHotCache: fixture.hotCache,
    transcriptVisibility: "full"
  });
}

function baseAgent() {
  return {
    id: "pressure_agent",
    name: "Pressure Agent",
    role: "General delivery member",
    providerLimits: { contextWindow: 18000, maxOutputTokens: 1200 },
    tokenLimits: { maxInputTokensPerCall: 15000 }
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

function message({ id, round, modelCallIndex, text }) {
  return {
    id,
    round,
    modelCallIndex,
    agentId: "writer",
    agentName: "Writer",
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
    duplicateEvidence: scenarios.find((scenario) => scenario.id === "repeated_execution_evidence")?.metrics || {}
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
