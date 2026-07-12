import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { executeToolRequests } from "../src/toolRequests.js";
import { loadPublicEvent, queryPublicEvents, readPublicEventCompression, readPublicEventHotCache, rebuildPublicEventIndex } from "../src/publicEventJournal.js";
import { writeGroupSession } from "../src/storage.js";

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
