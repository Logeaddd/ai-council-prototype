import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPromptSections, buildMemberContext } from "../src/contextBuilder.js";
import { formatTaskStateForPrompt, readTaskState, updateTaskStateFromSession } from "../src/taskState.js";

test("task state ledger records public final state without private chat", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-task-state-"));
  const session = {
    id: "session_task_1",
    question: "Ship the plan",
    completedAt: "2026-07-08T12:00:00.000Z",
    pendingFileOperationProposals: [
      { id: "fop_1", op: "write", path: "plan.md", status: "pending_user_approval", source_agent_name: "Builder" }
    ],
    finalDecision: {
      final_state: "usable_with_risks",
      answer: "Use option A.",
      risks: ["Needs manual review."],
      next_actions: ["Review plan.md"],
      blocking_issues: [
        { id: "b1", issue: "Missing test evidence", severity: "medium", source_agent_name: "Reviewer" }
      ],
      selected_file_operation_ids: ["fop_1"]
    }
  };

  const state = updateTaskStateFromSession(tmp, session);
  const saved = readTaskState(tmp);
  const raw = fs.readFileSync(path.join(tmp, "shared", "task_state.json"), "utf8");

  assert.equal(state.sourceSessionId, "session_task_1");
  assert.equal(saved.decisions[0].text, "Use option A.");
  assert.equal(saved.blockers[0].issue, "Missing test evidence");
  assert.equal(saved.pendingFiles[0].selected, true);
  assert.equal(saved.resolved[0].finalState, "usable_with_risks");
  assert.doesNotMatch(raw, /private/i);
});

test("task state ledger is injected as public member context", () => {
  const context = buildMemberContext(
    { id: "a", name: "A", role: "Builder" },
    { question: "Q", messages: [], artifacts: [], unresolvedObjections: {} },
    {
      question: "Q",
      taskState: {
        decisions: [{ id: "decision-1", text: "PUBLIC_LEDGER_FACT" }],
        blockers: [],
        risks: [],
        nextActions: ["Do the next step"],
        pendingFiles: [],
        resolved: []
      }
    }
  );
  const prompt = buildContextPromptSections(context).map((section) => section.content).join("\n");

  assert.match(prompt, /Task state ledger/);
  assert.match(prompt, /PUBLIC_LEDGER_FACT/);
  assert.match(formatTaskStateForPrompt(context.core.taskState), /not private chat/);
});
