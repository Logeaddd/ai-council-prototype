import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { executeToolRequests } from "../src/toolRequests.js";
import { loadPublicEvent, queryPublicEventPage, queryPublicEvents, readPublicEventCompression, readPublicEventHotCache, rebuildPublicEventIndex, tombstonePublicEvents } from "../src/publicEventJournal.js";
import { listGroupSessions, readGroupSession, readSessionContextArchive, searchSessionContextArchive, writeContextArchive, writeGroupSession } from "../src/storage.js";

test("public event journal appends typed session events without duplicating repeated saves", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-events-"));
  const session = sampleSession();
  writeGroupSession(session, groupPath);
  writeGroupSession(session, groupPath);

  session.status = "completed";
  session.completedAt = "2026-07-12T10:05:00.000Z";
  session.fileOperationExecutionResults.push({
    id: "file-1",
    round: 1,
    source_agent_id: "builder",
    source_agent_name: "Builder",
    status: "completed",
    op: "write",
    path: "src/main.js",
    createdAt: "2026-07-12T10:03:00.000Z"
  });
  session.finalDecision = { final_state: "ready_to_execute", answer: "Built and verified." };
  writeGroupSession(session, groupPath);
  writeGroupSession(session, groupPath);

  const journalPath = path.join(groupPath, "shared", "memory", "events", "public-events.jsonl");
  const events = fs.readFileSync(journalPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.length, 7);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(events.filter((event) => event.type === "user_message").length, 1);
  assert.equal(events.filter((event) => event.type === "session_status").length, 2);
  assert.equal(events.some((event) => event.type === "final_decision"), true);
  assert.equal(JSON.stringify(events).includes("PRIVATE_ONLY_VALUE"), false);
  const cache = readPublicEventHotCache(groupPath, { limit: 20 });
  assert.equal(cache.events.at(-1).type, "session_status");
  assert.equal(JSON.stringify(cache).includes("PRIVATE_ONLY_VALUE"), false);
});

test("public event index queries actor type task file commit tool status and exact source event", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-query-"));
  const session = sampleSession();
  session.status = "completed";
  session.completedAt = "2026-07-12T10:05:00.000Z";
  session.finalDecision = { final_state: "ready_to_execute", answer: "Built and verified." };
  session.fileOperationExecutionResults.push({
    id: "file-1",
    round: 1,
    source_agent_id: "builder",
    source_agent_name: "Builder",
    status: "completed",
    op: "write",
    path: "src/main.js",
    createdAt: "2026-07-12T10:03:00.000Z"
  });
  writeGroupSession(session, groupPath);

  assert.equal(queryPublicEvents(groupPath, { type: "member_message", actorId: "builder" }).length, 1);
  assert.equal(queryPublicEvents(groupPath, { type: "member_message", excludeSessionId: session.id }).length, 0);
  assert.equal(queryPublicEvents(groupPath, { task: "Build project", query: "implementation" }).length, 1);
  assert.equal(queryPublicEvents(groupPath, { file: "src/main.js", status: "completed" }).length, 1);
  const commit = queryPublicEvents(groupPath, { tool: "git_operation", commit: "abc1234" });
  assert.equal(commit.length, 1);
  assert.equal(commit[0].source, "local_public_event_journal");

  const loaded = loadPublicEvent(groupPath, commit[0].id);
  assert.equal(loaded.eventId, commit[0].id);
  assert.equal(loaded.content.payload.result.commitHash, "abc1234def5678");
  assert.match(loaded.sourcePath, /public-events\.jsonl#event=/);
});

test("public event queries expose stable offset pagination without changing the array API", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-page-"));
  const first = sampleSession();
  const second = {
    ...sampleSession(),
    id: "session_events_2",
    createdAt: "2026-07-12T11:00:00.000Z",
    startedAt: "2026-07-12T11:00:00.000Z",
    messages: [{
      ...sampleSession().messages[0],
      response: { status: "speak", argument: "The implementation is ready in the later session." },
      createdAt: "2026-07-12T11:01:00.000Z"
    }]
  };
  writeGroupSession(first, groupPath);
  writeGroupSession(second, groupPath);

  const firstPage = queryPublicEventPage(groupPath, { type: "member_message", actorId: "builder", limit: 1, offset: 0 });
  const secondPage = queryPublicEventPage(groupPath, { type: "member_message", actorId: "builder", limit: 1, offset: firstPage.pagination.nextOffset });

  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.pagination.total, 2);
  assert.equal(firstPage.pagination.hasMore, true);
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.pagination.hasMore, false);
  assert.notEqual(firstPage.events[0].id, secondPage.events[0].id);
  assert.equal(queryPublicEvents(groupPath, { type: "member_message", actorId: "builder", limit: 1 }).length, 1);
});

test("public event journal keeps interim member attempts as searchable retained events", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-interim-events-"));
  const session = sampleSession();
  session.interimMessages = [{
    id: "attempt-1",
    round: 1,
    agentId: "builder",
    agentName: "Builder",
    response: { status: "speak", argument: "I found a build risk before using the tool." },
    displayText: "I found a build risk before using the tool.",
    rawText: '{"status":"speak","argument":"I found a build risk before using the tool.","tool_requests":[{"tool":"read_file"}]}',
    interim: true,
    phase: "round",
    modelCallIndex: 1,
    createdAt: "2026-07-12T10:00:30.000Z"
  }];

  writeGroupSession(session, groupPath);
  writeGroupSession(session, groupPath);

  const attempts = queryPublicEvents(groupPath, { type: "member_interim", actorId: "builder", query: "build risk" });
  assert.equal(attempts.length, 1);
  const loaded = loadPublicEvent(groupPath, attempts[0].id);
  assert.equal(loaded.content.payload.interim, true);
  assert.match(loaded.content.payload.rawText, /tool_requests/);
});

test("public event index rebuilds from the append-only journal", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-rebuild-"));
  writeGroupSession(sampleSession(), groupPath);
  const indexPath = path.join(groupPath, "shared", "memory", "events", "public-events.index.json");
  fs.writeFileSync(indexPath, "not-json", "utf8");

  const rebuilt = rebuildPublicEventIndex(groupPath);
  assert.equal(rebuilt.invalidLines, 0);
  assert.ok(rebuilt.events.length >= 4);
  assert.equal(queryPublicEvents(groupPath, { query: "implementation" }).length, 1);
  const hotPath = path.join(groupPath, "shared", "memory", "events", "public-events.hot.json");
  fs.writeFileSync(hotPath, "stale", "utf8");
  const hot = readPublicEventHotCache(groupPath);
  assert.ok(hot.events.length >= 4);
});

test("text-only members can search and load exact retained public events", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-tool-"));
  writeGroupSession(sampleSession(), groupPath);
  const agent = { id: "reader", name: "Reader" };
  const searched = await executeToolRequests({
    requests: [{ tool: "search_context", eventType: "member_message", actorId: "builder", reason: "Find Builder's public message." }],
    permissionTier: "text",
    agent,
    round: 2,
    groupPath
  });
  const eventId = searched.results[0].result.results[0].eventId;
  assert.ok(eventId);

  const loaded = await executeToolRequests({
    requests: [{ tool: "load_context", eventId, reason: "Load the exact event." }],
    permissionTier: "text",
    agent,
    round: 2,
    groupPath
  });
  assert.equal(loaded.results[0].status, "completed");
  assert.equal(loaded.results[0].result.content.type, "member_message");
  assert.match(loaded.results[0].result.content.payload.response.argument, /implementation/);
});

test("search_context forwards offset pagination through the real tool boundary", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-tool-page-"));
  const first = sampleSession();
  const second = { ...sampleSession(), id: "session_events_page_2", createdAt: "2026-07-12T12:00:00.000Z", startedAt: "2026-07-12T12:00:00.000Z" };
  writeGroupSession(first, groupPath);
  writeGroupSession(second, groupPath);

  const pageOne = await executeToolRequests({
    requests: [{ tool: "search_context", eventType: "member_message", actorId: "builder", count: 1, offset: 0, reason: "Read page one." }],
    permissionTier: "text",
    agent: { id: "reader", name: "Reader" },
    round: 2,
    groupPath
  });
  const nextOffset = pageOne.results[0].result.pagination.publicEvents.nextOffset;
  const pageTwo = await executeToolRequests({
    requests: [{ tool: "search_context", eventType: "member_message", actorId: "builder", count: 1, offset: nextOffset, reason: "Read page two." }],
    permissionTier: "text",
    agent: { id: "reader", name: "Reader" },
    round: 2,
    groupPath
  });

  assert.equal(pageOne.results[0].result.pagination.publicEvents.total, 2);
  assert.equal(pageTwo.results[0].result.pagination.publicEvents.hasMore, false);
  assert.notEqual(pageOne.results[0].result.results[0].eventId, pageTwo.results[0].result.results[0].eventId);
});

test("derived compression keeps complete provenance and never rewrites the raw journal", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-compression-"));
  writeGroupSession(sampleSession(), groupPath);
  const journalPath = path.join(groupPath, "shared", "memory", "events", "public-events.jsonl");
  const before = sha256(journalPath);
  const compression = readPublicEventCompression(groupPath);
  const window = compression.windows.find((item) => item.sessionId === "session_events_1");
  assert.ok(window);
  assert.equal(window.sourceEventIds.length, window.eventCount);
  assert.match(window.summary, /implementation is ready/);
  for (const eventId of window.sourceEventIds) {
    assert.equal(loadPublicEvent(groupPath, eventId).eventId, eventId);
  }
  assert.equal(sha256(journalPath), before);

  const compressedPath = path.join(groupPath, "shared", "memory", "events", "public-events.compressed.json");
  fs.writeFileSync(compressedPath, "stale", "utf8");
  assert.equal(readPublicEventCompression(groupPath).windows[0].sourceEventIds.length, window.sourceEventIds.length);
});

test("session deletion tombstones hide retained history across events sessions archives caches and index rebuilds", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-event-delete-"));
  const session = sampleSession();
  session.status = "completed";
  session.completedAt = "2026-07-12T10:05:00.000Z";
  session.finalDecision = { final_state: "ready_to_execute", answer: "Verified." };
  writeGroupSession(session, groupPath);
  writeContextArchive(session, groupPath);
  const event = queryPublicEvents(groupPath, { type: "member_message", sessionId: session.id })[0];
  assert.ok(event);

  const deleted = tombstonePublicEvents(groupPath, { sessionId: session.id }, { reason: "user cleared chat history" });
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.tombstonedEvents >= 4);
  assert.equal(queryPublicEvents(groupPath, { sessionId: session.id, limit: 200 }).length, 0);
  const retainedAudit = queryPublicEvents(groupPath, { sessionId: session.id, includeDeleted: true, limit: 200 });
  assert.ok(retainedAudit.length >= 4);
  assert.equal(retainedAudit.every((item) => item.tombstoned), true);
  assert.throws(() => loadPublicEvent(groupPath, event.id), /deleted by a retained tombstone/);
  assert.equal(loadPublicEvent(groupPath, event.id, { includeDeleted: true }).eventId, event.id);
  assert.equal(listGroupSessions(groupPath).length, 0);
  assert.throws(() => readGroupSession(groupPath, session.id), /Deleted session/);
  assert.throws(() => readSessionContextArchive(groupPath, session.id), /Deleted session archive/);
  assert.equal(searchSessionContextArchive(groupPath, "implementation").length, 0);
  assert.equal(readPublicEventHotCache(groupPath).events.some((item) => item.sessionId === session.id), false);
  assert.equal(readPublicEventCompression(groupPath).windows.some((item) => item.sessionId === session.id), false);

  rebuildPublicEventIndex(groupPath);
  assert.equal(queryPublicEvents(groupPath, { sessionId: session.id }).length, 0);
  assert.equal(tombstonePublicEvents(groupPath, { sessionId: session.id }).status, "already_deleted");
});

function sampleSession() {
  return {
    id: "session_events_1",
    question: "Build project",
    privateBossMessages: ["PRIVATE_ONLY_VALUE"],
    createdAt: "2026-07-12T10:00:00.000Z",
    startedAt: "2026-07-12T10:00:00.000Z",
    status: "running",
    executionState: { active: true, taskQuestion: "Build project" },
    messages: [{
      round: 1,
      agentId: "builder",
      agentName: "Builder",
      response: { status: "speak", argument: "The implementation is ready for verification." },
      displayText: "Builder: The implementation is ready for verification.",
      createdAt: "2026-07-12T10:01:00.000Z",
      durationMs: 1000
    }],
    toolExecutionResults: [{
      id: "git-1",
      tool: "git_operation",
      round: 1,
      source_agent_id: "builder",
      source_agent_name: "Builder",
      status: "completed",
      action: "commit",
      result: { commitHash: "abc1234def5678" },
      createdAt: "2026-07-12T10:02:00.000Z"
    }],
    fileOperationProposals: [],
    fileOperationExecutionResults: [],
    rejectedToolRequests: []
  };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
