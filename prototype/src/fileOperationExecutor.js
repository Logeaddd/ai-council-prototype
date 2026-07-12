import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";
import { appendFileOperationAuditLog, readPendingFileOperationProposal, updatePendingFileOperationProposal } from "./fileOperationQueue.js";
import { nowIso } from "./types.js";
import {
  createDeletionBackup,
  readVerifiedBackupContent,
  recoverySummary,
  updateDeletionBackup
} from "./fileRecovery.js";

const WRITE_OPS = new Set(["write", "append"]);
const DANGEROUS_OPS = new Set(["delete"]);
const AUTO_APPROVAL_OPS = new Set(["write", "append", "delete"]);
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
  const autoDangerous = isDangerousProposal(proposal, target.path);
  const approved = {
    ...proposal,
    status: "approved",
    approvedBy: String(options.approvedBy || "system:auto-full"),
    approvedAt: nowIso(),
    autoApproved: true,
    dangerousConfirmed: autoDangerous
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
  if (!options.allowUnrelatedDirtyFiles) assertNoUnrelatedDirtyFiles(groupPath, proposal);
  const target = validateFileOperationPath(groupPath, proposal.path);
  assertDangerousOperationConfirmed(proposal, target.path, options);

  const beforeExists = fs.existsSync(target.path);
  const beforeContent = beforeExists && WRITE_OPS.has(proposal.op) ? fs.readFileSync(target.path) : undefined;
  let recovery;
  if (proposal.op === "delete") {
    let backup;
    try {
      backup = createDeletionBackup({
        groupPath,
        proposalId: proposal.id,
        sourcePath: proposal.path,
        sourceAbsolutePath: target.path,
        maxBackupBytes: options.maxBackupBytes,
        maxTotalBytes: options.maxRecoveryBytes,
        maxBackups: options.maxRecoveryBackups
      });
    } catch (error) {
      appendFileOperationAuditLog(groupPath, "delete_backup_failed", {
        ...proposal,
        code: error.code || "delete_backup_failed",
        reason: String(error.message || "delete_backup_failed")
      });
      throw error;
    }
    recovery = recoverySummary(backup);
    const prepared = { ...proposal, recovery };
    updatePendingFileOperationProposal(groupPath, prepared);
    appendFileOperationAuditLog(groupPath, "delete_backup_prepared", prepared);
    const currentContent = fs.readFileSync(target.path);
    if (currentContent.length !== recovery.sizeBytes || sha256(currentContent) !== recovery.sha256) {
      const changed = {
        ...prepared,
        code: "delete_source_changed_after_backup",
        reason: "The source file changed after backup; deletion was stopped."
      };
      appendFileOperationAuditLog(groupPath, "delete_source_changed_after_backup", changed);
      throw new Error(changed.code);
    }
  }
  applyProposal(target.path, proposal);
  const verification = verifyApplied(target.path, proposal, { beforeExists, beforeContent });
  if (!verification.ok) {
    restoreBeforeFailedWrite(target.path, proposal, { beforeExists, beforeContent });
    appendFileOperationAuditLog(groupPath, "execution_verification_failed", {
      ...proposal,
      code: "file_write_verification_failed",
      reason: "The file operation did not produce the requested non-empty byte change.",
      verification
    });
    throw new Error("file_write_verification_failed");
  }
  if (proposal.op === "delete") {
    const deletedBackup = updateDeletionBackup(groupPath, proposal.id, {
      status: "deleted",
      deletedAt: nowIso()
    });
    recovery = recoverySummary(deletedBackup);
  }
  const completed = {
    ...proposal,
    status: "executed",
    executedAt: nowIso(),
    verification,
    ...(recovery ? { recovery } : {})
  };
  updatePendingFileOperationProposal(groupPath, completed);
  appendFileOperationAuditLog(groupPath, "executed", completed);
  const commitHash = commitExecutedProposal(groupPath, completed);
  if (recovery) {
    const committedBackup = updateDeletionBackup(groupPath, proposal.id, { deleteCommitHash: commitHash });
    recovery = recoverySummary(committedBackup);
  }
  return {
    ...completed,
    ...(recovery ? { recovery } : {}),
    commitHash
  };
}

export function restoreDeletedFileOperation(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  assertGitRepository(groupPath);
  const proposal = readPendingFileOperationProposal(groupPath, options.proposalId);
  if (proposal.op !== "delete") throw new Error(`File operation ${proposal.id} is not a deletion`);
  if (!proposal.recovery?.backupId) throw new Error(`File operation ${proposal.id} has no delete backup`);
  if (!options.confirmed) throw new Error("restore_requires_confirmation");
  if (proposal.status === "restored") throw new Error(`File operation ${proposal.id} is already restored`);
  assertNoUnrelatedDirtyFiles(groupPath, proposal);
  const target = validateFileOperationPath(groupPath, proposal.path);
  const interruptedDeletion = proposal.status === "approved"
    && ["prepared", "deleted"].includes(proposal.recovery.status)
    && !fs.existsSync(target.path);
  if (proposal.status !== "executed" && !interruptedDeletion) {
    throw new Error(`File operation ${proposal.id} has not completed deletion`);
  }
  if (fs.existsSync(target.path)) throw new Error("restore_target_exists");
  const { record, content } = readVerifiedBackupContent(groupPath, proposal.recovery.backupId);
  if (record.sourcePath !== proposal.path || record.proposalId !== proposal.id) {
    throw new Error("restore_backup_source_mismatch");
  }

  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, content, { flag: "wx" });
  let verification;
  try {
    if (Number.isInteger(record.sourceMode)) fs.chmodSync(target.path, record.sourceMode);
    const restoredContent = fs.readFileSync(target.path);
    verification = {
      ok: restoredContent.length === record.sizeBytes && sha256(restoredContent) === record.sha256,
      sizeBytes: restoredContent.length,
      sha256: sha256(restoredContent),
      expectedSizeBytes: record.sizeBytes,
      expectedSha256: record.sha256
    };
    if (!verification.ok) throw new Error("restore_verification_failed");
  } catch (error) {
    fs.rmSync(target.path, { force: true });
    appendFileOperationAuditLog(groupPath, "restore_failed", {
      ...proposal,
      code: "restore_failed",
      reason: String(error.message || "restore_failed")
    });
    throw error;
  }

  const restoredBackup = updateDeletionBackup(groupPath, record.backupId, {
    status: "restored",
    restoredAt: nowIso(),
    restoredBy: String(options.restoredBy || "user")
  });
  const restored = {
    ...proposal,
    status: "restored",
    restoredAt: restoredBackup.restoredAt,
    restoredBy: restoredBackup.restoredBy,
    verification,
    recovery: recoverySummary(restoredBackup)
  };
  updatePendingFileOperationProposal(groupPath, restored);
  appendFileOperationAuditLog(groupPath, "restored", restored);
  const commitHash = commitRestoredProposal(groupPath, restored);
  const committedBackup = updateDeletionBackup(groupPath, record.backupId, { restoreCommitHash: commitHash });
  return { ...restored, recovery: recoverySummary(committedBackup), commitHash };
}


function autoApprovalPolicy(proposal, targetPath, options = {}) {
  if (!AUTO_APPROVAL_OPS.has(proposal.op)) return { allowed: false, reason: `auto_approval_unsupported_op:${proposal.op}` };
  const maxBatchSize = Number(options.maxBatchSize || 1);
  if (!Number.isFinite(maxBatchSize) || maxBatchSize < 1) return { allowed: false, reason: "invalid_auto_batch_size" };
  return { allowed: true };
}
function applyProposal(filePath, proposal) {
  if (proposal.op === "read" || proposal.op === "list") return;
  if (proposal.op === "write") {
    const content = String(proposal.content ?? "");
    if (Buffer.byteLength(content, "utf8") === 0) throw new Error("empty_content");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return;
  }
  if (proposal.op === "append") {
    const content = String(proposal.content ?? "");
    if (Buffer.byteLength(content, "utf8") === 0) throw new Error("empty_content");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, content, "utf8");
    return;
  }
  if (proposal.op === "delete") {
    fs.rmSync(filePath, { recursive: false, force: false });
    return;
  }
  throw new Error(`Unsupported executable file operation: ${proposal.op}`);
}

function restoreBeforeFailedWrite(filePath, proposal, before = {}) {
  if (!WRITE_OPS.has(proposal.op)) return;
  if (before.beforeExists && Buffer.isBuffer(before.beforeContent)) {
    fs.writeFileSync(filePath, before.beforeContent);
    return;
  }
  fs.rmSync(filePath, { force: true });
}

function verifyApplied(filePath, proposal, before = {}) {
  const beforeExists = Boolean(before.beforeExists);
  if (proposal.op === "read" || proposal.op === "list") {
    return { ok: true, note: "No write operation executed." };
  }
  if (proposal.op === "delete") {
    return { ok: !fs.existsSync(filePath), beforeExists };
  }
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath) : Buffer.alloc(0);
  const expectedContent = Buffer.from(String(proposal.content ?? ""), "utf8");
  const expected = proposal.op === "append"
    ? Buffer.concat([before.beforeContent || Buffer.alloc(0), expectedContent])
    : expectedContent;
  const changed = !beforeExists || !Buffer.isBuffer(before.beforeContent) || !before.beforeContent.equals(content);
  return {
    ok: exists && expectedContent.length > 0 && content.equals(expected),
    changed,
    beforeExists,
    beforeSize: before.beforeContent?.length || 0,
    size: content.length,
    sha256: sha256(content),
    expectedSha256: sha256(expected)
  };
}

function assertDangerousOperationConfirmed(proposal, targetPath, options) {
  const overwrite = proposal.op === "write" && fs.existsSync(targetPath);
  const dangerous = isDangerousProposal(proposal, targetPath);
  if (!dangerous) return;
  if (proposal.dangerousConfirmed || options.dangerousConfirmed) return;
  const code = overwrite ? "overwrite_requires_confirmation" : "delete_requires_confirmation";
  throw new Error(code);
}

function isDangerousProposal(proposal, targetPath) {
  return DANGEROUS_OPS.has(proposal.op) || (proposal.op === "write" && fs.existsSync(targetPath));
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
  const normalized = normalizeGitPath(file);
  const parts = normalized.split("/").filter(Boolean);
  const isMemberPrivateMemory = parts[0] === "members" && parts.includes("private_memory");
  return normalized.startsWith("_supervisor/")
    || normalized.startsWith("sessions/")
    || normalized.startsWith("shared/file-ops/recovery/")
    || normalized.startsWith("shared/logs/")
    || normalized.startsWith("shared/cache/")
    || normalized.startsWith("shared/usage/")
    || normalized === "shared/task_state.json"
    || isMemberPrivateMemory;
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

function commitRestoredProposal(groupPath, proposal) {
  const files = commitFileList(groupPath, proposal);
  execFileSync("git", ["add", "--", ...files], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", [
    "commit",
    "-m", `files: restore ${proposal.path}`,
    "-m", [
      "Add:",
      `- ${proposal.path}`,
      "",
      "Change:",
      `- shared/file-ops/pending/${proposal.id}.json`,
      "- shared/logs/file-ops.jsonl",
      "",
      "Remove:",
      "- none",
      "",
      "Limits:",
      "- restored from a verified internal delete backup",
      "- recovery content remains outside Git and ordinary file tools"
    ].join("\n")
  ], { cwd: groupPath, stdio: "pipe" });
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

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}
