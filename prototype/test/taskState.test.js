import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPromptSections, buildMemberContext } from "../src/contextBuilder.js";
import { formatTaskStateForPrompt, readTaskState, updateExecutionCheckpoint, updateTaskStateFromSession } from "../src/taskState.js";
import { createExecutionState } from "../src/executionState.js";

test("task state ledger records public final state without private chat", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-task-state-"));
  const session = {
    id: "session_task_1",
    question: "Ship the plan",
    completedAt: "2026-07-08T12:00:00.000Z",
    pendingFileOperationProposals: [
      { id: "fop_1", op: "write", path: "plan.md", status: "pending_user_approval", source_agent_name: "Builder" }
    ],
    contextInvalidations: [{
      source: { type: "member_message", id: "old_requirement" },
      supersededBy: { type: "session_question", id: "session_task_1" },
      reason: "user_replaced_requirement"
    }],
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
  assert.equal(saved.invalidations[0].source.id, "old_requirement");
  assert.equal(saved.invalidations[0].supersededBy.id, "session_task_1");
  assert.match(formatTaskStateForPrompt(saved), /invalidations/);
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

test("task state ledger persists a resumable execution checkpoint before finalization", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-execution-checkpoint-"));
  updateExecutionCheckpoint(tmp, {
    id: "session_running_1",
    question: "Build the project",
    executionState: {
      active: true,
      taskQuestion: "Build the project",
      executorId: "builder",
      executorName: "Builder",
      ownership: {
        ownerId: "builder",
        ownerName: "Builder",
        version: 2,
        transfers: [{ fromId: "old-builder", fromName: "Old Builder", toId: "builder", toName: "Builder", reason: "resume", version: 2 }],
        delegations: [{ id: "review:4:reviewer", type: "checkpoint_review", checkpointVersion: 4, assignedBy: "builder", assigneeId: "reviewer", assigneeName: "Reviewer", status: "pending" }]
      },
      taskContract: {
        mode: "delivery",
        objective: "Build the requested project.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["dist/project.zip"],
        completion_criteria: ["Run the project verification."],
        next_action: "Fix the compile error and rerun tests."
      },
      intakeAttempts: 1,
      phase: "repair",
      nextAction: "Fix the compile error and rerun tests.",
      checkpointVersion: 4,
      reviewedCheckpointVersion: 2,
      artifactStatus: "needs_revision",
      lastAction: "verification_failed:build",
      lastError: "cannot find symbol"
    }
  });

  const saved = readTaskState(tmp);
  assert.equal(saved.executionCheckpoint.sourceSessionId, "session_running_1");
  assert.equal(saved.executionCheckpoint.executorId, "builder");
  assert.equal(saved.executionCheckpoint.phase, "repair");
  assert.equal(saved.executionCheckpoint.ownership.version, 2);
  assert.equal(saved.executionCheckpoint.ownership.delegations[0].assigneeId, "reviewer");
  assert.equal(saved.executionCheckpoint.taskContract.mode, "delivery");
  assert.deepEqual(saved.executionCheckpoint.taskContract.deliverables, ["dist/project.zip"]);
  assert.equal(saved.executionCheckpoint.intakeAttempts, 1);
  assert.match(saved.executionCheckpoint.lastError, /cannot find symbol/);
  assert.match(formatTaskStateForPrompt(saved), /executionCheckpoint/);

  const resumed = createExecutionState({
    question: "continue",
    agents: [{ id: "builder", name: "Builder", enabled: true }],
    previousState: saved.executionCheckpoint
  });
  assert.equal(resumed.taskContract.objective, "Build the requested project.");
  assert.equal(resumed.ownership.transfers[0].fromId, "old-builder");
  assert.equal(resumed.ownership.delegations[0].assigneeId, "reviewer");
});
