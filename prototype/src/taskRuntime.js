import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeTextFileAtomically } from "./atomicFile.js";
import { nowIso } from "./types.js";

export const TASK_RUN_SCHEMA = "ai-council.task-run.v1";
export const TASK_RUN_EVENT_SCHEMA = "ai-council.task-run-event.v1";

const TASK_STATES = new Set([
  "created",
  "ready",
  "executing",
  "waiting_for_tool",
  "waiting_for_process",
  "checkpointed",
  "verifying",
  "review_required",
  "completed",
  "blocked",
  "failed",
  "interrupted",
  "cancelled"
]);
const TERMINAL_STATES = new Set(["completed", "blocked", "failed", "cancelled"]);
const VERIFICATION_TOOLS = new Set(["execute_command", "run_code", "run_tests", "git_operation"]);
const ACTIVE_PROCESS_STATES = new Set(["starting", "running", "stopping"]);
const FAILED_PROCESS_STATES = new Set(["failed", "unknown"]);

export function createTaskRun(options = {}) {
  const groupPath = requiredGroupPath(options.groupPath);
  const sessionId = requiredText(options.sessionId || options.session?.id, "sessionId");
  const resumed = options.resumeTaskRunId
    ? resumeTaskRun({
      groupPath,
      id: options.resumeTaskRunId,
      sessionId,
      question: options.question || options.session?.executionState?.taskQuestion || options.session?.question,
      execution: options.session?.executionState
    })
    : undefined;
  if (resumed) return resumed;
  const id = taskRunId(sessionId);
  const existing = readTaskRun(groupPath, id);
  if (existing) return existing;

  const createdAt = nowIso();
  const run = normalizeTaskRun({
    id,
    sessionId,
    parentTaskRunId: String(options.parentTaskRunId || ""),
    createdAt,
    updatedAt: createdAt,
    state: "created",
    question: String(options.question || options.session?.executionState?.taskQuestion || options.session?.question || ""),
    workspace: normalizeWorkspaceBinding({
      groupPath,
      authorizedProjectRoots: options.authorizedProjectRoots,
      attachments: options.attachments
    }),
    execution: normalizeExecution(options.session?.executionState),
    evidence: emptyEvidence(),
    attempts: [],
    transitions: [],
    eventCount: 0,
    nextSequence: 1
  });
  writeTaskRun(groupPath, run);
  appendTaskRunEvent(groupPath, id, "task_created", {
    state: "created",
    question: run.question,
    workspace: run.workspace,
    execution: run.execution
  });
  transitionTaskRun(groupPath, id, "ready", "delivery_task_initialized");
  return readTaskRun(groupPath, id);
}

// A user continuation resumes the same delivery record when that record was
// interrupted or blocked. Completed/cancelled work is intentionally immutable.
export function resumeTaskRun(options = {}) {
  const groupPath = requiredGroupPath(options.groupPath);
  const id = String(options.id || options.taskRunId || "").trim();
  const sessionId = requiredText(options.sessionId, "sessionId");
  const current = readTaskRun(groupPath, id);
  if (!current || ["completed", "cancelled"].includes(current.state)) return undefined;

  const resumedAt = nowIso();
  const next = normalizeTaskRun({
    ...current,
    sessionId,
    sessionIds: unique([...(current.sessionIds || []), current.sessionId, sessionId]),
    question: String(options.question || current.question),
    updatedAt: resumedAt,
    execution: mergeExecution(current.execution, {
      ...(options.execution || {}),
      active: true,
      phase: String(options.execution?.phase || current.execution?.phase || "inspect"),
      resumed: true
    }),
    final: normalizeFinal({}, "running", "")
  });
  writeTaskRun(groupPath, next);
  appendTaskRunEvent(groupPath, id, "task_resumed", {
    previousState: current.state,
    previousSessionId: current.sessionId,
    sessionId,
    resumeCount: next.resumeCount + 1
  });
  const updated = readTaskRun(groupPath, id);
  updated.resumeCount += 1;
  writeTaskRun(groupPath, updated);
  return transitionTaskRun(groupPath, id, "executing", "resumed_by_user_continuation", { allowReopen: true });
}

export function readTaskRun(groupPath, id) {
  if (!groupPath || !id) return undefined;
  const filePath = taskRunPaths(groupPath, id).manifest;
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return normalizeTaskRun(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

export function listTaskRuns(groupPath, options = {}) {
  const root = taskRunsRoot(groupPath);
  if (!fs.existsSync(root)) return [];
  const limit = clamp(options.limit, 50, 1, 500);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTaskRun(groupPath, entry.name))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
    .slice(0, limit);
}

export function syncTaskRunFromSession(options = {}) {
  const groupPath = options.groupPath;
  const id = String(options.taskRunId || options.taskRun?.id || "").trim();
  const session = options.session || {};
  if (!groupPath || !id) return undefined;
  const current = readTaskRun(groupPath, id);
  if (!current) return undefined;
  const next = normalizeTaskRun({
    ...current,
    sessionId: String(session.id || current.sessionId),
    question: String(session.executionState?.taskQuestion || session.question || current.question),
    updatedAt: nowIso(),
    execution: mergeExecution(current.execution, session.executionState),
    evidence: mergeEvidence(current.evidence, evidenceFromSession(session)),
    final: normalizeFinal(session.finalDecision, session.status, session.guardStopReason)
  });
  const desired = deriveState(session, next);
  const checkpointFingerprint = checkpointHash(next);
  const previousFingerprint = current.execution?.checkpointFingerprint || "";
  next.execution.checkpointFingerprint = checkpointFingerprint;
  writeTaskRun(groupPath, next);
  const ownerTransfer = latestOwnerTransfer(current.execution?.ownership, next.execution?.ownership);
  if (ownerTransfer) {
    appendTaskRunEvent(groupPath, id, "delivery_owner_transferred", ownerTransfer);
  }
  if (previousFingerprint !== checkpointFingerprint) {
    appendTaskRunEvent(groupPath, id, "checkpoint_updated", {
      execution: next.execution,
      evidence: checkpointEvidence(next.evidence)
    });
  }
  if (current.state !== desired.state || current.blockReason !== desired.reason) {
    transitionTaskRun(groupPath, id, desired.state, desired.reason);
  }
  return readTaskRun(groupPath, id);
}

export function recordTaskRunToolAttempts(options = {}) {
  const groupPath = options.groupPath;
  const id = String(options.taskRunId || options.taskRun?.id || "").trim();
  if (!groupPath || !id) return undefined;
  const accepted = Array.isArray(options.accepted) ? options.accepted : [];
  const results = Array.isArray(options.results) ? options.results : [];
  const rejected = Array.isArray(options.rejected) ? options.rejected : [];
  const byId = new Map(results.map((item) => [String(item?.id || ""), item]));
  const run = readTaskRun(groupPath, id);
  if (!run) return undefined;

  for (const request of accepted) {
    const attemptId = attemptIdFor(request, options);
    appendTaskRunEvent(groupPath, id, "tool_attempt_requested", {
      attemptId,
      tool: String(request?.tool || ""),
      requestId: String(request?.id || ""),
      agentId: String(options.agent?.id || request?.source_agent_id || ""),
      agentName: String(options.agent?.name || request?.source_agent_name || ""),
      round: Number(options.round || request?.round || 0),
      iteration: Number(options.iteration || 0),
      capabilityFamily: capabilityFamilyForTool(request?.tool),
      target: toolTarget(request)
    });
    const result = byId.get(String(request?.id || ""));
    if (result) {
      recordTaskRunToolResult(groupPath, id, attemptId, request, result, options);
      recordTaskRunProcessEvidence({ groupPath, id, attemptId, request, result, options });
    }
  }

  for (const result of results) {
    if (accepted.some((request) => String(request?.id || "") === String(result?.id || ""))) continue;
    const attemptId = attemptIdFor(result, options);
    recordTaskRunToolResult(groupPath, id, attemptId, result, result, options);
    recordTaskRunProcessEvidence({ groupPath, id, attemptId, request: result, result, options });
  }

  for (const rejectedRequest of rejected) {
    appendTaskRunEvent(groupPath, id, "tool_attempt_rejected", {
      attemptId: attemptIdFor(rejectedRequest, options),
      tool: String(rejectedRequest?.tool || ""),
      requestId: String(rejectedRequest?.id || ""),
      agentId: String(options.agent?.id || rejectedRequest?.source_agent_id || ""),
      agentName: String(options.agent?.name || rejectedRequest?.source_agent_name || ""),
      round: Number(options.round || rejectedRequest?.round || 0),
      iteration: Number(options.iteration || 0),
      capabilityFamily: capabilityFamilyForTool(rejectedRequest?.tool),
      target: toolTarget(rejectedRequest),
      code: String(rejectedRequest?.code || ""),
      error: String(rejectedRequest?.error || rejectedRequest?.reason || "")
    });
  }
  return refreshTaskRunAttempts(groupPath, id);
}

export function recordTaskRunArtifactVerification(options = {}) {
  const groupPath = options.groupPath;
  const id = String(options.taskRunId || options.taskRun?.id || "").trim();
  if (!groupPath || !id) return undefined;
  const reports = Array.isArray(options.reports) ? options.reports.filter(Boolean) : [options.report].filter(Boolean);
  if (!reports.length) return readTaskRun(groupPath, id);
  for (const report of reports) {
    appendTaskRunEvent(groupPath, id, "artifact_verification", {
      stage: String(options.stage || "final"),
      status: String(report.status || "unknown"),
      source: String(report.source || ""),
      verifiedAt: String(report.verifiedAt || nowIso()),
      evidenceIds: verificationEvidenceIds(report),
      requirements: Array.isArray(report.requirements) ? report.requirements.map(compactArtifactRequirement) : [],
      claims: Array.isArray(report.claims) ? report.claims.map(compactArtifactRequirement) : []
    });
  }
  return refreshTaskRunAttempts(groupPath, id);
}

export function recordTaskRunFileEvidence(options = {}) {
  const groupPath = options.groupPath;
  const id = String(options.taskRunId || options.taskRun?.id || "").trim();
  if (!groupPath || !id) return undefined;
  for (const item of Array.isArray(options.results) ? options.results : []) {
    appendTaskRunEvent(groupPath, id, "workspace_evidence", {
      id: String(item?.id || ""),
      agentId: String(options.agent?.id || item?.source_agent_id || ""),
      agentName: String(options.agent?.name || item?.source_agent_name || ""),
      round: Number(options.round || item?.round || 0),
      operation: String(item?.op || item?.action || item?.tool || ""),
      status: String(item?.status || ""),
      path: String(item?.path || item?.result?.path || ""),
      changed: materialWorkspaceChange(item),
      error: String(item?.error || item?.reason || "")
    });
  }
  return refreshTaskRunAttempts(groupPath, id);
}

export function appendTaskRunEvent(groupPath, id, type, payload = {}) {
  const run = readTaskRun(groupPath, id);
  if (!run) return undefined;
  const paths = taskRunPaths(groupPath, id);
  fs.mkdirSync(paths.dir, { recursive: true });
  const event = {
    schema: TASK_RUN_EVENT_SCHEMA,
    id: `${id}:event:${run.nextSequence}`,
    sequence: run.nextSequence,
    taskRunId: id,
    type: String(type || "event"),
    occurredAt: nowIso(),
    payload: redactEventPayload(payload)
  };
  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, "utf8");
  run.nextSequence += 1;
  run.eventCount += 1;
  run.updatedAt = event.occurredAt;
  writeTaskRun(groupPath, run);
  return event;
}

export function transitionTaskRun(groupPath, id, state, reason = "", options = {}) {
  const nextState = requireTaskState(state);
  const run = readTaskRun(groupPath, id);
  if (!run) return undefined;
  if (TERMINAL_STATES.has(run.state) && run.state !== nextState && !options.allowReopen) return run;
  if (run.state === nextState && run.blockReason === String(reason || "")) return run;
  const transition = {
    from: run.state,
    to: nextState,
    reason: String(reason || ""),
    occurredAt: nowIso()
  };
  run.state = nextState;
  run.blockReason = nextState === "blocked" || nextState === "failed" ? transition.reason : "";
  run.updatedAt = transition.occurredAt;
  run.transitions = [...run.transitions, transition].slice(-80);
  writeTaskRun(groupPath, run);
  appendTaskRunEvent(groupPath, id, "task_state_changed", transition);
  return readTaskRun(groupPath, id);
}

function recordTaskRunToolResult(groupPath, id, attemptId, request, result, options) {
  const succeeded = String(result?.status || "") === "completed" && result?.result?.ok !== false;
  const payload = {
    attemptId,
    tool: String(result?.tool || request?.tool || ""),
    requestId: String(request?.id || result?.id || ""),
    agentId: String(options.agent?.id || result?.source_agent_id || request?.source_agent_id || ""),
    agentName: String(options.agent?.name || result?.source_agent_name || request?.source_agent_name || ""),
    round: Number(options.round || result?.round || request?.round || 0),
    iteration: Number(options.iteration || 0),
    capabilityFamily: capabilityFamilyForTool(result?.tool || request?.tool),
    target: toolTarget(result?.result || request),
    status: succeeded ? "succeeded" : "failed",
    resultStatus: String(result?.status || ""),
    code: String(result?.code || result?.result?.code || ""),
    error: String(result?.error || result?.result?.error || ""),
    evidenceId: String(result?.id || ""),
    materialChange: materialWorkspaceChange(result),
    verification: isVerificationTool(result?.tool || request?.tool)
  };
  appendTaskRunEvent(groupPath, id, "tool_attempt_finished", payload);
}

function recordTaskRunProcessEvidence({ groupPath, id, attemptId, request, result, options }) {
  const process = processEvidence(result, request);
  if (!process) return;
  appendTaskRunEvent(groupPath, id, "background_process_observed", {
    ...process,
    attemptId,
    tool: String(result?.tool || request?.tool || ""),
    agentId: String(options.agent?.id || result?.source_agent_id || request?.source_agent_id || ""),
    agentName: String(options.agent?.name || result?.source_agent_name || request?.source_agent_name || ""),
    round: Number(options.round || result?.round || request?.round || 0),
    iteration: Number(options.iteration || 0)
  });
}

function refreshTaskRunAttempts(groupPath, id) {
  const run = readTaskRun(groupPath, id);
  if (!run) return undefined;
  const events = readTaskRunEvents(groupPath, id);
  const attempts = new Map();
  const workspaceEvidence = [];
  const processes = new Map();
  let artifactVerification = run.evidence?.artifactVerification || null;
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === "tool_attempt_requested") {
      attempts.set(payload.attemptId, { ...payload, status: "requested", startedAt: event.occurredAt });
    }
    if (event.type === "tool_attempt_finished" || event.type === "tool_attempt_rejected") {
      const prior = attempts.get(payload.attemptId) || {};
      attempts.set(payload.attemptId, { ...prior, ...payload, finishedAt: event.occurredAt });
    }
    if (event.type === "workspace_evidence") workspaceEvidence.push({ ...payload, occurredAt: event.occurredAt });
    if (event.type === "background_process_observed" && payload.processId) {
      processes.set(payload.processId, { ...payload, observedAt: event.occurredAt });
    }
    if (event.type === "artifact_verification") artifactVerification = { ...payload, occurredAt: event.occurredAt };
  }
  run.attempts = [...attempts.values()].slice(-200);
  run.evidence = {
    ...run.evidence,
    toolAttemptIds: run.attempts.map((item) => item.attemptId).filter(Boolean).slice(-200),
    successfulToolEvidenceIds: run.attempts.filter((item) => item.status === "succeeded" && item.evidenceId).map((item) => item.evidenceId).slice(-100),
    verificationEvidenceIds: run.attempts.filter((item) => item.status === "succeeded" && item.verification && item.evidenceId).map((item) => item.evidenceId).slice(-50),
    workspaceEvidence: workspaceEvidence.slice(-100),
    artifactVerification
  };
  run.execution.activeProcesses = [...processes.values()].filter((item) => ACTIVE_PROCESS_STATES.has(item.status)).slice(-30);
  run.execution.processes = [...processes.values()].slice(-60);
  run.updatedAt = nowIso();
  writeTaskRun(groupPath, run);
  return run;
}

export function readTaskRunEvents(groupPath, id, options = {}) {
  const filePath = taskRunPaths(groupPath, id).events;
  if (!fs.existsSync(filePath)) return [];
  const events = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event?.schema === TASK_RUN_EVENT_SCHEMA ? [event] : [];
    } catch {
      return [];
    }
  });
  const offset = clamp(options.offset, 0, 0, 1_000_000);
  const limit = clamp(options.limit, 200, 1, 2_000);
  return events.slice(offset, offset + limit);
}

function deriveState(session, run) {
  if (session.status === "interrupted") return { state: "interrupted", reason: String(session.interruptionReason || "interrupted") };
  if (session.guardStopReason) return { state: "blocked", reason: String(session.guardStopReason) };
  const processIssue = unresolvedProcessIssue(run);
  if (processIssue) return processIssue;
  const finalState = String(session.finalDecision?.final_state || "");
  if (finalState === "failed_to_converge") return { state: "failed", reason: "failed_to_converge" };
  if (finalState === "needs_revision") return { state: "blocked", reason: finalBlockReason(session) || "needs_revision" };
  if (["ready_to_execute", "usable_with_risks"].includes(finalState)) {
    return hasVerifiedCompletionEvidence(session, run)
      ? { state: "completed", reason: "verified_terminal_evidence" }
      : { state: "blocked", reason: "completion_claim_without_verified_task_evidence" };
  }
  const phase = String(session.executionState?.phase || "");
  if (phase === "verify") return { state: "verifying", reason: "execution_phase_verify" };
  if (phase === "review") return { state: "review_required", reason: "execution_phase_review" };
  if (phase === "complete") return { state: "checkpointed", reason: "execution_checkpoint_complete_pending_final_verification" };
  if (phase === "repair") return { state: "executing", reason: "execution_phase_repair" };
  return { state: "executing", reason: "session_running" };
}

function hasVerifiedCompletionEvidence(session, run) {
  const requested = session.finalDecision?.requested_artifact_verification?.status === "verified";
  const claimed = session.finalDecision?.deliverable_verification?.status === "verified";
  const verification = run.evidence?.verificationEvidenceIds?.length > 0;
  const material = run.evidence?.workspaceEvidence?.some((item) => item.changed) || run.attempts?.some((item) => item.materialChange);
  return !unresolvedProcessIssue(run) && (requested || claimed || material) && verification;
}

function evidenceFromSession(session) {
  const verification = (session.toolExecutionResults || [])
    .filter((item) => item?.status === "completed" && item?.result?.ok !== false && isVerificationTool(item?.tool))
    .map((item) => String(item.id || ""))
    .filter(Boolean);
  return {
    verificationEvidenceIds: verification,
    artifactVerification: session.finalDecision?.requested_artifact_verification || session.finalDecision?.deliverable_verification || null,
    finalDecisionEvidence: session.finalDecision ? {
      finalState: String(session.finalDecision.final_state || ""),
      answerHash: hash(String(session.finalDecision.answer || ""))
    } : null
  };
}

function mergeEvidence(previous = {}, next = {}) {
  return {
    ...emptyEvidence(),
    ...previous,
    ...next,
    toolAttemptIds: unique([...(previous.toolAttemptIds || []), ...(next.toolAttemptIds || [])]),
    successfulToolEvidenceIds: unique([...(previous.successfulToolEvidenceIds || []), ...(next.successfulToolEvidenceIds || [])]),
    verificationEvidenceIds: unique([...(previous.verificationEvidenceIds || []), ...(next.verificationEvidenceIds || [])])
  };
}

function checkpointEvidence(evidence = {}) {
  return {
    successfulToolEvidenceIds: (evidence.successfulToolEvidenceIds || []).slice(-8),
    verificationEvidenceIds: (evidence.verificationEvidenceIds || []).slice(-8),
    workspaceEvidence: (evidence.workspaceEvidence || []).slice(-8),
    artifactVerification: evidence.artifactVerification || null
  };
}

function checkpointHash(run) {
  return hash(JSON.stringify({ execution: run.execution, evidence: checkpointEvidence(run.evidence), final: run.final }));
}

function normalizeTaskRun(value = {}) {
  const state = TASK_STATES.has(value.state) ? value.state : "created";
  return {
    schema: TASK_RUN_SCHEMA,
    id: String(value.id || ""),
    sessionId: String(value.sessionId || ""),
    sessionIds: unique([...(Array.isArray(value.sessionIds) ? value.sessionIds : []), value.sessionId].map((item) => String(item || "")).filter(Boolean)).slice(-80),
    parentTaskRunId: String(value.parentTaskRunId || ""),
    createdAt: String(value.createdAt || ""),
    updatedAt: String(value.updatedAt || ""),
    state,
    blockReason: String(value.blockReason || ""),
    question: String(value.question || ""),
    workspace: normalizeWorkspaceBinding(value.workspace),
    execution: normalizeExecution(value.execution),
    evidence: mergeEvidence(emptyEvidence(), value.evidence),
    final: normalizeFinal(value.final),
    attempts: Array.isArray(value.attempts) ? value.attempts.filter((item) => item && typeof item === "object").slice(-200) : [],
    transitions: Array.isArray(value.transitions) ? value.transitions.filter((item) => item && typeof item === "object").slice(-80) : [],
    resumeCount: Math.max(0, Number(value.resumeCount || 0)),
    eventCount: Math.max(0, Number(value.eventCount || 0)),
    nextSequence: Math.max(1, Number(value.nextSequence || 1))
  };
}

function normalizeWorkspaceBinding(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const attachmentPaths = Array.isArray(source.attachmentPaths)
    ? source.attachmentPaths
    : Array.isArray(source.attachments)
      ? source.attachments.map((item) => typeof item === "string" ? item : item?.path || item?.sourcePath || item?.filePath || "")
      : [];
  return {
    groupPath: String(source.groupPath || ""),
    authorizedProjectRoots: unique(Array.isArray(source.authorizedProjectRoots) ? source.authorizedProjectRoots.map((item) => String(item || "")).filter(Boolean) : []),
    attachmentPaths: unique(attachmentPaths.map((item) => String(item || "")).filter(Boolean))
  };
}

function normalizeExecution(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    active: Boolean(source.active),
    executorId: String(source.executorId || ""),
    executorName: String(source.executorName || ""),
    ownership: normalizeOwnership(source.ownership, source),
    phase: String(source.phase || ""),
    nextAction: String(source.nextAction || ""),
    checkpointVersion: Math.max(0, Number(source.checkpointVersion || 0)),
    reviewedCheckpointVersion: Math.max(0, Number(source.reviewedCheckpointVersion || 0)),
    processedToolResults: Math.max(0, Number(source.processedToolResults || 0)),
    processedFileResults: Math.max(0, Number(source.processedFileResults || 0)),
    noActionCalls: Math.max(0, Number(source.noActionCalls || 0)),
    artifactStatus: String(source.artifactStatus || ""),
    lastAction: String(source.lastAction || ""),
    lastError: String(source.lastError || "").slice(0, 1600),
    checkpointFingerprint: String(source.checkpointFingerprint || ""),
    checkpointEvidence: Array.isArray(source.checkpointEvidence) ? source.checkpointEvidence.filter((item) => item && typeof item === "object").slice(-12) : [],
    activeProcesses: normalizeProcesses(source.activeProcesses),
    processes: normalizeProcesses(source.processes),
    resumed: Boolean(source.resumed)
  };
}

function normalizeOwnership(value = {}, execution = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ownerId: String(source.ownerId || execution.executorId || ""),
    ownerName: String(source.ownerName || execution.executorName || ""),
    version: Math.max(1, Number(source.version || 1)),
    transfers: Array.isArray(source.transfers)
      ? source.transfers.filter((item) => item && typeof item === "object").map(compactOwnershipTransfer).slice(-20)
      : [],
    delegations: Array.isArray(source.delegations)
      ? source.delegations.filter((item) => item && typeof item === "object").map(compactDelegation).slice(-40)
      : []
  };
}

function compactOwnershipTransfer(value = {}) {
  return {
    fromId: String(value.fromId || ""),
    fromName: String(value.fromName || ""),
    toId: String(value.toId || ""),
    toName: String(value.toName || ""),
    reason: String(value.reason || "").slice(0, 300),
    version: Math.max(1, Number(value.version || 1))
  };
}

function compactDelegation(value = {}) {
  return {
    id: String(value.id || ""),
    type: String(value.type || ""),
    checkpointVersion: Math.max(0, Number(value.checkpointVersion || 0)),
    assignedBy: String(value.assignedBy || ""),
    assigneeId: String(value.assigneeId || ""),
    assigneeName: String(value.assigneeName || ""),
    status: String(value.status || "pending"),
    result: String(value.result || "").slice(0, 120)
  };
}

function latestOwnerTransfer(previous = {}, next = {}) {
  const priorVersion = Number(previous?.version || 1);
  const nextVersion = Number(next?.version || 1);
  if (nextVersion <= priorVersion || !next?.ownerId) return undefined;
  const transfer = Array.isArray(next.transfers) ? next.transfers.at(-1) : undefined;
  return transfer && transfer.toId === next.ownerId ? compactOwnershipTransfer(transfer) : undefined;
}

function mergeExecution(previous = {}, current = {}) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const next = current && typeof current === "object" ? current : {};
  return normalizeExecution({
    ...prior,
    ...next,
    // Tool-owned process state must survive normal session checkpoints until
    // a later process-control result supersedes it.
    activeProcesses: prior.activeProcesses,
    processes: prior.processes,
    resumed: next.resumed ?? prior.resumed
  });
}

function normalizeFinal(value = {}, status = "", guardStopReason = "") {
  const source = value && typeof value === "object" ? value : {};
  return {
    sessionStatus: String(status || source.sessionStatus || ""),
    finalState: String(source.finalState || source.final_state || ""),
    guardStopReason: String(guardStopReason || source.guardStopReason || ""),
    answerHash: String(source.answerHash || (source.answer ? hash(String(source.answer)) : ""))
  };
}

function emptyEvidence() {
  return {
    toolAttemptIds: [],
    successfulToolEvidenceIds: [],
    verificationEvidenceIds: [],
    workspaceEvidence: [],
    artifactVerification: null,
    finalDecisionEvidence: null
  };
}

function processEvidence(result = {}, request = {}) {
  const payload = result?.result || {};
  const process = payload.process || {};
  const processId = String(payload.processId || process.processId || request.processId || "").trim();
  if (!processId) return null;
  const status = String(process.status || payload.status || (payload.background || result.background || request.background ? "running" : "")).trim().toLowerCase();
  if (!status) return null;
  return {
    processId,
    status,
    action: String(payload.action || request.action || (payload.background || result.background || request.background ? "start" : "status")),
    exitCode: Number.isFinite(Number(process.exitCode ?? payload.exitCode)) ? Number(process.exitCode ?? payload.exitCode) : null,
    error: String(process.error || payload.error || result.error || "").slice(0, 1600)
  };
}

function unresolvedProcessIssue(run = {}) {
  const processes = Array.isArray(run.execution?.processes) ? run.execution.processes : [];
  const unknown = processes.find((item) => FAILED_PROCESS_STATES.has(String(item?.status || "")));
  if (unknown) return {
    state: "blocked",
    reason: unknown.status === "unknown" ? "background_process_state_unknown" : "background_process_failed"
  };
  if (processes.some((item) => ACTIVE_PROCESS_STATES.has(String(item?.status || "")))) {
    return { state: "waiting_for_process", reason: "background_process_running" };
  }
  return null;
}

function normalizeProcesses(value) {
  const byId = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const processId = String(item?.processId || "").trim();
    if (!processId) continue;
    byId.set(processId, {
      processId,
      status: String(item.status || "").toLowerCase(),
      action: String(item.action || ""),
      exitCode: Number.isFinite(Number(item.exitCode)) ? Number(item.exitCode) : null,
      error: String(item.error || "").slice(0, 1600),
      observedAt: String(item.observedAt || "")
    });
  }
  return [...byId.values()].slice(-60);
}

function verificationEvidenceIds(report = {}) {
  const items = [...(Array.isArray(report.requirements) ? report.requirements : []), ...(Array.isArray(report.claims) ? report.claims : [])];
  return unique(items.flatMap((item) => [item?.evidence_id, ...(Array.isArray(item?.evidence_ids) ? item.evidence_ids : [])]).map((item) => String(item || "")).filter(Boolean)).slice(-50);
}

function compactArtifactRequirement(item = {}) {
  return {
    extension: String(item.extension || ""),
    path: String(item.path || item.normalized_path || ""),
    status: String(item.status || ""),
    evidenceId: String(item.evidence_id || ""),
    evidenceIds: Array.isArray(item.evidence_ids) ? item.evidence_ids.map((value) => String(value || "")).filter(Boolean).slice(0, 20) : [],
    reason: String(item.reason || "").slice(0, 1200)
  };
}

function writeTaskRun(groupPath, run) {
  const paths = taskRunPaths(groupPath, run.id);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeTextFileAtomically(paths.manifest, JSON.stringify(normalizeTaskRun(run), null, 2));
}

function taskRunsRoot(groupPath) {
  return path.join(requiredGroupPath(groupPath), "shared", "task-runs");
}

function taskRunPaths(groupPath, id) {
  const safeId = requiredText(id, "taskRunId").replace(/[^A-Za-z0-9_.-]/g, "_");
  const dir = path.join(taskRunsRoot(groupPath), safeId);
  return { dir, manifest: path.join(dir, "task-run.json"), events: path.join(dir, "events.jsonl") };
}

function taskRunId(sessionId) {
  return `task-${String(sessionId || "").replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function attemptIdFor(item = {}, options = {}) {
  const requestId = String(item?.id || item?.requestId || item?.request_id || "").trim();
  const basis = [options.taskRunId || options.taskRun?.id || "", options.round || item?.round || 0, options.iteration || 0, requestId, item?.tool || ""].join("\u001f");
  return `attempt-${hash(basis).slice(0, 18)}`;
}

function toolTarget(item = {}) {
  return String(item?.path || item?.destination || item?.cwd || item?.command || item?.query || item?.toolName || "").slice(0, 800);
}

function capabilityFamilyForTool(tool) {
  const name = String(tool || "").trim();
  if (["web_search", "fetch_url", "api_request"].includes(name)) return "web";
  if (name.startsWith("mcp_")) return "mcp";
  if (name.startsWith("skill_")) return "skills";
  if (["execute_command", "process_control", "run_code", "install_package", "provision_tool", "run_tests", "git_operation"].includes(name)) return "automation";
  if (["workspace_edit", "list_directory", "read_file", "search_files", "grep_content", "extract_archive", "create_archive"].includes(name)) return "files";
  if (name === "browser_control") return "browser";
  if (name === "database_query") return "database";
  return "";
}

function isVerificationTool(tool) {
  return VERIFICATION_TOOLS.has(String(tool || ""));
}

function materialWorkspaceChange(item = {}) {
  const result = item?.result || item;
  return Boolean(
    result?.workspaceChanges?.length
    || result?.changes?.length
    || result?.changed
    || result?.created
    || result?.outputPath
    || result?.artifactPath
    || result?.path && /(?:write|append|replace|move|create|extract|archive|install|command|code)/i.test(String(item?.tool || item?.op || item?.action || ""))
  );
}

function finalBlockReason(session) {
  const blocker = Array.isArray(session.finalDecision?.blocking_issues) ? session.finalDecision.blocking_issues[0] : null;
  return String(blocker?.issue || blocker || session.finalDecision?.risks?.[0] || "");
}

function redactEventPayload(value) {
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (typeof current !== "string") return current;
    return current
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
      .replace(/(api[_-]?key\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]")
      .slice(0, 5000);
  }));
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function unique(items) {
  return [...new Set(items)];
}

function requiredGroupPath(value) {
  const groupPath = String(value || "").trim();
  if (!groupPath) throw new Error("Task run persistence requires a group workspace.");
  return path.resolve(groupPath);
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Task run requires ${label}.`);
  return text;
}

function requireTaskState(value) {
  const state = String(value || "").trim();
  if (!TASK_STATES.has(state)) throw new Error(`Unknown task run state: ${state}`);
  return state;
}

function clamp(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
