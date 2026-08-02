import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./types.js";
import { normalizeTaskContract } from "./executionState.js";
import { writeTextFileAtomically } from "./atomicFile.js";

export function readTaskState(groupPath) {
  const filePath = taskStatePath(groupPath);
  if (!fs.existsSync(filePath)) return defaultTaskState();
  try {
    return normalizeTaskState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return defaultTaskState({ status: "unreadable" });
  }
}

export function writeTaskState(groupPath, state) {
  const filePath = taskStatePath(groupPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeTaskState(state);
  writeTextFileAtomically(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function updateTaskStateFromSession(groupPath, session) {
  if (!groupPath || !session) return undefined;
  const previous = readTaskState(groupPath);
  const finalDecision = session.finalDecision || {};
  const next = {
    ...previous,
    schema: "ai-council.task-state.v2",
    updatedAt: nowIso(),
    sourceSessionId: session.id || "",
    sourceQuestion: session.question || "",
    finalState: finalDecision.final_state || "",
    decisions: buildDecisions(previous.decisions, session),
    blockers: buildBlockers(finalDecision),
    risks: normalizeTextList(finalDecision.risks || finalDecision.unresolved_risks),
    nextActions: normalizeTextList(finalDecision.next_actions),
    pendingFiles: buildPendingFiles(session),
    invalidations: mergeInvalidations(previous.invalidations, session.contextInvalidations),
    resolved: buildResolvedItems(previous.resolved, session),
    executionCheckpoint: normalizeExecutionCheckpoint(session.executionState, session)
  };
  return writeTaskState(groupPath, next);
}

export function updateExecutionCheckpoint(groupPath, session) {
  if (!groupPath || !session?.executionState?.active) return undefined;
  const previous = readTaskState(groupPath);
  return writeTaskState(groupPath, {
    ...previous,
    schema: "ai-council.task-state.v2",
    updatedAt: nowIso(),
    sourceSessionId: session.id || previous.sourceSessionId,
    sourceQuestion: session.executionState.taskQuestion || session.question || previous.sourceQuestion,
    executionCheckpoint: normalizeExecutionCheckpoint(session.executionState, session)
  });
}

export function formatTaskStateForPrompt(state) {
  const normalized = normalizeTaskState(state);
  const hasContent = normalized.decisions.length
    || normalized.blockers.length
    || normalized.risks.length
    || normalized.nextActions.length
    || normalized.pendingFiles.length
    || normalized.resolved.length
    || normalized.executionCheckpoint;
  if (!hasContent) return "";
  return JSON.stringify({
    source: "task_state_ledger",
    note: "Public task state maintained by the app from final decisions and file proposal state. It is not a hidden thought log and not private chat.",
    updatedAt: normalized.updatedAt,
    sourceSessionId: normalized.sourceSessionId,
    sourceQuestion: normalized.sourceQuestion,
    finalState: normalized.finalState,
    decisions: normalized.decisions.slice(-5),
    blockers: normalized.blockers,
    risks: normalized.risks,
    nextActions: normalized.nextActions,
    pendingFiles: normalized.pendingFiles,
    invalidations: normalized.invalidations,
    resolved: normalized.resolved.slice(-8),
    executionCheckpoint: normalized.executionCheckpoint
  }, null, 2);
}

function buildDecisions(previous = [], session) {
  const answer = String(session.finalDecision?.answer || "").trim();
  if (!answer) return previous.slice(-10);
  return upsertByKey(previous, {
    id: `decision-${session.id}`,
    sourceSessionId: session.id || "",
    source: "final_decision",
    text: truncate(answer, 1200),
    createdAt: session.completedAt || nowIso()
  }, "id").slice(-10);
}

function buildBlockers(finalDecision) {
  const raw = [
    ...(Array.isArray(finalDecision.blocking_issues) ? finalDecision.blocking_issues : []),
    ...(Array.isArray(finalDecision.unresolved_blockers) ? finalDecision.unresolved_blockers : [])
  ];
  return raw.map((item, index) => {
    if (typeof item === "string") {
      return { id: `blocker-${index + 1}`, issue: item, severity: "unknown", source: "final_decision" };
    }
    return {
      id: String(item?.id || `blocker-${index + 1}`),
      issue: String(item?.issue || item?.title || item?.why || "").trim(),
      severity: String(item?.severity || "unknown"),
      source_agent_id: String(item?.source_agent_id || ""),
      source_agent_name: String(item?.source_agent_name || item?.raisedBy || ""),
      suggested_fix: String(item?.suggested_fix || "")
    };
  }).filter((item) => item.issue);
}

function buildPendingFiles(session) {
  const proposals = Array.isArray(session.pendingFileOperationProposals)
    ? session.pendingFileOperationProposals
    : [];
  const selected = new Set(Array.isArray(session.finalDecision?.selected_file_operation_ids)
    ? session.finalDecision.selected_file_operation_ids
    : []);
  return proposals.map((proposal) => ({
    id: proposal.id || "",
    op: proposal.op || "",
    path: proposal.path || "",
    status: proposal.status || "",
    selected: selected.has(proposal.id),
    source_agent_id: proposal.source_agent_id || proposal.proposedBy?.seatId || "",
    source_agent_name: proposal.source_agent_name || proposal.proposedBy?.name || ""
  })).filter((item) => item.id || item.path);
}

function buildResolvedItems(previous = [], session) {
  const state = session.finalDecision?.final_state || "";
  if (!["ready_to_execute", "usable_with_risks"].includes(state)) return previous.slice(-20);
  return upsertByKey(previous, {
    id: `resolved-${session.id}`,
    sourceSessionId: session.id || "",
    text: truncate(session.question || "", 500),
    finalState: state,
    createdAt: session.completedAt || nowIso()
  }, "id").slice(-20);
}

function normalizeTaskState(value = {}) {
  return {
    schema: "ai-council.task-state.v2",
    updatedAt: String(value.updatedAt || ""),
    sourceSessionId: String(value.sourceSessionId || ""),
    sourceQuestion: String(value.sourceQuestion || ""),
    finalState: String(value.finalState || ""),
    status: String(value.status || "ok"),
    decisions: normalizeObjects(value.decisions),
    blockers: normalizeObjects(value.blockers),
    risks: normalizeTextList(value.risks),
    nextActions: normalizeTextList(value.nextActions),
    pendingFiles: normalizeObjects(value.pendingFiles),
    invalidations: normalizeInvalidations(value.invalidations),
    resolved: normalizeObjects(value.resolved),
    executionCheckpoint: normalizeExecutionCheckpoint(value.executionCheckpoint)
  };
}

function normalizeExecutionCheckpoint(value, session = {}) {
  if (!value?.active) return null;
  return {
    active: true,
    taskQuestion: String(value.taskQuestion || session.question || ""),
    executorId: String(value.executorId || ""),
    executorName: String(value.executorName || ""),
    finalizerId: String(value.finalizerId || ""),
    workMode: ["collab", "independent"].includes(value.workMode) ? value.workMode : "",
    ownership: normalizeExecutionOwnership(value.ownership, value),
    participation: normalizeExecutionParticipation(value.participation),
    taskContract: normalizeTaskContract(value.taskContract),
    intakeAttempts: Math.max(0, Number(value.intakeAttempts || 0)),
    delegationSequence: Math.max(0, Number(value.delegationSequence || 0)),
    phase: String(value.phase || "inspect"),
    nextAction: String(value.nextAction || ""),
    checkpointVersion: Math.max(0, Number(value.checkpointVersion) || 0),
    reviewedCheckpointVersion: Math.max(0, Number(value.reviewedCheckpointVersion) || 0),
    repair: normalizeExecutionRepair(value.repair),
    artifactStatus: String(value.artifactStatus || "not_checked"),
    lastAction: String(value.lastAction || ""),
    lastError: truncate(value.lastError || "", 1200),
    checkpointEvidence: normalizeCheckpointEvidence(value.checkpointEvidence),
    sourceSessionId: String(session.id || value.sourceSessionId || ""),
    updatedAt: String(session.id ? nowIso() : value.updatedAt || "")
  };
}

function normalizeExecutionRepair(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    requiredMaterialChange: source.requiredMaterialChange === true,
    checkpointVersion: Math.max(0, Number(source.checkpointVersion || 0)),
    reason: truncate(source.reason || "", 1200),
    unproductiveVerificationAttempts: Math.max(0, Number(source.unproductiveVerificationAttempts || 0))
  };
}

function normalizeExecutionOwnership(value, execution = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ownerId: String(source.ownerId || execution.executorId || ""),
    ownerName: String(source.ownerName || execution.executorName || ""),
    version: Math.max(1, Number(source.version || 1)),
    transfers: Array.isArray(source.transfers)
      ? source.transfers.filter((item) => item && typeof item === "object").map((item) => ({
        fromId: String(item.fromId || ""),
        fromName: String(item.fromName || ""),
        toId: String(item.toId || ""),
        toName: String(item.toName || ""),
        reason: String(item.reason || "").slice(0, 300),
        version: Math.max(1, Number(item.version || 1))
      })).slice(-20)
      : [],
    delegations: Array.isArray(source.delegations)
      ? source.delegations.filter((item) => item && typeof item === "object").map((item) => ({
        id: String(item.id || ""),
        type: String(item.type || ""),
        checkpointVersion: Math.max(0, Number(item.checkpointVersion || 0)),
        createdAt: String(item.createdAt || ""),
        assignedBy: String(item.assignedBy || ""),
        assigneeId: String(item.assigneeId || ""),
        assigneeName: String(item.assigneeName || ""),
        status: String(item.status || "pending"),
        task: String(item.task || "").slice(0, 1200),
        expectedEvidence: normalizeTextList(item.expectedEvidence || item.expected_evidence).slice(0, 8),
        allowedTools: normalizeTextList(item.allowedTools || item.allowed_tools).slice(0, 24),
        allowedPaths: normalizeTextList(item.allowedPaths || item.allowed_paths).slice(0, 16),
        allowWorkspaceMutation: Boolean(item.allowWorkspaceMutation ?? item.allow_workspace_mutation),
        native: item.native === true,
        result: String(item.result || "").slice(0, 600),
        handoffEvidence: normalizeDelegationEvidence(item.handoffEvidence || item.handoff_evidence),
        ownerAcknowledged: item.ownerAcknowledged === true,
        acknowledgedBy: String(item.acknowledgedBy || "")
      })).slice(-40)
      : []
  };
}

function normalizeDelegationEvidence(value) {
  return (Array.isArray(value) ? value : []).filter((item) => item && typeof item === "object").map((item) => ({
    kind: String(item.kind || "reported").slice(0, 40),
    detail: String(item.detail || "").slice(0, 500)
  })).filter((item) => item.detail).slice(0, 16);
}

function normalizeExecutionParticipation(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    policy: ["collab", "independent"].includes(source.policy) ? source.policy : "",
    status: String(source.status || "not_started"),
    startedAt: String(source.startedAt || ""),
    completedAt: String(source.completedAt || ""),
    ownerIntegrationStatus: String(source.ownerIntegrationStatus || "not_required"),
    ownerIntegratedAt: String(source.ownerIntegratedAt || ""),
    participants: Array.isArray(source.participants)
      ? source.participants.filter((item) => item && typeof item === "object").map((item) => ({
          agentId: String(item.agentId || ""),
          agentName: String(item.agentName || ""),
          role: String(item.role || ""),
          scope: String(item.scope || "").slice(0, 600),
          status: String(item.status || "scheduled"),
          outcome: String(item.outcome || ""),
          summary: String(item.summary || "").slice(0, 1200),
          evidence: normalizeDelegationEvidence(item.evidence),
          completedAt: String(item.completedAt || "")
        })).filter((item) => item.agentId).slice(0, 40)
      : []
  };
}

function normalizeCheckpointEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    id: String(item?.id || "").trim(),
    tool: String(item?.tool || "").trim(),
    status: String(item?.status || "").trim(),
    target: String(item?.target || "").trim(),
    outcome: String(item?.outcome || "").trim()
  })).filter((item) => item.id && item.tool).slice(-6);
}

function defaultTaskState(extra = {}) {
  return normalizeTaskState({
    updatedAt: "",
    decisions: [],
    blockers: [],
    risks: [],
    nextActions: [],
    pendingFiles: [],
    invalidations: [],
    resolved: [],
    ...extra
  });
}

function taskStatePath(groupPath) {
  return path.join(path.resolve(groupPath), "shared", "task_state.json");
}

function normalizeObjects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function mergeInvalidations(previous, next) {
  const byKey = new Map();
  for (const item of [...normalizeInvalidations(previous), ...normalizeInvalidations(next)]) {
    byKey.set(`${item.source.type}\u001f${item.source.id}`, item);
  }
  return [...byKey.values()];
}

function normalizeInvalidations(value) {
  return (Array.isArray(value) ? value : []).map((item) => {
    const source = item?.source || item;
    const supersededBy = item?.supersededBy || item?.superseded_by;
    return {
      source: { type: String(source?.type || "").trim(), id: String(source?.id || "").trim() },
      supersededBy: { type: String(supersededBy?.type || "").trim(), id: String(supersededBy?.id || "").trim() },
      reason: String(item?.reason || "explicit_source_invalidation").trim()
    };
  }).filter((item) => item.source.type && item.source.id && item.supersededBy.type && item.supersededBy.id);
}

function normalizeTextList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item || "").trim()).filter(Boolean);
}

function upsertByKey(items, next, key) {
  return [
    ...items.filter((item) => item?.[key] !== next[key]),
    next
  ];
}

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
