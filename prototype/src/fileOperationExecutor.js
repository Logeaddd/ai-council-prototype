import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";
import { appendFileOperationAuditLog, readPendingFileOperationProposal, updatePendingFileOperationProposal } from "./fileOperationQueue.js";
import { nowIso } from "./types.js";

const WRITE_OPS = new Set(["write", "append"]);
const DANGEROUS_OPS = new Set(["delete"]);
const FRAMEWORK_STATE_FILES = [
  "approvals/execution-standards.user.approval.json",
  "shared/harness/execution-standard.md",
  "shared/harness/verification-standard.md",
  "shared/harness/standards.json",
  "shared/logs/file-ops.jsonl",
  "shared/logs/model-calls.jsonl",
  "shared/logs/workspace.log"
];

export function approvePendingFileOperation(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const proposal = readPendingFileOperationProposal(groupPath, options.proposalId);
  if (proposal.status !== "pending_user_approval") {
    throw new Error(`File operation ${proposal.id} is not pending user approval`);
  }
  const approved = {
    ...proposal,
    status: "approved",
    approvedBy: String(options.approvedBy || "user"),
    approvedAt: nowIso(),
    dangerousConfirmed: Boolean(options.dangerousConfirmed)
  };
  updatePendingFileOperationProposal(groupPath, approved);
  appendFileOperationAuditLog(groupPath, "approved", approved);
  return approved;
}

export function rejectPendingFileOperation(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const proposal = readPendingFileOperationProposal(groupPath, options.proposalId);
  if (proposal.status !== "pending_user_approval") {
    throw new Error(`File operation ${proposal.id} is not pending user approval`);
  }
  const rejected = {
    ...proposal,
    status: "rejected",
    rejectedBy: String(options.rejectedBy || "user"),
    rejectedAt: nowIso(),
    rejectReason: String(options.reason || "rejected by user")
  };
  updatePendingFileOperationProposal(groupPath, rejected);
  appendFileOperationAuditLog(groupPath, "rejected", rejected);
  return rejected;
}


export function autoApprovePendingFileOperation(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const proposal = readPendingFileOperationProposal(groupPath, options.proposalId);
  if (options.mode !== "full") throw new Error("Full mode is required for automatic approval");
  if (proposal.status !== "pending_user_approval") {
    throw new Error(`File operation ${proposal.id} is not pending user approval`);
  }
  const target = validateFileOperationPath(groupPath, proposal.path);
  const policy = autoApprovalPolicy(proposal, target.path, options);
  if (!policy.allowed) throw new Error(policy.reason);
  const approved = {
    ...proposal,
    status: "approved",
    approvedBy: String(options.approvedBy || "system:auto-full"),
    approvedAt: nowIso(),
    autoApproved: true,
    dangerousConfirmed: false
  };
  updatePendingFileOperationProposal(groupPath, approved);
  appendFileOperationAuditLog(groupPath, "auto_approved", approved);
  return approved;
}
export function executeApprovedFileOperation(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  assertGitRepository(groupPath);
  const proposal = readPendingFileOperationProposal(groupPath, options.proposalId);
  if (proposal.status !== "approved") throw new Error(`File operation ${proposal.id} is not approved`);
  assertNoUnrelatedDirtyFiles(groupPath, proposal);
  const target = validateFileOperationPath(groupPath, proposal.path);
  assertDangerousOperationConfirmed(proposal, target.path, options);

  const beforeExists = fs.existsSync(target.path);
  applyProposal(target.path, proposal);
  const verification = verifyApplied(target.path, proposal, beforeExists);
  const completed = {
    ...proposal,
    status: "executed",
    executedAt: nowIso(),
    verification
  };
  updatePendingFileOperationProposal(groupPath, completed);
  appendFileOperationAuditLog(groupPath, "executed", completed);
  const commitHash = commitExecutedProposal(groupPath, completed);
  return {
    ...completed,
    commitHash
  };
}


function autoApprovalPolicy(proposal, targetPath, options = {}) {
  if (!WRITE_OPS.has(proposal.op)) return { allowed: false, reason: "auto_approval_only_allows_write_or_append" };
  if (DANGEROUS_OPS.has(proposal.op)) return { allowed: false, reason: "delete_requires_explicit_confirmation" };
  if (proposal.op === "write" && fs.existsSync(targetPath)) {
    return { allowed: false, reason: "overwrite_requires_explicit_confirmation" };
  }
  const maxBatchSize = Number(options.maxBatchSize || 1);
  if (maxBatchSize > 1) return { allowed: false, reason: "bulk_requires_explicit_confirmation" };
  return { allowed: true };
}
function applyProposal(filePath, proposal) {
  if (proposal.op === "read" || proposal.op === "list") return;
  if (proposal.op === "write") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(proposal.content ?? ""), "utf8");
    return;
  }
  if (proposal.op === "append") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, String(proposal.content ?? ""), "utf8");
    return;
  }
  if (proposal.op === "delete") {
    fs.rmSync(filePath, { recursive: false, force: false });
    return;
  }
  throw new Error(`Unsupported executable file operation: ${proposal.op}`);
}

function verifyApplied(filePath, proposal, beforeExists) {
  if (proposal.op === "read" || proposal.op === "list") {
    return { ok: true, note: "No write operation executed." };
  }
  if (proposal.op === "delete") {
    return { ok: !fs.existsSync(filePath), beforeExists };
  }
  const exists = fs.existsSync(filePath);
  const size = exists ? fs.statSync(filePath).size : 0;
  return { ok: exists, beforeExists, size };
}

function assertDangerousOperationConfirmed(proposal, targetPath, options) {
  const overwrite = proposal.op === "write" && fs.existsSync(targetPath);
  const dangerous = DANGEROUS_OPS.has(proposal.op) || overwrite;
  if (!dangerous) return;
  if (proposal.dangerousConfirmed || options.dangerousConfirmed) return;
  const code = overwrite ? "overwrite_requires_confirmation" : "delete_requires_confirmation";
  throw new Error(code);
}

function assertGitRepository(groupPath) {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: groupPath, stdio: "pipe" });
  } catch {
    throw new Error("File operation execution requires a Git repository");
  }
}

function assertNoUnrelatedDirtyFiles(groupPath, proposal) {
  const porcelain = gitLines(groupPath, ["status", "--porcelain"]);
  const allowed = new Set([
    normalizeGitPath(proposal.path),
    ...pendingQueueFiles(groupPath).map(normalizeGitPath),
    ...FRAMEWORK_STATE_FILES.map(normalizeGitPath)
  ]);
  for (const line of porcelain) {
    const file = parsePorcelainPath(line);
    if (!file) continue;
    const files = expandGitStatusPath(groupPath, file);
    for (const expanded of files) {
      if (allowed.has(expanded) || isRuntimeStateFile(expanded)) continue;
      throw new Error(`Working tree has unrelated change: ${expanded}`);
    }
  }
}

function isRuntimeStateFile(file) {
  return file.startsWith("_supervisor/")
    || file.startsWith("sessions/")
    || file.startsWith("shared/logs/")
    || file.startsWith("shared/cache/")
    || file === "shared/task_state.json";
}

function expandGitStatusPath(groupPath, file) {
  const normalized = normalizeGitPath(file);
  const absolute = path.join(groupPath, normalized);
  if (!normalized.endsWith("/") || !fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    return [normalized];
  }
  return listFilesRecursive(absolute)
    .map((item) => normalizeGitPath(path.relative(groupPath, item)))
    .sort();
}

function listFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(filePath) : [filePath];
  });
}

function pendingQueueFiles(groupPath) {
  const dir = path.join(groupPath, "shared", "file-ops", "pending");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => `shared/file-ops/pending/${file}`);
}
function commitExecutedProposal(groupPath, proposal) {
  const files = commitFileList(groupPath, proposal);
  execFileSync("git", ["add", "--", ...files], { cwd: groupPath, stdio: "pipe" });
  const message = commitMessage(groupPath, proposal);
  execFileSync("git", ["commit", "-m", message.title, "-m", message.body], { cwd: groupPath, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: groupPath, encoding: "utf8" }).trim();
}

function commitFileList(groupPath, proposal) {
  return [
    proposal.path,
    ...frameworkStateFilesForProposal(proposal).filter((file) => fs.existsSync(path.join(groupPath, file)))
  ];
}

function frameworkStateFilesForProposal(proposal) {
  return [
    `shared/file-ops/pending/${proposal.id}.json`,
    ...FRAMEWORK_STATE_FILES
  ];
}

function commitMessage(groupPath, proposal) {
  return {
    title: `files: apply ${proposal.op} ${proposal.path}`,
    body: [
      "Add:",
      proposal.op === "write" ? `- ${proposal.path}` : "- none",
      "",
      "Change:",
      proposal.op === "append" ? `- append to ${proposal.path}` : "- none",
      "",
      "Remove:",
      proposal.op === "delete" ? `- ${proposal.path}` : "- none",
      "",
      "Files:",
      `- ${proposal.path}`,
      ...commitFileList(groupPath, proposal).slice(1).map((file) => `- ${file}`),
      "",
      "Reason:",
      `- ${proposal.reason || "approved file operation"}`,
      "",
      "Limits:",
      "- generated from an approved pending file operation",
      "- rollback with git revert, not reset --hard"
    ].join("\n")
  };
}

function gitLines(cwd, args) {
  const text = execFileSync("git", args, { cwd, encoding: "utf8" });
  return text.split(/\r?\n/).filter(Boolean);
}

function parsePorcelainPath(line) {
  const text = String(line || "");
  const raw = text.slice(3).trim();
  if (!raw) return "";
  const renameIndex = raw.indexOf(" -> ");
  return normalizeGitPath(renameIndex >= 0 ? raw.slice(renameIndex + 4) : raw.replace(/^"|"$/g, ""));
}

function normalizeGitPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}
