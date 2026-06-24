import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSessionUsage,
  estimateCost,
  estimateMemberAccruedCost,
  readGroupUsage,
  readMemberUsage,
  readUsageSnapshot,
  summarizeSessionUsage
} from "../src/usageStats.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("usage stats summarize per-member calls without treating them as cache", () => {
  const usage = summarizeSessionUsage({
    id: "session_1",
    messages: [
      {
        agentId: "builder",
        agentName: "Builder",
        contextStatus: { totalTokens: 100, coreOverflow: false },
        response: { status: "speak", argument: "Implemented code.", artifacts: [{ content: "export const ok = true;" }] }
      },
      {
        agentId: "critic",
        agentName: "Critic",
        contextStatus: { totalTokens: 80, coreOverflow: true },
        response: { status: "unavailable", reason: "non_compressible_core_exceeds_input_limit" },
        error: "non_compressible_core_exceeds_input_limit"
      }
    ]
  });

  assert.equal(usage.totals.calls, 2);
  assert.equal(usage.totals.estimatedInputTokens, 180);
  assert.equal(usage.totals.unavailableCount, 1);
  assert.equal(usage.totals.coreOverflowCount, 1);
  assert.equal(usage.members.find((member) => member.agentId === "critic").lastStatus, "unavailable");
});

test("usage stats persist group and member records in workspace state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-usage-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "usage-group",
    members: [
      { seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" },
      { seatId: "critic", displayName: "Critic", model: "model-b", role: "Critic" }
    ]
  });
  const session = {
    id: "session_2",
    groupId: "usage-group",
    messages: [
      {
        agentId: "builder",
        agentName: "Builder",
        contextStatus: { totalTokens: 120 },
        response: { status: "skip", reason: "No objection." }
      },
      {
        agentId: "critic",
        agentName: "Critic",
        contextStatus: { totalTokens: 90 },
        response: { status: "speak", argument: "Risk remains.", objections: ["Risk remains."] }
      }
    ]
  };

  const record = appendSessionUsage(group.groupPath, session, group);
  const groupUsage = readGroupUsage(group.groupPath);
  const memberUsage = readMemberUsage(group.groupPath, group.seats[0]);

  assert.equal(record.sessionId, "session_2");
  assert.equal(groupUsage.length, 1);
  assert.equal(groupUsage[0].totals.estimatedInputTokens, 210);
  assert.equal(memberUsage.length, 1);
  assert.equal(memberUsage[0].agentId, "builder");
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "usage", "usage.jsonl")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "Builder", "private_memory", "usage.jsonl")));
});

test("usage snapshot exposes group and member totals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-usage-snapshot-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "usage-group",
    members: [{ seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" }]
  });
  appendSessionUsage(group.groupPath, {
    id: "session_3",
    groupId: "usage-group",
    messages: [
      {
        agentId: "builder",
        agentName: "Builder",
        contextStatus: { totalTokens: 77 },
        response: { status: "speak", argument: "Done." }
      }
    ]
  }, group);

  const snapshot = readUsageSnapshot(group.groupPath, group);

  assert.equal(snapshot.totals.calls, 1);
  assert.equal(snapshot.totals.estimatedInputTokens, 77);
  assert.equal(snapshot.members.length, 1);
  assert.equal(snapshot.members[0].seatId, "builder");
  assert.equal(snapshot.members[0].totals.calls, 1);
  assert.equal(snapshot.recent.length, 1);
});

test("usage stats estimate cost only when pricing is configured", () => {
  assert.equal(estimateCost({ inputTokens: 1000, outputTokens: 1000 }), undefined);
  assert.equal(estimateCost({
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    pricing: { inputPerMillion: 2, outputPerMillion: 4 }
  }), 4);
});

test("usage stats can estimate accrued member cost from private usage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-usage-cost-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "usage-group",
    members: [{ seatId: "builder", displayName: "Builder", model: "model-a", role: "Builder" }]
  });
  appendSessionUsage(group.groupPath, {
    id: "session_4",
    groupId: "usage-group",
    messages: [
      {
        agentId: "builder",
        agentName: "Builder",
        contextStatus: { totalTokens: 1_000_000 },
        response: { status: "skip", reason: "Done." }
      }
    ]
  }, group);

  const cost = estimateMemberAccruedCost(group.groupPath, group.seats[0], { inputPerMillion: 1, outputPerMillion: 0 });

  assert.equal(cost, 1);
});
