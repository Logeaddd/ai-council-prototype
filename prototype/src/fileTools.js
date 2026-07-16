import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";

const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 120;
const DEFAULT_MAX_SEARCH_RESULTS = 80;
const DEFAULT_MAX_GREP_RESULTS = 80;
const DEFAULT_MAX_SCAN_FILES = 3000;
const DEFAULT_MAX_GREP_FILE_BYTES = 256 * 1024;

const SCAN_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".idea",
  ".vscode",
  "node_modules",
  "file-ops",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "__pycache__"
]);
const HIDDEN_LISTING_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".idea",
  ".vscode",
  "node_modules",
  "__pycache__"
]);
const DIRECT_FORBIDDEN_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "__pycache__"
]);
const INTERNAL_WORKSPACE_SEGMENTS = new Set(["members", "sessions", "approvals"]);
const INTERNAL_SHARED_SEGMENTS = new Set(["logs", "memory", "memory_pending", "inbox", "file-ops"]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx",
  ".css", ".scss", ".html", ".htm", ".xml", ".yaml", ".yml", ".py", ".java",
  ".kt", ".kts", ".gradle", ".groovy",
  ".c", ".cpp", ".cs", ".go", ".rs", ".php", ".rb", ".sh", ".ps1", ".sql",
  ".csv", ".toml", ".properties", ".mcmeta", ".mcfunction", ".lang"
]);

export function executeFileTool(request, options = {}) {
  const roots = allowedRoots(options);
  if (!roots.length) throw toolError("missing_workspace", "No allowed workspace root is configured.");

  if (request.tool === "list_directory") return listDirectory(request, roots, options);
  if (request.tool === "read_file") return readFile(request, roots, options);
  if (request.tool === "search_files") return searchFiles(request, roots, options);
  if (request.tool === "grep_content") return grepContent(request, roots, options);
  throw toolError("invalid_file_tool", `Unsupported file tool: ${request.tool}`);
}

export function extractImportedProjectRoots(attachments = []) {
  const roots = [];
  for (const attachment of attachments) {
    const content = typeof attachment?.content === "string" ? attachment.content : "";
    for (const line of content.split(/\r?\n/).slice(0, 8)) {
      const match = line.match(/^Project (?:import from|root):\s*(.+)$/i);
      if (!match) continue;
      const value = match[1].trim();
      if (value && fs.existsSync(value)) roots.push(value);
    }
  }
  return [...new Set(roots.map((root) => safeRealpath(root)).filter(Boolean))];
}

export function extractUserReferencedRoots({ text = "", attachments = [] } = {}) {
  const sources = [String(text || "")];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment?.localPath) sources.push(String(attachment.localPath));
    if (typeof attachment?.content === "string") sources.push(attachment.content);
  }
  const roots = [];
  for (const source of sources) {
    for (const candidate of extractAbsolutePathCandidates(source)) {
      const existing = existingLocalPath(candidate);
      if (!existing) continue;
      try {
        const stat = fs.statSync(existing);
        roots.push(stat.isDirectory() ? existing : path.dirname(existing));
      } catch {}
    }
  }
  return [...new Set(roots.map((root) => safeRealpath(root)).filter(Boolean))];
}

function extractAbsolutePathCandidates(value) {
  const text = String(value || "");
  const candidates = [];
  const patterns = [
    /\]\(([A-Za-z]:[\\/][^)\r\n]+)\)/g,
    /\]\((\/[^)\r\n]+)\)/g,
    /`([^`\r\n]*[A-Za-z]:[\\/][^`\r\n]+)`/g,
    /`(\/[^`\r\n]+)`/g,
    /"([A-Za-z]:[\\/][^"\r\n]+)"/g,
    /"(\/[^"\r\n]+)"/g,
    /'([A-Za-z]:[\\/][^'\r\n]+)'/g,
    /(?:^|\r?\n)\s*([A-Za-z]:[\\/][^\r\n]+?)\s*(?=\r?\n|$)/g,
    /(?:^|\s)([A-Za-z]:[\\/][^\s<>{}|"`]+)(?=\s|$)/g,
    /(?:^|\s)(\/[^\s<>{}|"`]+)(?=\s|$)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = cleanAbsolutePathCandidate(match[1]);
      if (candidate) candidates.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

function cleanAbsolutePathCandidate(value) {
  let candidate = String(value || "").trim();
  try {
    candidate = decodeURIComponent(candidate.replace(/^file:\/\//i, ""));
  } catch {}
  candidate = candidate.replace(/[),.;，。；：！？]+$/u, "").trim();
  return path.isAbsolute(candidate) ? candidate : "";
}

function existingLocalPath(value) {
  let candidate = String(value || "").trim();
  while (candidate && path.isAbsolute(candidate)) {
    if (fs.existsSync(candidate)) return fs.realpathSync.native(candidate);
    const trimmed = candidate.replace(/[\s),.;，。；：！？]+$/u, "").trim();
    if (trimmed !== candidate) {
      candidate = trimmed;
      continue;
    }
    const parent = path.dirname(candidate);
    if (!parent || parent === candidate || parent === path.parse(candidate).root) break;
    candidate = parent;
  }
  return "";
}

function listDirectory(request, roots, options) {
  const target = resolveTarget(request.path || ".", roots, { rootHint: request.root });
  const stat = fs.statSync(target.path);
  if (!stat.isDirectory()) throw toolError("not_a_directory", "Target path is not a directory.");
  const all = fs.readdirSync(target.path, { withFileTypes: true })
    .filter((entry) => !isForbiddenName(entry.name) && !isInternalListingName(target, entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const limit = clampNumber(options.maxListEntries || request.count, DEFAULT_MAX_LIST_ENTRIES, 1, 500);
  return {
    ok: true,
    source: "local_file_tool",
    root: target.rootLabel,
    path: target.relativePath || ".",
    entries: all.slice(0, limit).map((entry) => ({
      name: entry.name,
      path: joinRelative(target.relativePath, entry.name),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    })),
    truncated: all.length > limit
  };
}

function readFile(request, roots, options) {
  const target = resolveTarget(request.path, roots, { rootHint: request.root });
  const stat = fs.statSync(target.path);
  if (!stat.isFile()) throw toolError("not_a_file", "Target path is not a file.");
  assertReadableTextFile(target.path, stat);
  const maxBytes = clampNumber(options.maxReadBytes || request.maxBytes, DEFAULT_MAX_READ_BYTES, 1024, 512 * 1024);
  const buffer = fs.readFileSync(target.path);
  if (buffer.includes(0)) throw toolError("binary_file_omitted", "Binary file content is omitted.");
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    ok: true,
    source: "local_file_tool",
    root: target.rootLabel,
    path: target.relativePath,
    bytes: buffer.length,
    truncated,
    content: redactSecrets(slice.toString("utf8"))
  };
}

function searchFiles(request, roots, options) {
  const query = requiredText(request.query || request.pattern || request.path, "query").toLowerCase();
  const baseTargets = resolveScanBases(request, roots);
  const maxResults = clampNumber(options.maxSearchResults || request.count, DEFAULT_MAX_SEARCH_RESULTS, 1, 500);
  const results = [];
  let scannedFiles = 0;

  for (const base of baseTargets) {
    for (const item of walkFiles(base.path, base.root, { ...options, protectInternal: base.protectInternal })) {
      scannedFiles += 1;
      if (item.relativePath.toLowerCase().includes(query)) {
        results.push({
          root: base.rootLabel,
          path: item.relativePath,
          type: "file"
        });
      }
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }

  return {
    ok: true,
    source: "local_file_tool",
    query,
    results,
    scannedFiles,
    truncated: results.length >= maxResults
  };
}

function grepContent(request, roots, options) {
  const query = requiredText(request.query || request.pattern, "query");
  const queryLower = query.toLowerCase();
  const baseTargets = resolveScanBases(request, roots);
  const maxResults = clampNumber(options.maxGrepResults || request.count, DEFAULT_MAX_GREP_RESULTS, 1, 300);
  const maxFileBytes = clampNumber(options.maxGrepFileBytes || request.maxBytes, DEFAULT_MAX_GREP_FILE_BYTES, 1024, 1024 * 1024);
  const results = [];
  let scannedFiles = 0;

  for (const base of baseTargets) {
    for (const item of walkFiles(base.path, base.root, { ...options, protectInternal: base.protectInternal })) {
      scannedFiles += 1;
      const stat = fs.statSync(item.path);
      if (!isTextCandidate(item.path) || stat.size > maxFileBytes) continue;
      const buffer = fs.readFileSync(item.path);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(queryLower)) continue;
        results.push({
          root: base.rootLabel,
          path: item.relativePath,
          line: index + 1,
          text: redactSecrets(lines[index].trim()).slice(0, 500)
        });
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }

  return {
    ok: true,
    source: "local_file_tool",
    query,
    results,
    scannedFiles,
    truncated: results.length >= maxResults
  };
}

function resolveScanBases(request, roots) {
  const rawPath = String(request.path || ".").trim() || ".";
  if (rawPath === "." && !request.root) {
    return roots.map((root, index) => ({
      root,
      path: root,
      relativePath: "",
      rootLabel: rootLabel(index),
      protectInternal: index === 0
    }));
  }
  const target = resolveTarget(rawPath, roots, { rootHint: request.root });
  const stat = fs.statSync(target.path);
  return [{
    root: target.root,
    path: stat.isDirectory() ? target.path : path.dirname(target.path),
    relativePath: stat.isDirectory() ? target.relativePath : path.dirname(target.relativePath),
    rootLabel: target.rootLabel,
    protectInternal: target.rootLabel === "workspace"
  }];
}

function* walkFiles(basePath, root, options = {}) {
  const maxFiles = clampNumber(options.maxScanFiles, DEFAULT_MAX_SCAN_FILES, 100, 20000);
  let count = 0;
  const stack = [basePath];
  while (stack.length && count < maxFiles) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (isSecretName(entry.name)) continue;
      if (entry.isDirectory() && SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(current, entry.name);
      let real;
      try {
        real = fs.realpathSync.native(absolute);
        assertInsideAllowedRoot(root, real);
        assertNotForbidden(root, real, { protectInternal: Boolean(options.protectInternal) });
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(real);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      yield {
        path: real,
        relativePath: normalizeRelative(root, real)
      };
      if (count >= maxFiles) break;
    }
  }
}

function resolveTarget(inputPath, roots, options = {}) {
  const rawInput = requiredText(inputPath, "path");
  const literal = resolveExistingRelativeLiteral(rawInput, roots, options);
  if (literal) return literal;
  const alias = normalizeWorkspacePathAlias(rawInput);
  const raw = alias.path;
  const rootIndexes = alias.aliased ? [0] : candidateRootIndexes(roots, options.rootHint);
  const candidates = [];

  if (path.isAbsolute(raw)) {
    const resolved = fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
    const isAllowed = rootIndexes.some((index) => isInsidePath(roots[index], resolved));
    if (!isAllowed) {
      throw toolError(
        "imported_project_not_registered",
        "This path is outside the council workspace. Import or drag the project folder into this conversation before using its files. Full permission authorizes tools but does not silently grant access to arbitrary folders."
      );
    }
    for (const index of rootIndexes) {
      candidates.push({ index, root: roots[index], path: resolved });
    }
  } else {
    for (const index of rootIndexes) {
      candidates.push({ index, root: roots[index], path: path.resolve(roots[index], raw) });
    }
  }

  let selected;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    const real = fs.realpathSync.native(candidate.path);
    try {
      assertInsideAllowedRoot(candidate.root, real);
      assertNotForbidden(candidate.root, real, { protectInternal: candidate.index === 0 });
      selected = { ...candidate, real };
      break;
    } catch {}
  }
  if (!selected) {
    const candidate = candidates[0];
    const real = path.resolve(candidate.path);
    assertInsideAllowedRoot(candidate.root, real);
    assertNotForbidden(candidate.root, real, { protectInternal: candidate.index === 0 });
    throw toolError("path_not_found", "Target path does not exist.");
  }
  return {
    root: selected.root,
    rootLabel: rootLabel(selected.index),
    path: selected.real,
    relativePath: normalizeRelative(selected.root, selected.real)
  };
}

function resolveExistingRelativeLiteral(inputPath, roots, options = {}) {
  const raw = String(inputPath || "").trim();
  if (!raw || path.isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\")) return null;
  for (const index of candidateRootIndexes(roots, options.rootHint)) {
    const root = roots[index];
    const candidate = path.resolve(root, raw);
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync.native(candidate);
    assertInsideAllowedRoot(root, real);
    assertNotForbidden(root, real, { protectInternal: index === 0 });
    return {
      root,
      rootLabel: rootLabel(index),
      path: real,
      relativePath: normalizeRelative(root, real)
    };
  }
  return null;
}

function candidateRootIndexes(roots, hint) {
  const raw = String(hint || "").trim().toLowerCase();
  if (!raw) return roots.map((_, index) => index);
  if (raw === "workspace" || raw === "group") return [0];
  if (raw === "project" || raw === "imported") return roots.length > 1 ? roots.slice(1).map((_, offset) => offset + 1) : [0];
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < roots.length) return [asNumber];
  return roots.map((_, index) => index);
}

function allowedRoots(options = {}) {
  const roots = [];
  if (options.groupPath) roots.push(options.groupPath);
  for (const root of options.importedProjectRoots || []) roots.push(root);
  return [...new Set(roots.map((root) => safeRealpath(root)).filter(Boolean))];
}

function safeRealpath(root) {
  try {
    if (!root || !fs.existsSync(root)) return "";
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return "";
    return fs.realpathSync.native(root);
  } catch {
    return "";
  }
}

function assertReadableTextFile(filePath, stat) {
  if (stat.size > 10 * 1024 * 1024) throw toolError("file_too_large", "File is too large for direct reading.");
  if (!isTextCandidate(filePath)) throw toolError("non_text_file_omitted", "Only text-like files can be read.");
}

function assertInsideAllowedRoot(root, candidate) {
  if (!isInsidePath(root, candidate)) {
    throw toolError("path_escape_denied", "Requested path must stay inside an allowed workspace or imported project root.");
  }
}

function assertNotForbidden(root, candidate, options = {}) {
  const relative = normalizeRelative(root, candidate);
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (options.protectInternal) assertNotInternalWorkspacePath(parts);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (DIRECT_FORBIDDEN_DIRS.has(lower)) throw toolError("forbidden_path", `Forbidden path segment: ${part}`);
    if (isSecretBasename(lower)) throw toolError("forbidden_secret_file", `Forbidden secret file: ${part}`);
  }
  const base = path.basename(candidate).toLowerCase();
  if (isSecretBasename(base)) throw toolError("forbidden_secret_file", `Forbidden secret file: ${base}`);
  if (options.protectInternal && base === "group.json") {
    throw toolError("forbidden_internal_file", "Group configuration is internal and may contain keys.");
  }
  const extension = path.extname(base).toLowerCase();
  if ([".key", ".pem", ".p12", ".pfx"].includes(extension)) {
    throw toolError("forbidden_secret_file", `Forbidden secret file extension: ${extension}`);
  }
}

function assertNotInternalWorkspacePath(parts) {
  const first = String(parts[0] || "").toLowerCase();
  const second = String(parts[1] || "").toLowerCase();
  if (INTERNAL_WORKSPACE_SEGMENTS.has(first)) {
    throw toolError("forbidden_internal_path", `Internal workspace path is not readable by tools: ${first}`);
  }
  if (first === "shared" && INTERNAL_SHARED_SEGMENTS.has(second)) {
    throw toolError("forbidden_internal_path", `Internal shared path is not readable by tools: shared/${second}`);
  }
}

function isForbiddenName(name) {
  const lower = String(name || "").toLowerCase();
  return HIDDEN_LISTING_DIRS.has(lower) || isSecretName(lower);
}

function isSecretName(name) {
  const lower = String(name || "").toLowerCase();
  return isSecretBasename(lower) || lower.endsWith(".pem") || lower.endsWith(".key");
}

function isInternalListingName(target, name) {
  if (target.rootLabel !== "workspace") return false;
  const lower = String(name || "").toLowerCase();
  const parent = String(target.relativePath || "").toLowerCase();
  if (!parent && (INTERNAL_WORKSPACE_SEGMENTS.has(lower) || lower === "group.json")) return true;
  if (parent === "shared" && INTERNAL_SHARED_SEGMENTS.has(lower)) return true;
  return false;
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

function isTextCandidate(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizeRelative(root, candidate) {
  return path.relative(root, candidate).replaceAll("\\", "/");
}

function joinRelative(parent, child) {
  return [parent, child].filter(Boolean).join("/").replaceAll("\\", "/");
}

function rootLabel(index) {
  return index === 0 ? "workspace" : `imported_project_${index}`;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError(`missing_${name}`, `Missing ${name}.`);
  return text;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]");
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
