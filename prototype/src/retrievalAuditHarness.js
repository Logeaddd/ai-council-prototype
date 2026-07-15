import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadPublicEvent, queryPublicEventPage, rebuildPublicEventIndex, tombstonePublicEvents } from "./publicEventJournal.js";
import { writeGroupSession } from "./storage.js";
import { executeToolRequests } from "./toolRequests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..");

export async function runRetrievalCoverageAudit(options = {}) {
  const seed = normalizeSeed(options.seed);
  const outputRoot = path.resolve(options.outputDir || path.join(prototypeRoot, "eval", "retrieval-audit"));
  const runDir = path.join(outputRoot, `audit-${seed}-${Date.now()}`);
  const groupPath = path.join(runDir, "group");
  const startedAt = new Date().toISOString();
  fs.mkdirSync(groupPath, { recursive: true });

  try {
    const fixture = createFixture(groupPath, seed, options.largeEventCount);
    const scenarios = [
      runContinuousChineseScenario(groupPath, fixture),
      runCombinedFiltersScenario(groupPath, fixture),
      await runToolPaginationScenario(groupPath, fixture),
      runExactLoadScenario(groupPath, fixture),
      runLargeIndexScenario(groupPath, fixture, options.maxLargeQueryMs),
      runTombstoneRebuildScenario(groupPath, fixture)
    ];
    const report = {
      schema: "ai-council.retrieval-coverage-audit.v1",
      status: scenarios.every((scenario) => scenario.status === "measured") ? "passed" : "failed",
      scope: "real_json_journal_query_and_search_context_tool_paths",
      startedAt,
      completedAt: new Date().toISOString(),
      seed,
      groupPath,
      scenarios,
      limitations: [
        "This audit measures direct lexical recall, structured filters, exact event loading, pagination and index-query latency through the real JSON journal paths.",
        "It does not claim semantic/paraphrase retrieval quality. T116 remains conditional on a measured lexical retrieval gap.",
        "The generated fixture is deterministic infrastructure coverage, not a real-provider delivery or user-acceptance result."
      ]
    };
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    return { runDir, groupPath, report };
  } catch (error) {
    const report = {
      schema: "ai-council.retrieval-coverage-audit.v1",
      status: "infrastructure_error",
      scope: "real_json_journal_query_and_search_context_tool_paths",
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

function createFixture(groupPath, seed, requestedLargeEventCount) {
  const targetSession = session({
    id: `retrieval_target_${seed}`,
    question: "T115 检索审计任务：验证中文连续检索与组合筛选。",
    createdAt: "2026-07-15T00:00:00.000Z",
    messages: [message(`中文连续检索锚点：必须找到这条公开成员记录。T115CONTINUOUSANCHOR_${seed}`, 1)],
    tools: [{
      id: "audit_filter_tool",
      tool: "git_operation",
      status: "completed",
      source_agent_id: "builder",
      source_agent_name: "Builder",
      reason: "组合筛选锚点",
      path: "src/检索器.js",
      result: { commitHash: "a11d00dbeef1234" },
      createdAt: "2026-07-15T00:00:20.000Z"
    }]
  });
  writeGroupSession(targetSession, groupPath);

  const pageSessionIds = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `retrieval_page_${seed}_${index}`;
    pageSessionIds.push(id);
    writeGroupSession(session({
      id,
      question: `Pagination fixture ${index}.`,
      createdAt: `2026-07-15T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
      messages: [message(`T115_PAGE_ANCHOR_${seed} item ${index}.`, 1)]
    }), groupPath);
  }

  const largeEventCount = clampPositiveInteger(requestedLargeEventCount, 900, 200, 2400);
  const largeSession = session({
    id: `retrieval_large_${seed}`,
    question: "Large public event index audit fixture.",
    createdAt: "2026-07-15T02:00:00.000Z",
    messages: Array.from({ length: largeEventCount }, (_, index) => message(
      index === Math.floor(largeEventCount / 2)
        ? `T115_PERFORMANCE_ANCHOR_${seed} is retained in the middle of the real index.`
        : `T115 filler ${index} ${fillerText(seed + index, 180)}`,
      index + 1,
      `2026-07-15T02:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`
    ))
  });
  writeGroupSession(largeSession, groupPath);
  const targetEvent = queryPublicEventPage(groupPath, {
    type: "tool_result",
    query: "组合筛选锚点",
    limit: 1
  }).events[0];
  if (!targetEvent) throw new Error("Retrieval audit fixture could not locate its target event.");
  return { seed, targetSession, targetEvent, pageSessionIds, largeEventCount };
}

function runContinuousChineseScenario(groupPath, fixture) {
  const chinesePage = queryPublicEventPage(groupPath, {
    type: "member_message",
    actorId: "builder",
    query: "中文连续检索锚点",
    limit: 5
  });
  const continuousPage = queryPublicEventPage(groupPath, {
    type: "member_message",
    actorId: "builder",
    query: `T115CONTINUOUSANCHOR_${fixture.seed}`,
    limit: 5
  });
  const chineseFound = chinesePage.events.some((event) => event.sessionId === fixture.targetSession.id);
  const continuousFound = continuousPage.events.some((event) => event.sessionId === fixture.targetSession.id);
  return measured("continuous_chinese_lexical_recall", {
    chineseResultCount: chinesePage.events.length,
    continuousResultCount: continuousPage.events.length,
    exactTargetFound: chineseFound && continuousFound,
    sourceEventIds: [...new Set([...chinesePage.events, ...continuousPage.events].map((event) => event.id))]
  }, chineseFound && continuousFound);
}

function runCombinedFiltersScenario(groupPath, fixture) {
  const page = queryPublicEventPage(groupPath, {
    query: "组合筛选锚点",
    eventType: "tool_result",
    actorId: "builder",
    taskId: "T115 检索审计任务",
    file: "src/检索器.js",
    commit: "a11d00d",
    tool: "git_operation",
    status: "completed",
    from: "2026-07-15T00:00:10.000Z",
    to: "2026-07-15T00:00:30.000Z",
    limit: 5
  });
  const exact = page.events.length === 1 && page.events[0].id === fixture.targetEvent.id;
  return measured("combined_structured_filters", {
    resultCount: page.events.length,
    expectedEventId: fixture.targetEvent.id,
    returnedEventIds: page.events.map((event) => event.id)
  }, exact);
}

async function runToolPaginationScenario(groupPath, fixture) {
  const first = await executeToolRequests({
    permissionTier: "text",
    groupPath,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [{
      tool: "search_context",
      query: `T115_PAGE_ANCHOR_${fixture.targetSession.id.split("_").at(-1)}`,
      eventType: "member_message",
      actorId: "builder",
      count: 3,
      offset: 0,
      reason: "Read the first public-history page."
    }]
  });
  const firstResult = first.results[0]?.result || {};
  const nextOffset = firstResult.pagination?.publicEvents?.nextOffset;
  const second = await executeToolRequests({
    permissionTier: "text",
    groupPath,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [{
      tool: "search_context",
      query: `T115_PAGE_ANCHOR_${fixture.targetSession.id.split("_").at(-1)}`,
      eventType: "member_message",
      actorId: "builder",
      count: 3,
      offset: nextOffset,
      reason: "Read the next public-history page."
    }]
  });
  const secondResult = second.results[0]?.result || {};
  const firstIds = firstResult.results?.map((item) => item.eventId) || [];
  const secondIds = secondResult.results?.map((item) => item.eventId) || [];
  const overlap = firstIds.filter((id) => secondIds.includes(id));
  const total = Number(firstResult.pagination?.publicEvents?.total || 0);
  return measured("search_context_pagination", {
    total,
    firstIds,
    secondIds,
    nextOffset,
    overlap
  }, total === fixture.pageSessionIds.length && firstIds.length === 3 && secondIds.length === 3 && overlap.length === 0);
}

function runExactLoadScenario(groupPath, fixture) {
  const loaded = loadPublicEvent(groupPath, fixture.targetEvent.id);
  const exact = loaded.eventId === fixture.targetEvent.id
    && loaded.content?.payload?.result?.commitHash === "a11d00dbeef1234";
  return measured("exact_event_load", {
    requestedEventId: fixture.targetEvent.id,
    loadedEventId: loaded.eventId,
    sourcePath: loaded.sourcePath
  }, exact);
}

function runLargeIndexScenario(groupPath, fixture, configuredMaxMs) {
  const maxQueryMs = clampPositiveInteger(configuredMaxMs, 1500, 100, 10000);
  const started = performance.now();
  const page = queryPublicEventPage(groupPath, {
    query: `T115_PERFORMANCE_ANCHOR_${fixture.targetSession.id.split("_").at(-1)}`,
    type: "member_message",
    limit: 5
  });
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
  const found = page.events.some((event) => event.sessionId.startsWith("retrieval_large_"));
  return measured("large_json_index_exact_recall_and_latency", {
    indexedFixtureMessages: fixture.largeEventCount,
    resultCount: page.events.length,
    exactTargetFound: found,
    elapsedMs,
    maxQueryMs
  }, found && elapsedMs <= maxQueryMs);
}

function runTombstoneRebuildScenario(groupPath, fixture) {
  const deleted = tombstonePublicEvents(groupPath, { sessionId: fixture.targetSession.id }, { reason: "retrieval audit deletion check" });
  rebuildPublicEventIndex(groupPath);
  const active = queryPublicEventPage(groupPath, { sessionId: fixture.targetSession.id, limit: 50 });
  const retainedAudit = queryPublicEventPage(groupPath, { sessionId: fixture.targetSession.id, includeDeleted: true, limit: 50 });
  return measured("tombstone_survives_index_rebuild", {
    tombstonedEvents: deleted.tombstonedEvents,
    activeResultCount: active.events.length,
    retainedAuditCount: retainedAudit.events.length,
    retainedAuditAllTombstoned: retainedAudit.events.every((event) => event.tombstoned)
  }, deleted.status === "deleted" && active.events.length === 0 && retainedAudit.events.length > 0 && retainedAudit.events.every((event) => event.tombstoned));
}

function session({ id, question, createdAt, messages = [], tools = [] }) {
  return {
    id,
    question,
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    status: "completed",
    executionState: { taskId: id, taskQuestion: question },
    messages,
    interimMessages: [],
    toolExecutionResults: tools,
    fileOperationProposals: [],
    fileOperationExecutionResults: [],
    rejectedToolRequests: [],
    finalDecision: { final_state: "usable_with_risks", answer: "Retrieval audit fixture." }
  };
}

function message(text, round, createdAt = "2026-07-15T00:00:10.000Z") {
  return {
    id: `message_${round}`,
    round,
    agentId: "builder",
    agentName: "Builder",
    createdAt,
    response: { status: "speak", argument: text }
  };
}

function measured(id, metrics, valid) {
  return { id, status: valid ? "measured" : "failed", metrics };
}

function clampPositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeSeed(value) {
  const number = Number.parseInt(String(value ?? 20260715), 10);
  return Number.isFinite(number) ? Math.abs(number) : 20260715;
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
