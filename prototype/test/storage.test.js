import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listGroupSessions, readGroupSession, writeGroupSession } from "../src/storage.js";

test("group session history lists real saved sessions and reads details", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-history-"));
  const session = {
    id: "session_history_1",
    question: "历史记录测试",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:30.000Z",
    durationMs: 90_000,
    messages: [
      {
        round: 1,
        agentId: "a",
        agentName: "成员 A",
        response: { status: "speak", argument: "真实保存的回答" },
        createdAt: "2026-07-08T10:00:20.000Z",
        durationMs: 20_000
      }
    ],
    finalDecision: {
      final_state: "usable_with_risks",
      answer: "真实保存的结论",
      durationMs: 10_000
    }
  };

  writeGroupSession(session, tmp);

  const history = listGroupSessions(tmp);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "session_history_1");
  assert.equal(history[0].question, "历史记录测试");
  assert.equal(history[0].durationMs, 90_000);
  assert.equal(history[0].messageCount, 1);
  assert.equal(history[0].rounds, 1);
  assert.equal(history[0].finalState, "usable_with_risks");

  const detail = readGroupSession(tmp, "session_history_1");
  assert.equal(detail.finalDecision.answer, "真实保存的结论");
});

test("group session reader rejects unsafe session ids", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-history-guard-"));
  assert.throws(() => readGroupSession(tmp, "../group"), /Invalid session id/);
});
