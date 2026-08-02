import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTaskRun,
  listTaskRuns,
  readTaskRun,
  recordTaskRunArtifactVerification,
  recordTaskRunFileEvidence,
  recordTaskRunToolAttempts,
  readTaskRunEvents,
  syncTaskRunFromSession
} from "../src/taskRuntime.js";
import { advanceExecutionState, selectExecutionAgents } from "../src/executionState.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-task-runtime-"));
}

function activeExecution(phase = "inspect") {
  return {
    active: true,
    executorId: "builder",
    executorName: "Builder",
    finalizerId: "judge",
    phase,
    nextAction: "Perform a real action.",
    checkpointVersion: 0,
    reviewedCheckpointVersion: 0,
    artifactStatus: "not_checked"
  };
}

test("task run persists a canonical workspace binding and evidence event stream", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-1",
    question: "Create a PDF report.",
    authorizedProjectRoots: ["C:/Users/example/Desktop"],
    attachments: [{ path: "C:/Users/example/Desktop/source.md" }],
    session: { executionState: activeExecution() }
  });

  assert.equal(taskRun.state, "ready");
  assert.deepEqual(taskRun.workspace.authorizedProjectRoots, ["C:/Users/example/Desktop"]);
  assert.deepEqual(taskRun.workspace.attachmentPaths, ["C:/Users/example/Desktop/source.md"]);

  const eventsPath = path.join(groupPath, "shared", "task-runs", taskRun.id, "events.jsonl");
  assert.equal(fs.existsSync(eventsPath), true);
  assert.equal(fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).length, 2);
  assert.equal(listTaskRuns(groupPath).map((item) => item.id).includes(taskRun.id), true);
  assert.equal(readTaskRunEvents(groupPath, taskRun.id, { limit: null }).length, 2);
});

test("task run checkpoints preserve semantic intake state for an interrupted owner", () => {
  const groupPath = workspace();
  const execution = {
    ...activeExecution("intake"),
    taskQuestion: "Arbitrary-language delivery request.",
    intakeAttempts: 1,
    lastAction: "task_contract_missing",
    lastError: "The intake owner responded without a valid task contract or completed tool/file evidence.",
    taskContract: {
      mode: "delivery",
      objective: "Create the requested local artifact.",
      requires_workspace: true,
      requires_verification: true,
      deliverables: ["shared/result.txt"],
      completion_criteria: ["Verify the artifact with a local command."],
      next_action: "Write the artifact."
    }
  };
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-intake",
    question: execution.taskQuestion,
    session: { executionState: execution }
  });
  const stored = readTaskRun(groupPath, taskRun.id);
  assert.equal(stored.execution.taskQuestion, execution.taskQuestion);
  assert.equal(stored.execution.finalizerId, "judge");
  assert.equal(stored.execution.intakeAttempts, 1);
  assert.equal(stored.execution.taskContract.mode, "delivery");
  assert.deepEqual(stored.execution.taskContract.deliverables, ["shared/result.txt"]);

  const resumed = syncTaskRunFromSession({
    groupPath,
    taskRun: stored,
    session: { id: "session-intake", status: "running", executionState: execution }
  });
  assert.equal(resumed.execution.taskContract.nextAction, "Write the artifact.");
  assert.equal(resumed.execution.lastAction, "task_contract_missing");
});

test("task run preserves a blocking repair gate through an interrupted checkpoint", () => {
  const groupPath = workspace();
  const execution = {
    ...activeExecution("repair"),
    checkpointVersion: 7,
    repair: {
      requiredMaterialChange: true,
      checkpointVersion: 7,
      reason: "Reviewer confirmed that the JSON status was not updated.",
      unproductiveVerificationAttempts: 2
    }
  };
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-blocking-repair",
    question: "Update the current JSON status and validate it.",
    session: { executionState: execution }
  });
  const stored = readTaskRun(groupPath, taskRun.id);

  assert.equal(stored.execution.repair.requiredMaterialChange, true);
  assert.equal(stored.execution.repair.checkpointVersion, 7);
  assert.equal(stored.execution.repair.unproductiveVerificationAttempts, 2);
  assert.match(stored.execution.repair.reason, /status was not updated/);
});

test("task run records successful tool, verification, and workspace evidence by stable attempt id", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-2",
    question: "Create and verify a report.",
    session: { executionState: activeExecution() }
  });
  const agent = { id: "builder", name: "Builder" };
  const request = { id: "write-report", tool: "execute_command", command: "node generate.js" };
  const result = {
    id: "write-report",
    tool: "execute_command",
    status: "completed",
    result: { ok: true, exitCode: 0, workspaceChanges: { created: [{ path: "report.pdf" }] } }
  };

  recordTaskRunToolAttempts({ groupPath, taskRun, agent, round: 1, iteration: 1, accepted: [request], results: [result] });
  recordTaskRunFileEvidence({
    groupPath,
    taskRun,
    agent,
    round: 1,
    results: [{ id: "write-file", op: "write", path: "report.pdf", status: "completed", changed: true }]
  });

  const stored = readTaskRun(groupPath, taskRun.id);
  assert.equal(stored.attempts.length, 1);
  assert.equal(stored.attempts[0].status, "succeeded");
  assert.equal(stored.evidence.verificationEvidenceIds.includes("write-report"), true);
  assert.equal(stored.evidence.workspaceEvidence.some((item) => item.path === "report.pdf" && item.changed), true);
});

test("delivery completion remains blocked without verified task evidence and completes after verified evidence", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-3",
    question: "Create a PDF report.",
    session: { executionState: activeExecution("complete") }
  });
  const withoutEvidence = {
    id: "session-3",
    status: "completed",
    executionState: activeExecution("complete"),
    finalDecision: { final_state: "ready_to_execute", answer: "Done." },
    toolExecutionResults: []
  };
  const blocked = syncTaskRunFromSession({ groupPath, taskRun, session: withoutEvidence });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blockReason, "completion_claim_without_verified_task_evidence");

  const retry = createTaskRun({
    groupPath,
    sessionId: "session-4",
    question: "Create a PDF report.",
    session: { executionState: activeExecution("complete") }
  });
  const completed = syncTaskRunFromSession({
    groupPath,
    taskRun: retry,
    session: {
      id: "session-4",
      status: "completed",
      executionState: activeExecution("complete"),
      toolExecutionResults: [{
        id: "verify-pdf",
        tool: "run_code",
        status: "completed",
        result: { ok: true, outputPath: "report.pdf", workspaceChanges: { created: [{ path: "report.pdf" }] } }
      }],
      finalDecision: {
        final_state: "ready_to_execute",
        answer: "Done.",
        requested_artifact_verification: { status: "verified" }
      }
    }
  });
  assert.equal(completed.state, "completed");
});

test("an interrupted delivery resumes the same task record and retains its session lineage", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-before-close",
    question: "Create a report.",
    session: { executionState: activeExecution() }
  });
  const interrupted = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: { id: "session-before-close", status: "interrupted", interruptionReason: "client_closed", executionState: activeExecution() }
  });
  assert.equal(interrupted.state, "interrupted");

  const resumed = createTaskRun({
    groupPath,
    sessionId: "session-after-reopen",
    question: "Create a report.",
    resumeTaskRunId: taskRun.id,
    session: { executionState: activeExecution("repair") }
  });
  assert.equal(resumed.id, taskRun.id);
  assert.equal(resumed.state, "executing");
  assert.deepEqual(resumed.sessionIds, ["session-before-close", "session-after-reopen"]);
  assert.equal(resumed.resumeCount, 1);
});

test("task run records an explicit durable delivery-owner transfer", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-owner-before",
    question: "Create a report.",
    session: { executionState: activeExecution() }
  });
  const transferred = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: {
      id: "session-owner-after",
      status: "running",
      executionState: {
        ...activeExecution("repair"),
        executorId: "replacement",
        executorName: "Replacement",
        ownership: {
          ownerId: "replacement",
          ownerName: "Replacement",
          version: 2,
          transfers: [{
            fromId: "builder",
            fromName: "Builder",
            toId: "replacement",
            toName: "Replacement",
            reason: "previous_owner_unavailable_during_resume",
            version: 2
          }],
          delegations: []
        }
      }
    }
  });
  const event = readTaskRunEvents(groupPath, taskRun.id, { limit: null })
    .find((item) => item.type === "delivery_owner_transferred");

  assert.equal(transferred.execution.ownership.ownerId, "replacement");
  assert.equal(event.payload.fromId, "builder");
  assert.equal(event.payload.toId, "replacement");
  assert.equal(event.payload.reason, "previous_owner_unavailable_during_resume");
});

test("task run preserves a pending bounded delegation through interruption and resume", () => {
  const groupPath = workspace();
  const execution = {
    ...activeExecution("inspect"),
    delegationSequence: 3,
    ownership: {
      ownerId: "builder",
      ownerName: "Builder",
      version: 1,
      transfers: [],
      delegations: [{
        id: "delegation:0:3:researcher",
        type: "research",
        checkpointVersion: 0,
        createdAt: "2026-07-27T10:00:00.000Z",
        assignedBy: "builder",
        assigneeId: "researcher",
        assigneeName: "Researcher",
        task: "Find the required format fact.",
        expectedEvidence: ["Official source"],
        allowedTools: ["web_search", "fetch_url"],
        allowedPaths: [],
        allowWorkspaceMutation: false,
        native: true,
        status: "pending",
        result: "",
        handoffEvidence: [],
        ownerAcknowledged: false
      }]
    }
  };
  const taskRun = createTaskRun({ groupPath, sessionId: "session-delegation-before", question: "Create a report.", session: { executionState: execution } });
  const interrupted = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: { id: "session-delegation-before", status: "interrupted", interruptionReason: "client_closed", executionState: execution }
  });
  const resumed = createTaskRun({
    groupPath,
    sessionId: "session-delegation-after",
    question: "continue",
    resumeTaskRunId: taskRun.id,
    session: { executionState: interrupted.execution }
  });
  const delegation = resumed.execution.ownership.delegations[0];
  assert.equal(resumed.execution.delegationSequence, 3);
  assert.equal(delegation.status, "pending");
  assert.equal(delegation.native, true);
  assert.equal(delegation.createdAt, "2026-07-27T10:00:00.000Z");
  assert.equal(delegation.task, "Find the required format fact.");
  assert.deepEqual(delegation.expectedEvidence, ["Official source"]);
  assert.deepEqual(delegation.allowedTools, ["web_search", "fetch_url"]);
});

test("an interrupted pending review resumes and reaches a durable terminal reviewer outcome", () => {
  const groupPath = workspace();
  const builder = { id: "builder", name: "Builder", role: "Builder", enabled: true };
  const reviewer = { id: "reviewer", name: "Reviewer", role: "Red Team", mandatoryRedTeam: true, enabled: true };
  const execution = {
    ...activeExecution("review"),
    checkpointVersion: 2,
    reviewedCheckpointVersion: 1,
    artifactStatus: "verified",
    ownership: {
      ownerId: "builder",
      ownerName: "Builder",
      version: 1,
      transfers: [],
      delegations: [{
        id: "review:2:reviewer",
        type: "checkpoint_review",
        checkpointVersion: 2,
        assignedBy: "builder",
        assigneeId: "reviewer",
        assigneeName: "Reviewer",
        status: "pending"
      }]
    }
  };
  const taskRun = createTaskRun({ groupPath, sessionId: "session-review-before", question: "Review the verified artifact.", session: { executionState: execution } });
  const interrupted = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: { id: "session-review-before", status: "interrupted", interruptionReason: "process_exit", executionState: execution }
  });
  const resumed = createTaskRun({
    groupPath,
    sessionId: "session-review-after",
    question: "Continue the review.",
    resumeTaskRunId: taskRun.id,
    session: { executionState: interrupted.execution }
  });
  assert.deepEqual(selectExecutionAgents(resumed.execution, [builder, reviewer]).map((agent) => agent.id), ["reviewer"]);

  advanceExecutionState({
    state: resumed.execution,
    session: { groupSnapshot: { agents: [builder, reviewer] } },
    agent: reviewer,
    response: { status: "timed_out", reason: "provider deadline", objection_items: [] }
  });
  const terminal = syncTaskRunFromSession({
    groupPath,
    taskRun: resumed,
    session: { id: "session-review-after", status: "running", executionState: resumed.execution }
  });
  assert.equal(terminal.execution.ownership.delegations[0].status, "timed_out");
  assert.equal(terminal.execution.phase, "complete");
  assert.equal(terminal.state, "checkpointed");
});

test("guard stops preserve their exact reason and checkpoint for recovery", () => {
  const groupPath = workspace();
  const execution = { ...activeExecution("verify"), checkpointVersion: 4, lastAction: "verification_requested" };
  const taskRun = createTaskRun({ groupPath, sessionId: "session-guard", question: "Verify the artifact.", session: { executionState: execution } });
  const blocked = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: { id: "session-guard", status: "guard_stopped", guardStopReason: "provider_call_budget_exhausted", executionState: execution }
  });
  const stored = readTaskRun(groupPath, taskRun.id);
  assert.equal(blocked.state, "blocked");
  assert.equal(stored.blockReason, "provider_call_budget_exhausted");
  assert.equal(stored.execution.phase, "verify");
  assert.equal(stored.execution.checkpointVersion, 4);
});

test("background process and artifact verification are durable TaskRun evidence", () => {
  const groupPath = workspace();
  const taskRun = createTaskRun({
    groupPath,
    sessionId: "session-process",
    question: "Create a PDF report.",
    session: { executionState: activeExecution() }
  });
  const agent = { id: "builder", name: "Builder" };
  recordTaskRunToolAttempts({
    groupPath,
    taskRun,
    agent,
    round: 1,
    iteration: 1,
    accepted: [{ id: "background-build", tool: "execute_command", command: "build-report", background: true }],
    results: [{
      id: "background-build",
      tool: "execute_command",
      status: "completed",
      result: { ok: true, background: true, processId: "proc_report", status: "running" }
    }]
  });
  const waiting = syncTaskRunFromSession({
    groupPath,
    taskRun,
    session: { id: "session-process", status: "running", executionState: activeExecution() }
  });
  assert.equal(waiting.state, "waiting_for_process");
  assert.equal(waiting.execution.activeProcesses[0].processId, "proc_report");

  recordTaskRunToolAttempts({
    groupPath,
    taskRun: waiting,
    agent,
    round: 2,
    iteration: 1,
    accepted: [{ id: "background-status", tool: "process_control", action: "status", processId: "proc_report" }],
    results: [{
      id: "background-status",
      tool: "process_control",
      status: "completed",
      result: { ok: true, action: "status", process: { processId: "proc_report", status: "exited", exitCode: 0 } }
    }]
  });
  recordTaskRunArtifactVerification({
    groupPath,
    taskRun,
    report: { status: "verified", source: "test", requirements: [{ extension: ".pdf", status: "verified", path: "report.pdf", evidence_id: "verify-pdf" }] }
  });
  const stored = readTaskRun(groupPath, taskRun.id);
  assert.equal(stored.execution.activeProcesses.length, 0);
  assert.equal(stored.execution.processes[0].status, "exited");
  assert.equal(stored.evidence.artifactVerification.status, "verified");
});
