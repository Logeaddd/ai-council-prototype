import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./types.js";

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
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
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
    phase: String(value.phase || "inspect"),
    nextAction: String(value.nextAction || ""),
    checkpointVersion: Math.max(0, Number(value.checkpointVersion) || 0),
    reviewedCheckpointVersion: Math.max(0, Number(value.reviewedCheckpointVersion) || 0),
    artifactStatus: String(value.artifactStatus || "not_checked"),
    lastAction: String(value.lastAction || ""),
    lastError: truncate(value.lastError || "", 1200),
    sourceSessionId: String(session.id || value.sourceSessionId || ""),
    updatedAt: String(session.id ? nowIso() : value.updatedAt || "")
  };
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
