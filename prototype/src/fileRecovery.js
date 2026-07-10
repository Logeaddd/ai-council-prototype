import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";
import { nowIso } from "./types.js";

const SCHEMA = "ai-council.file-recovery.v1";
const DEFAULT_MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 200;

export function createDeletionBackup(options = {}) {
  const groupPath = requirePath(options.groupPath, "groupPath");
  const proposalId = requireId(options.proposalId);
  const sourcePath = requireRelativePath(options.sourcePath);
  const sourceAbsolutePath = requirePath(options.sourceAbsolutePath, "sourceAbsolutePath");
  const guardedSource = validateFileOperationPath(groupPath, sourcePath);
  const actualSource = fs.realpathSync.native(sourceAbsolutePath);
  if (guardedSource.path !== actualSource) {
    throw recoveryError("delete_backup_source_mismatch", "Delete backup source does not match the guarded workspace path.");
  }
  const stat = fs.statSync(sourceAbsolutePath);
  if (!stat.isFile()) throw recoveryError("delete_backup_requires_file", "Only regular files can be backed up for deletion.");

  const maxBackupBytes = lowerBoundedLimit(options.maxBackupBytes, DEFAULT_MAX_BACKUP_BYTES);
  const maxTotalBytes = lowerBoundedLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const maxBackups = lowerBoundedLimit(options.maxBackups, DEFAULT_MAX_BACKUPS);
  if (stat.size > maxBackupBytes) {
    throw recoveryError("delete_backup_too_large", `Delete backup exceeds ${maxBackupBytes} bytes.`);
  }
  ensureRecoveryExcludedFromGit(groupPath);
  const backupId = proposalId;
  const directory = backupDirectory(groupPath, backupId);
  if (fs.existsSync(directory)) {
    const existing = readVerifiedBackupContent(groupPath, backupId);
    const current = fs.readFileSync(sourceAbsolutePath);
    if (existing.record.sourcePath !== sourcePath || existing.content.length !== current.length || hash(current) !== existing.record.sha256) {
      throw recoveryError("delete_source_changed_after_backup", "The source file changed after its delete backup was created.");
    }
    return existing.record;
  }

  const usage = recoveryUsage(groupPath);
  if (usage.count + 1 > maxBackups || usage.bytes + stat.size > maxTotalBytes) {
    throw recoveryError("delete_recovery_capacity_exceeded", "Delete recovery storage is full; the file was not deleted.");
  }

  const content = fs.readFileSync(sourceAbsolutePath);
  const sha256 = hash(content);
  const relativeDirectory = normalizeRelative(groupPath, directory);
  const backupPath = `${relativeDirectory}/content.bin`;
  const metadataPath = `${relativeDirectory}/record.json`;
  const record = {
    schema: SCHEMA,
    backupId,
    proposalId,
    status: "prepared",
    sourcePath,
    backupPath,
    metadataPath,
    sizeBytes: content.length,
    sha256,
    sourceMode: stat.mode,
    sourceModifiedAt: stat.mtime.toISOString(),
    backedUpAt: nowIso()
  };

  try {
    fs.mkdirSync(recoveryRoot(groupPath), { recursive: true });
    fs.mkdirSync(directory, { recursive: false });
    const temporaryPath = path.join(directory, "content.tmp");
    fs.writeFileSync(temporaryPath, content, { flag: "wx" });
    fs.renameSync(temporaryPath, path.join(directory, "content.bin"));
    writeRecord(groupPath, record);
    verifyBackup(groupPath, record);
    return record;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (error?.code && String(error.code).startsWith("delete_")) throw error;
    throw recoveryError("delete_backup_failed", error.message || "Delete backup failed.");
  }
}

export function readDeletionBackup(groupPath, backupId) {
  const root = requirePath(groupPath, "groupPath");
  const id = requireId(backupId);
  const filePath = path.join(backupDirectory(root, id), "record.json");
  if (!fs.existsSync(filePath)) throw recoveryError("delete_backup_not_found", `Unknown delete backup: ${id}`);
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  validateRecord(root, id, record);
  return record;
}

export function updateDeletionBackup(groupPath, backupId, patch = {}) {
  const current = readDeletionBackup(groupPath, backupId);
  const next = {
    ...current,
    ...patch,
    schema: SCHEMA,
    backupId: current.backupId,
    proposalId: current.proposalId,
    sourcePath: current.sourcePath,
    backupPath: current.backupPath,
    metadataPath: current.metadataPath,
    sizeBytes: current.sizeBytes,
    sha256: current.sha256,
    updatedAt: nowIso()
  };
  writeRecord(groupPath, next);
  return next;
}

export function readVerifiedBackupContent(groupPath, backupId) {
  const record = readDeletionBackup(groupPath, backupId);
  const content = fs.readFileSync(resolveRecoveryPath(groupPath, record.backupPath));
  if (content.length !== record.sizeBytes) {
    throw recoveryError("delete_backup_size_mismatch", "Delete backup size does not match its record.");
  }
  if (hash(content) !== record.sha256) {
    throw recoveryError("delete_backup_hash_mismatch", "Delete backup hash does not match its record.");
  }
  return { record, content };
}

export function recoverySummary(record = {}) {
  return {
    backupId: record.backupId,
    status: record.status,
    sourcePath: record.sourcePath,
    backupPath: record.backupPath,
    metadataPath: record.metadataPath,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    backedUpAt: record.backedUpAt,
    deletedAt: record.deletedAt,
    restoredAt: record.restoredAt,
    deleteCommitHash: record.deleteCommitHash,
    restoreCommitHash: record.restoreCommitHash
  };
}

function verifyBackup(groupPath, record) {
  readVerifiedBackupContent(groupPath, record.backupId);
}

function validateRecord(groupPath, backupId, record) {
  if (record?.schema !== SCHEMA || record.backupId !== backupId || record.proposalId !== backupId) {
    throw recoveryError("delete_backup_record_invalid", "Delete backup record is invalid.");
  }
  requireRelativePath(record.sourcePath);
  const expectedDirectory = normalizeRelative(groupPath, backupDirectory(groupPath, backupId));
  if (record.backupPath !== `${expectedDirectory}/content.bin` || record.metadataPath !== `${expectedDirectory}/record.json`) {
    throw recoveryError("delete_backup_record_invalid", "Delete backup paths do not match the guarded recovery location.");
  }
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ""))) {
    throw recoveryError("delete_backup_record_invalid", "Delete backup size or hash is invalid.");
  }
}

function writeRecord(groupPath, record) {
  const filePath = resolveRecoveryPath(groupPath, record.metadataPath);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function resolveRecoveryPath(groupPath, relativePath) {
  const root = recoveryRoot(groupPath);
  const candidate = path.resolve(groupPath, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw recoveryError("delete_backup_path_escape", "Delete backup path escapes the internal recovery directory.");
  }
  return candidate;
}

function recoveryUsage(groupPath) {
  const root = recoveryRoot(groupPath);
  if (!fs.existsSync(root)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contentPath = path.join(root, entry.name, "content.bin");
    if (!fs.existsSync(contentPath)) continue;
    count += 1;
    bytes += fs.statSync(contentPath).size;
  }
  return { count, bytes };
}

function ensureRecoveryExcludedFromGit(groupPath) {
  const gitDirectory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
    cwd: groupPath,
    encoding: "utf8"
  }).trim();
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: groupPath,
    encoding: "utf8"
  }).trim();
  const excludePath = path.join(gitDirectory, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const groupRelative = path.relative(path.resolve(gitRoot), path.resolve(groupPath)).replaceAll("\\", "/").replace(/^\.\/?$/, "");
  const rule = `/${groupRelative ? `${groupRelative}/` : ""}shared/file-ops/recovery/`;
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (current.split(/\r?\n/).includes(rule)) return;
  fs.appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`, "utf8");
}

function backupDirectory(groupPath, backupId) {
  return path.join(recoveryRoot(groupPath), requireId(backupId));
}

function recoveryRoot(groupPath) {
  return path.join(requirePath(groupPath, "groupPath"), "shared", "file-ops", "recovery");
}

function normalizeRelative(groupPath, candidate) {
  return path.relative(groupPath, candidate).replaceAll("\\", "/");
}

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function lowerBoundedLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(fallback, Math.floor(number));
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return path.resolve(value);
}

function requireRelativePath(value) {
  const text = String(value || "").trim().replaceAll("\\", "/");
  if (!text || path.isAbsolute(text) || text === "." || text.split("/").includes("..")) {
    throw recoveryError("delete_backup_source_invalid", "Delete backup source path must stay inside the workspace.");
  }
  return text;
}

function requireId(value) {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(text)) throw recoveryError("delete_backup_id_invalid", "Delete backup id is invalid.");
  return text;
}

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
