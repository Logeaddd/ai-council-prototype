import path from "node:path";
import { autoApprovePendingFileOperation, executeApprovedFileOperation } from "./fileOperationExecutor.js";
import { appendFileOperationAuditLog, listPendingFileOperationProposals, updatePendingFileOperationProposal } from "./fileOperationQueue.js";

const DEFAULT_MAX_AUTO_FILES_PER_RUN = 3;
const AUTO_FULL_OPS = new Set(["write", "append", "delete"]);

export function runAutoFileOperations(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const session = options.session || {};
  const group = options.group || {};
  const finalState = session.finalDecision?.final_state;
  const maxAutoFilesPerRun = Number(options.maxAutoFilesPerRun || group.settings?.maxAutoFilesPerRun || DEFAULT_MAX_AUTO_FILES_PER_RUN);
  const pending = listPendingFileOperationProposals(groupPath).filter((proposal) => proposal.status === "pending_user_approval");
  const selectedIds = normalizeSelectedIds(options.selectedFileOperationIds ?? session.finalDecision?.selected_file_operation_ids);
  const hasExplicitSelection = Array.isArray(selectedIds);
  const results = [];

  if (!pending.length) {
    const existing = Array.isArray(session.fileOperationExecutionResults) ? session.fileOperationExecutionResults : [];
    session.fileOperationExecutionState = existing.length ? executionState(existing) : "not_requested";
    return { state: session.fileOperationExecutionState, results: existing };
  }

  if (finalState !== "ready_to_execute") {
    for (const proposal of pending) {
      results.push(markSkipped(groupPath, proposal, "skipped_policy", `final_state_not_ready:${finalState || "unknown"}`));
    }
    return attachResults(session, results);
  }

  const selected = hasExplicitSelection
    ? selectExplicitPendingProposals(groupPath, pending, selectedIds, results)
    : selectLatestPendingProposals(groupPath, pending, results);
  if (selected.length > maxAutoFilesPerRun) {
    for (const proposal of selected) {
      results.push(markSkipped(groupPath, proposal, "skipped_policy", `max_auto_files_exceeded:${selected.length}/${maxAutoFilesPerRun}`));
    }
    return attachResults(session, results);
  }

  for (const proposal of selected) {
    const sourceSeatId = proposalSeatId(proposal);
    const tier = effectivePermissionTier(group, sourceSeatId);
    if (tier !== "full") {
      results.push(markSkipped(groupPath, proposal, "skipped_permission", `effective_tier:${tier}`));
      continue;
    }
    const policy = autoPolicy(groupPath, proposal);
    if (!policy.allowed) {
      results.push(markSkipped(groupPath, proposal, "skipped_policy", policy.reason));
      continue;
    }
    try {
      autoApprovePendingFileOperation({
        groupPath,
        proposalId: proposal.id,
        mode: "full",
        approvedBy: "system:auto-runner",
        maxBatchSize: 1
      });
      const executed = executeApprovedFileOperation({
        groupPath,
        proposalId: proposal.id,
        allowUnrelatedDirtyFiles: true
      });
      results.push({
        proposalId: proposal.id,
        path: proposal.path,
        op: proposal.op,
        source_agent_id: sourceSeatId,
        source_agent_name: proposal.source_agent_name,
        status: "executed",
        commitHash: executed.commitHash,
        verification: executed.verification
      });
    } catch (error) {
      results.push(markSkipped(groupPath, proposal, "failed_execution", error.message || "execution_failed"));
    }
  }

  return attachResults(session, results);
}

export function effectivePermissionTier(group = {}, seatId = "") {
  const permissions = group.permissions || {};
  return permissions.seatTiers?.[seatId] || permissions.defaultTier || "text";
}

function proposalSeatId(proposal = {}) {
  return proposal.source_agent_id || proposal.proposedBy?.seatId || "";
}

function normalizeSelectedIds(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function selectExplicitPendingProposals(groupPath, pending, selectedIds, results) {
  const byId = new Map(pending.map((proposal) => [proposal.id, proposal]));
  const selected = [];
  for (const id of selectedIds) {
    const proposal = byId.get(id);
    if (proposal) {
      selected.push(proposal);
    } else {
      results.push(markUnknownSelection(groupPath, id));
    }
  }
  const selectedSet = new Set(selected.map((proposal) => proposal.id));
  for (const proposal of pending) {
    if (!selectedSet.has(proposal.id)) {
      results.push(markSkipped(groupPath, proposal, "not_selected", "not_selected_by_final_decision"));
    }
  }
  return selected;
}

function selectLatestPendingProposals(groupPath, pending, results) {
  const latestByPath = selectLatestByPath(pending);
  for (const proposal of pending) {
    if (latestByPath.get(proposal.path)?.id !== proposal.id) {
      results.push(markSkipped(groupPath, proposal, "superseded", "superseded_by_later_proposal_for_same_path"));
    }
  }
  return [...latestByPath.values()];
}

function markUnknownSelection(groupPath, proposalId) {
  appendFileOperationAuditLog(groupPath, "skipped_policy", {
    id: proposalId,
    code: "unknown_selected_file_operation_id",
    reason: "unknown_selected_file_operation_id"
  });
  return {
    proposalId,
    path: "",
    op: "",
    status: "skipped_policy",
    reason: "unknown_selected_file_operation_id"
  };
}
function selectLatestByPath(pending) {
  const latest = new Map();
  for (const proposal of pending) {
    const previous = latest.get(proposal.path);
    if (!previous || proposalQueueRank(proposal) >= proposalQueueRank(previous)) {
      latest.set(proposal.path, proposal);
    }
  }
  return latest;
}

function proposalQueueRank(proposal = {}) {
  const explicit = Number(proposal.queuedOrder);
  if (Number.isFinite(explicit)) return explicit;
  const queuedAt = Date.parse(proposal.queuedAt || "");
  if (Number.isFinite(queuedAt)) return queuedAt;
  return 0;
}

function autoPolicy(groupPath, proposal) {
  if (!AUTO_FULL_OPS.has(proposal.op)) return { allowed: false, reason: `unsupported_auto_op:${proposal.op}` };
  return { allowed: true };
}

function markSkipped(groupPath, proposal, status, reason) {
  const updated = {
    ...proposal,
    status: terminalSkippedStatus(status, reason) ? status : proposal.status,
    autoExecutionStatus: status,
    autoExecutionReason: reason
  };
  updatePendingFileOperationProposal(groupPath, updated);
  appendFileOperationAuditLog(groupPath, status, {
    ...updated,
    code: status,
    reason
  });
  return {
    proposalId: proposal.id,
    path: proposal.path,
    op: proposal.op,
    source_agent_id: proposalSeatId(proposal),
    source_agent_name: proposal.source_agent_name,
    status,
    reason
  };
}

function terminalSkippedStatus(status, reason) {
  return status === "superseded" || String(reason || "").startsWith("unsupported_auto_op:");
}

function attachResults(session, results) {
  const existing = Array.isArray(session.fileOperationExecutionResults) ? session.fileOperationExecutionResults : [];
  session.fileOperationExecutionResults = [...existing, ...results];
  session.fileOperationExecutionState = executionState(results);
  return { state: session.fileOperationExecutionState, results: session.fileOperationExecutionResults };
}

function executionState(results) {
  if (!results.length) return "not_requested";
  const executed = results.filter((item) => item.status === "executed").length;
  const actionable = results.filter((item) => !["not_selected", "superseded"].includes(item.status));
  const actionableExecuted = actionable.filter((item) => item.status === "executed").length;
  if (actionable.length && actionableExecuted === actionable.length) return "executed";
  if (executed === results.length) return "executed";
  if (results.some((item) => item.status === "completed")) return "read_completed";
  if (executed > 0) return "partial_executed";
  if (results.some((item) => item.status === "failed_execution")) return "failed_execution";
  if (results.some((item) => item.status === "skipped_permission")) return "pending_approval";
  return "blocked_by_policy";
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}
