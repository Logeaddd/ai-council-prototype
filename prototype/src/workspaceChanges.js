import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_CHANGES = 1000;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".gradle",
  ".next",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv"
]);
const INTERNAL_ROOT_DIRS = new Set(["members", "sessions", "approvals", "_supervisor"]);
const INTERNAL_SHARED_DIRS = new Set(["logs", "cache", "usage", "memory", "memory_pending", "inbox", "environments", "file-ops", "harness"]);
const INTERNAL_ROOT_FILES = new Set(["group.json"]);
const INTERNAL_SHARED_FILES = new Set(["task_state.json"]);
const ARTIFACT_EXTENSIONS = new Set([".exe", ".msi", ".jar", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".whl", ".deb", ".rpm", ".dmg", ".appimage", ".apk", ".aab", ".ipa", ".dll", ".so", ".dylib", ".wasm", ".pdf", ".docx", ".pptx", ".xlsx"]);

export function captureWorkspaceSnapshot(groupRoot, options = {}) {
  const startedAtMs = Date.now();
  const root = fs.realpathSync.native(groupRoot);
  const maxEntries = clampInteger(options.maxEntries, 100, 100000, DEFAULT_MAX_ENTRIES);
  const entries = new Map();
  const stack = [root];
  let scannedEntries = 0;
  let ignoredEntries = 0;
  let errorCount = 0;
  let truncated = false;

  while (stack.length && !truncated) {
    const directory = stack.pop();
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      errorCount += 1;
      continue;
    }
    for (const child of children) {
      const relativePath = path.relative(root, path.join(directory, child.name)).replaceAll("\\", "/");
      if (shouldIgnoreWorkspaceEntry(relativePath, child)) {
        ignoredEntries += 1;
        continue;
      }
      if (scannedEntries >= maxEntries) {
        truncated = true;
        break;
      }
      scannedEntries += 1;
      const absolutePath = path.join(directory, child.name);
      let stat;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch {
        errorCount += 1;
        continue;
      }
      if (child.isDirectory() && !child.isSymbolicLink()) stack.push(absolutePath);
      const metadata = snapshotMetadata(relativePath, stat);
      entries.set(relativePathKey(relativePath), metadata);
    }
  }

  return {
    source: "bounded_workspace_metadata_snapshot",
    root,
    entries,
    scannedEntries,
    ignoredEntries,
    errorCount,
    maxEntries,
    truncated,
    complete: !truncated && errorCount === 0,
    durationMs: Date.now() - startedAtMs
  };
}

export function diffWorkspaceSnapshots(before, after, options = {}) {
  const maxChanges = clampInteger(options.maxChanges, 10, 5000, DEFAULT_MAX_CHANGES);
  const created = [];
  const modified = [];
  const deleted = [];
  const beforeEntries = before?.entries instanceof Map ? before.entries : new Map();
  const afterEntries = after?.entries instanceof Map ? after.entries : new Map();

  for (const [key, current] of afterEntries) {
    const previous = beforeEntries.get(key);
    if (!previous) {
      created.push(changeRecord("created", current, undefined, Boolean(before?.complete)));
      continue;
    }
    if (metadataChanged(previous, current)) {
      modified.push(changeRecord("modified", current, previous, true));
    }
  }
  for (const [key, previous] of beforeEntries) {
    if (!afterEntries.has(key)) deleted.push(changeRecord("deleted", previous, previous, Boolean(after?.complete)));
  }

  const all = [...created, ...modified, ...deleted]
    .sort(compareWorkspaceChange);
  const kept = all.slice(0, maxChanges);
  const byChange = (change) => kept.filter((item) => item.change === change);
  const allObservedArtifacts = [...afterEntries.values()]
    .filter((item) => item.type === "file" && ARTIFACT_EXTENSIONS.has(path.extname(item.path).toLowerCase()))
    .sort((a, b) => a.path.localeCompare(b.path));
  const maxObservedArtifacts = Math.min(500, maxChanges);
  const observedArtifacts = allObservedArtifacts
    .slice(0, maxObservedArtifacts)
    .map((item) => ({
      path: item.path,
      type: item.type,
      sizeBytes: item.sizeBytes,
      modifiedAt: new Date(item.modifiedMs).toISOString(),
      reliable: Boolean(after?.complete)
    }));
  return {
    source: "bounded_workspace_snapshot_diff",
    status: "completed",
    complete: Boolean(before?.complete && after?.complete && all.length <= maxChanges),
    before: snapshotSummary(before),
    after: snapshotSummary(after),
    created: byChange("created"),
    modified: byChange("modified"),
    deleted: byChange("deleted"),
    observedArtifacts,
    observedArtifactsComplete: Boolean(after?.complete && allObservedArtifacts.length <= maxObservedArtifacts),
    observedArtifactsOmitted: Math.max(0, allObservedArtifacts.length - observedArtifacts.length),
    totalChanges: all.length,
    keptChanges: kept.length,
    omittedChanges: Math.max(0, all.length - kept.length),
    maxChanges
  };
}

export function backgroundWorkspaceChanges() {
  return {
    source: "bounded_workspace_snapshot_diff",
    status: "not_observed_background",
    complete: false,
    created: [],
    modified: [],
    deleted: [],
    observedArtifacts: [],
    observedArtifactsComplete: false,
    observedArtifactsOmitted: 0,
    totalChanges: 0,
    keptChanges: 0,
    omittedChanges: 0,
    reason: "Background process completion was not observed, so no after-command workspace snapshot was taken."
  };
}

function snapshotMetadata(relativePath, stat) {
  return {
    path: relativePath,
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
    sizeBytes: stat.size,
    modifiedMs: stat.mtimeMs,
    changedMs: stat.ctimeMs
  };
}

function metadataChanged(a, b) {
  if (a.type === "directory" && b.type === "directory") return false;
  return a.type !== b.type
    || a.sizeBytes !== b.sizeBytes
    || a.modifiedMs !== b.modifiedMs
    || a.changedMs !== b.changedMs;
}

function changeRecord(change, current, previous, reliable) {
  const record = {
    path: current.path,
    change,
    type: current.type,
    reliable
  };
  if (change !== "deleted") {
    record.sizeBytes = current.sizeBytes;
    record.modifiedAt = new Date(current.modifiedMs).toISOString();
  }
  if (previous && change === "modified") {
    record.previousSizeBytes = previous.sizeBytes;
    record.previousModifiedAt = new Date(previous.modifiedMs).toISOString();
  }
  return record;
}

function snapshotSummary(snapshot = {}) {
  return {
    scannedEntries: Number(snapshot.scannedEntries || 0),
    ignoredEntries: Number(snapshot.ignoredEntries || 0),
    errorCount: Number(snapshot.errorCount || 0),
    maxEntries: Number(snapshot.maxEntries || 0),
    durationMs: Number(snapshot.durationMs || 0),
    truncated: Boolean(snapshot.truncated),
    complete: Boolean(snapshot.complete)
  };
}

function compareWorkspaceChange(a, b) {
  const artifactDifference = Number(isLikelyArtifact(b)) - Number(isLikelyArtifact(a));
  if (artifactDifference) return artifactDifference;
  const fileDifference = Number(b.type === "file") - Number(a.type === "file");
  if (fileDifference) return fileDifference;
  return a.path.localeCompare(b.path) || a.change.localeCompare(b.change);
}

function isLikelyArtifact(item) {
  if (item.type !== "file" || item.change === "deleted") return false;
  return ARTIFACT_EXTENSIONS.has(path.extname(item.path).toLowerCase());
}

function shouldIgnoreWorkspaceEntry(relativePath, dirent) {
  const parts = String(relativePath || "").split("/").filter(Boolean);
  const lowerParts = parts.map((item) => item.toLowerCase());
  const basename = lowerParts.at(-1) || "";
  if (parts.length === 1 && INTERNAL_ROOT_FILES.has(basename)) return true;
  if (parts.length === 1 && dirent.isDirectory() && INTERNAL_ROOT_DIRS.has(basename)) return true;
  if (lowerParts[0] === "shared" && parts.length === 2 && dirent.isDirectory() && INTERNAL_SHARED_DIRS.has(basename)) return true;
  if (lowerParts[0] === "shared" && parts.length === 2 && INTERNAL_SHARED_FILES.has(basename)) return true;
  if (dirent.isDirectory() && SKIP_DIRS.has(basename)) return true;
  return isSecretBasename(basename) || [".pem", ".key", ".p12", ".pfx"].includes(path.extname(basename));
}

function isSecretBasename(base) {
  return base === ".env"
    || base.startsWith(".env.")
    || base === "credentials"
    || base === "credentials.json"
    || base.startsWith("credentials.")
    || base === "id_rsa"
    || base === "id_dsa"
    || base === "id_ecdsa"
    || base === "id_ed25519";
}

function relativePathKey(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
