import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCompressedTranscriptChunk,
  appendSessionTranscriptChunk,
  ensureSummaryCache,
  readSummaryCache,
  updateDeterministicSummaries,
  writeGroupSharedSummary,
  writeMemberShortSummary
} from "../src/summaryCache.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("summary cache stores member and group summaries in workspace folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cache-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "cache-group",
    members: [{ seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" }]
  });
  ensureSummaryCache(group.groupPath, group);

  writeMemberShortSummary(group.groupPath, group.seats[0], "Builder remembers implementation details.");
  writeGroupSharedSummary(group.groupPath, "The group agreed on the current plan.");
  appendCompressedTranscriptChunk(group.groupPath, {
    sourceSessionId: "session_1",
    fromRound: 1,
    toRound: 3,
    summary: "Rounds 1-3 compressed.",
    protectedArtifacts: ["artifact-1"],
    protectedObjections: ["risk-1"]
  });

  const cache = readSummaryCache(group.groupPath, {
    id: "builder",
    name: "Builder",
    role: "Builder",
    model: "model-a"
  }, group);

  assert.equal(cache.memberShortSummary, "Builder remembers implementation details.");
  assert.equal(cache.groupSharedSummary, "The group agreed on the current plan.");
  assert.equal(cache.compressedTranscriptChunks.length, 1);
  assert.equal(cache.compressedTranscriptChunks[0].summary, "Rounds 1-3 compressed.");
  assert.deepEqual(cache.compressedTranscriptChunks[0].protectedObjections, ["risk-1"]);
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "cache", "shared-summary.md")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "Builder", "private_memory", "short-summary.md")));
});

test("summary cache reads empty values when no summaries exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cache-empty-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "cache-group",
    members: [{ seatId: "critic", displayName: "Critic", model: "model-b", role: "Critic" }]
  });

  const cache = readSummaryCache(group.groupPath, { id: "critic", name: "Critic" }, group);

  assert.equal(cache.memberShortSummary, "");
  assert.equal(cache.groupSharedSummary, "");
  assert.deepEqual(cache.compressedTranscriptChunks, []);
});

test("summary cache can create a deterministic session transcript chunk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cache-session-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "cache-group",
    members: [{ seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" }]
  });
  const chunk = appendSessionTranscriptChunk(group.groupPath, {
    id: "session_1",
    artifacts: [{ id: "artifact-1" }],
    unresolvedObjections: { critic: ["risk remains"] },
    messages: [
      { round: 1, agentName: "Builder", response: { status: "speak", argument: "Implemented a helper with a long but useful explanation." } },
      { round: 1, agentName: "Critic", response: { status: "unavailable", reason: "rate_limited" } },
      { round: 2, agentName: "Judge", response: { status: "skip", reason: "No objection." } }
    ]
  });

  const cache = readSummaryCache(group.groupPath, { id: "builder", name: "Builder" }, group);

  assert.equal(chunk.sourceSessionId, "session_1");
  assert.match(chunk.summary, /R1 Builder: Implemented a helper/);
  assert.match(chunk.summary, /R1 Critic: unavailable rate_limited/);
  assert.match(chunk.summary, /R2 Judge: skip/);
  assert.deepEqual(chunk.protectedArtifacts, ["artifact-1"]);
  assert.deepEqual(chunk.protectedObjections, ["critic: risk remains"]);
  assert.equal(cache.compressedTranscriptChunks.length, 1);
});

test("summary cache can update deterministic group and member summaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cache-update-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "cache-group",
    members: [{ seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" }]
  });
  const update = updateDeterministicSummaries(group.groupPath, {
    id: "session_2",
    question: "Build a helper.",
    unresolvedObjections: { builder: ["Add an edge case."] },
    artifacts: [{ id: "builder-r1-a1", source_agent_id: "builder", title: "helper.js", type: "code", content: "export {};" }],
    finalDecision: {
      answer: "Use the helper with tests.",
      risks: ["Missing edge case"],
      next_actions: ["Add tests"]
    },
    messages: [
      { round: 1, agentId: "builder", agentName: "Builder", response: { status: "speak", argument: "Implemented helper." } }
    ]
  }, group);
  const cache = readSummaryCache(group.groupPath, { id: "builder", name: "Builder" }, group);

  assert.match(update.groupSummary, /Final: Use the helper/);
  assert.match(cache.groupSharedSummary, /Risk: Missing edge case/);
  assert.match(cache.memberShortSummary, /Implemented helper/);
  assert.match(cache.memberShortSummary, /builder-r1-a1/);
  assert.match(cache.memberShortSummary, /Add an edge case/);
});
