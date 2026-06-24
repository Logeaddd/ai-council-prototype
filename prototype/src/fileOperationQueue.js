import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";
import { makeId, nowIso } from "./types.js";

const WRITE_LIKE_OPS = new Set(["write", "append", "delete"]);
const PREVIEW_LIMIT = 1200;
let queueSequence = 0;

export function enqueueFileOperationProposals(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const accepted = Array.isArray(options.accepted) ? options.accepted : [];
  const rejected = Array.isArray(options.rejected) ? options.rejected : [];
  const approved = executionStandardsApproved(groupPath);
  const queued = [];
  const queueRejected = [];

  for (const proposal of accepted) {
    if (WRITE_LIKE_OPS.has(proposal.op) && !approved) {
      const rejection = rejectQueuedProposal(proposal, "execution_standards_not_approved", "Write-like file operations require approved execution standards.");
      queueRejected.push(rejection);
      appendAuditLog(groupPath, auditRecord("rejected", rejection));
      continue;
    }
    const pending = writePendingProposal(groupPath, proposal);
    queued.push(pending);
    appendAuditLog(groupPath, auditRecord("queued", pending));
  }

  for (const rejection of rejected) {
    appendAuditLog(groupPath, auditRecord("rejected", rejection));
  }

  return { queued, rejected: [...queueRejected, ...rejected] };
}

export function listPendingFileOperationProposals(groupPath) {
  const dir = pendingDir(requirePath(groupPath, "groupPath"));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
}

export function readFileOperationAuditLog(groupPath) {
  const filePath = auditLogPath(requirePath(groupPath, "groupPath"));
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function listFileOperationReviewItems(groupPath) {
  const resolvedGroupPath = requirePath(groupPath, "groupPath");
  return listPendingFileOperationProposals(resolvedGroupPath).map((proposal) => reviewItemForProposal(resolvedGroupPath, proposal));
}

export function readPendingFileOperationProposal(groupPath, proposalId) {
  const filePath = pendingFilePath(requirePath(groupPath, "groupPath"), requireId(proposalId));
  if (!fs.existsSync(filePath)) throw new Error(`Unknown pending file operation: ${proposalId}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function updatePendingFileOperationProposal(groupPath, proposal) {
  const resolvedGroupPath = requirePath(groupPath, "groupPath");
  if (!proposal?.id) throw new Error("Missing proposal id");
  writeJson(pendingFilePath(resolvedGroupPath, proposal.id), proposal);
  return proposal;
}

export function appendFileOperationAuditLog(groupPath, action, item) {
  appendAuditLog(requirePath(groupPath, "groupPath"), auditRecord(action, item));
}

function reviewItemForProposal(groupPath, proposal) {
  const { content, resolvedPath, ...safeProposal } = proposal;
  return {
    ...safeProposal,
    content_summary: summarizeContent(content),
    preview: previewProposal(groupPath, proposal)
  };
}

function previewProposal(groupPath, proposal) {
  try {
    const target = validateFileOperationPath(groupPath, proposal.path);
    if (proposal.op === "write") return writePreview(target.path, proposal.content);
    if (proposal.op === "append") return appendPreview(target.path, proposal.content);
    if (proposal.op === "delete") return deletePreview(target.path);
    if (proposal.op === "read" || proposal.op === "list") return { kind: proposal.op, text: "No write will be performed for " + proposal.op + "." };
    return { kind: "unknown", text: "Unsupported preview." };
  } catch (error) {
    return { kind: "error", text: error.message || "Preview unavailable." };
  }
}

function writePreview(filePath, content) {
  const exists = fs.existsSync(filePath);
  const before = exists ? readPreviewText(filePath) : "";
  const after = String(content ?? "");
  return {
    kind: exists ? "replace" : "create",
    text: previewDiff(before, after, exists ? "replace" : "create")
  };
}

function appendPreview(filePath, content) {
  const before = fs.existsSync(filePath) ? readPreviewText(filePath) : "";
  const addition = String(content ?? "");
  return {
    kind: "append",
    text: previewDiff(before, before + addition, "append")
  };
}

function deletePreview(filePath) {
  const before = fs.existsSync(filePath) ? readPreviewText(filePath) : "";
  return {
    kind: "delete",
    text: before ? previewDiff(before, "", "delete") : "File does not exist. Delete execution will fail."
  };
}

function previewDiff(before, after, kind) {
  const beforeText = redactSecrets(truncatePreview(before));
  const afterText = redactSecrets(truncatePreview(after));
  if (kind === "create") return "+ " + afterText;
  if (kind === "delete") return "- " + beforeText;
  if (beforeText === afterText) return "No visible text change in preview.";
  return ["- " + beforeText, "+ " + afterText].join("\n");
}

function readPreviewText(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return "[binary file preview omitted]";
  return buffer.toString("utf8");
}

function truncatePreview(text) {
  const value = String(text || "");
  if (value.length <= PREVIEW_LIMIT) return value;
  return value.slice(0, PREVIEW_LIMIT) + "\n... [preview truncated]";
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]");
}

function writePendingProposal(groupPath, proposal) {
  const now = nowIso();
  queueSequence += 1;
  const pending = {
    ...proposal,
    id: proposal.id || makeId("fop"),
    status: "pending_user_approval",
    queuedAt: now,
    queuedOrder: Date.now() * 1000 + queueSequence
  };
  const filePath = path.join(pendingDir(groupPath), `${pending.id}.json`);
  writeJson(filePath, pending);
  return {
    ...pending,
    pendingPath: path.relative(groupPath, filePath).replaceAll("\\", "/")
  };
}

function rejectQueuedProposal(proposal, code, reason) {
  return {
    id: proposal.id,
    op: proposal.op,
    path: proposal.path,
    sourceIndex: proposal.sourceIndex,
    source_agent_id: proposal.source_agent_id,
    source_agent_name: proposal.source_agent_name,
    code,
    reason,
    content_summary: summarizeContent(proposal.content)
  };
}

function executionStandardsApproved(groupPath) {
  const manifestPath = path.join(groupPath, "shared", "harness", "standards.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.status === "approved";
  } catch {
    return false;
  }
}

function appendAuditLog(groupPath, record) {
  const filePath = auditLogPath(groupPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function auditRecord(action, item) {
  return {
    id: item.id,
    action,
    op: item.op,
    path: item.path,
    code: item.code,
    reason: item.reason,
    source_agent_id: item.source_agent_id,
    source_agent_name: item.source_agent_name,
    content_summary: item.content_summary || summarizeContent(item.content),
    createdAt: nowIso()
  };
}

function summarizeContent(content) {
  if (typeof content !== "string") return undefined;
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    redacted: true
  };
}

function pendingDir(groupPath) {
  return path.join(groupPath, "shared", "file-ops", "pending");
}

function pendingFilePath(groupPath, proposalId) {
  return path.join(pendingDir(groupPath), `${proposalId}.json`);
}

function auditLogPath(groupPath) {
  return path.join(groupPath, "shared", "logs", "file-ops.jsonl");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}

function requireId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing proposalId");
  return value.trim();
}
