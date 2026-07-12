import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";
import { appendFileOperationAuditLog } from "./fileOperationQueue.js";
import { nowIso } from "./types.js";
import { observationValueForConsumer } from "./observationCache.js";

const READABLE_OPS = new Set(["read", "list"]);
const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 120;

export function executeReadListFileOperations(groupPath, proposals = [], options = {}) {
  if (!groupPath) return [];
  const results = [];
  for (const proposal of proposals) {
    if (!READABLE_OPS.has(proposal?.op)) continue;
    const cached = options.observationCache?.get(proposal);
    const result = cached
      ? cachedReadListResult(proposal, cached)
      : executeReadListProposal(groupPath, proposal);
    if (!cached && result.status === "completed") {
      options.observationCache?.set(proposal, observationValue(result), result);
    }
    results.push(result);
    appendFileOperationAuditLog(groupPath, "read_result", result);
  }
  return results;
}

function cachedReadListResult(proposal, cached) {
  return baseResult(proposal, {
    status: "completed",
    ...observationValueForConsumer(proposal, cached.value),
    cacheHit: true,
    sourceObservationId: cached.sourceId,
    sourceObservationAgentId: cached.sourceAgentId,
    sourceObservationAgentName: cached.sourceAgentName,
    workspaceRevision: cached.workspaceRevision,
    observedAt: cached.observedAt
  });
}

function observationValue(result = {}) {
  const { proposalId, op, path, source_agent_id, source_agent_name, createdAt, ...value } = result;
  return value;
}

function executeReadListProposal(groupPath, proposal) {
  try {
    const target = validateFileOperationPath(groupPath, proposal.path);
    if (proposal.op === "read") return readFileResult(target.path, proposal);
    return listDirResult(target.path, proposal);
  } catch (error) {
    return baseResult(proposal, {
      status: "failed",
      error: error.message || "read/list failed"
    });
  }
}

function readFileResult(filePath, proposal) {
  if (!fs.existsSync(filePath)) {
    return baseResult(proposal, { status: "failed", error: "file_not_found" });
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return baseResult(proposal, { status: "failed", error: "not_a_file" });
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return baseResult(proposal, { status: "failed", error: "binary_file_omitted" });
  }
  const truncated = buffer.length > MAX_READ_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;
  return baseResult(proposal, {
    status: "completed",
    bytes: buffer.length,
    truncated,
    content: slice.toString("utf8")
  });
}

function listDirResult(dirPath, proposal) {
  if (!fs.existsSync(dirPath)) {
    return baseResult(proposal, { status: "failed", error: "path_not_found" });
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return baseResult(proposal, { status: "failed", error: "not_a_directory" });
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
  return baseResult(proposal, {
    status: "completed",
    entries,
    truncated: fs.readdirSync(dirPath).length > entries.length
  });
}

function baseResult(proposal = {}, extra = {}) {
  return {
    proposalId: proposal.id || "",
    op: proposal.op || "",
    path: proposal.path || "",
    source_agent_id: proposal.source_agent_id || proposal.proposedBy?.seatId || "",
    source_agent_name: proposal.source_agent_name || proposal.proposedBy?.name || "",
    createdAt: nowIso(),
    ...extra
  };
}
