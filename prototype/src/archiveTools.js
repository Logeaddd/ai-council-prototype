import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { isInsidePath } from "./pathGuards.js";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);
const FORBIDDEN_BASENAMES = new Set([
  ".env",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);
const FORBIDDEN_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

export function extractArchiveTool(request = {}, options = {}) {
  const groupRoot = requireGroupRoot(options.groupPath);
  const archive = resolveWorkspaceFile(groupRoot, request.path, "archive path");
  if (path.extname(archive.relativePath).toLowerCase() !== ".zip") {
    throw toolError("unsupported_archive_type", "Only .zip archives are supported by extract_archive.");
  }
  const destination = resolveDestination(groupRoot, request.destination || request.outputPath || defaultDestination(archive.relativePath));
  const maxEntries = clampNumber(request.count || options.maxArchiveEntries, DEFAULT_MAX_ENTRIES, 1, 1000);
  const maxFileBytes = clampNumber(request.maxBytes || options.maxArchiveFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 50 * 1024 * 1024);
  const maxTotalBytes = clampNumber(options.maxArchiveTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1024, 200 * 1024 * 1024);
  const overwrite = Boolean(request.overwrite);

  const buffer = fs.readFileSync(archive.path);
  const entries = readZipCentralDirectory(buffer);
  const extracted = [];
  const skipped = [];
  let totalBytes = 0;

  fs.mkdirSync(destination.path, { recursive: true });
  for (const entry of entries) {
    if (extracted.length + skipped.length >= maxEntries) {
      skipped.push({ path: entry.name, reason: "max_entries_exceeded" });
      break;
    }
    if (entry.directory) continue;
    const safe = safeEntryTarget(groupRoot, destination.path, entry.name);
    if (!safe.ok) {
      skipped.push({ path: entry.name, reason: safe.reason });
      continue;
    }
    if (entry.uncompressedSize > maxFileBytes) {
      skipped.push({ path: entry.name, reason: "file_too_large" });
      continue;
    }
    if (totalBytes + entry.uncompressedSize > maxTotalBytes) {
      skipped.push({ path: entry.name, reason: "total_size_limit_exceeded" });
      continue;
    }
    if (!overwrite && fs.existsSync(safe.path)) {
      skipped.push({ path: entry.name, reason: "target_exists" });
      continue;
    }
    const content = readZipEntry(buffer, entry);
    if (content.length > maxFileBytes) {
      skipped.push({ path: entry.name, reason: "file_too_large" });
      continue;
    }
    if (totalBytes + content.length > maxTotalBytes) {
      skipped.push({ path: entry.name, reason: "total_size_limit_exceeded" });
      continue;
    }
    fs.mkdirSync(path.dirname(safe.path), { recursive: true });
    fs.writeFileSync(safe.path, content);
    totalBytes += content.length;
    extracted.push({
      path: normalizeRelative(groupRoot, safe.path),
      bytes: content.length
    });
  }

  return {
    ok: true,
    source: "local_archive_tool",
    archivePath: archive.relativePath,
    destinationPath: destination.relativePath,
    entries: entries.length,
    extracted,
    skipped,
    totalBytes,
    truncated: extracted.length + skipped.length < entries.length
  };
}

function readZipCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw toolError("invalid_zip", "Invalid zip central directory.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    if (flags & 1) throw toolError("encrypted_zip_unsupported", "Encrypted zip entries are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw toolError("zip64_unsupported", "ZIP64 archives are not supported yet.");
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directory: name.endsWith("/")
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw toolError("invalid_zip", "Could not find zip end-of-central-directory record.");
}

function readZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw toolError("invalid_zip", "Invalid zip local file header.");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw toolError("unsupported_zip_method", `Unsupported zip compression method: ${entry.method}`);
}

function requireGroupRoot(groupPath) {
  if (!groupPath || !fs.existsSync(groupPath)) throw toolError("missing_workspace", "A group workspace is required for archive extraction.");
  return fs.realpathSync.native(groupPath);
}

function resolveWorkspaceFile(groupRoot, relativePath, label) {
  const raw = requireRelativePath(relativePath, label);
  const candidate = path.resolve(groupRoot, raw);
  if (!isInsidePath(groupRoot, candidate)) throw toolError("path_escape_denied", `${label} must stay inside the group workspace.`);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw toolError("archive_not_found", "Archive file was not found.");
  assertSafeWorkspacePath(groupRoot, candidate);
  return {
    path: fs.realpathSync.native(candidate),
    relativePath: normalizeRelative(groupRoot, candidate)
  };
}

function resolveDestination(groupRoot, relativePath) {
  const raw = requireRelativePath(relativePath, "destination");
  const candidate = path.resolve(groupRoot, raw);
  if (!isInsidePath(groupRoot, candidate)) throw toolError("path_escape_denied", "Destination must stay inside the group workspace.");
  assertSafeWorkspacePath(groupRoot, candidate);
  return {
    path: candidate,
    relativePath: normalizeRelative(groupRoot, candidate)
  };
}

function safeEntryTarget(groupRoot, destinationRoot, entryName) {
  const name = String(entryName || "").replaceAll("\\", "/");
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return { ok: false, reason: "unsafe_entry_path" };
  const parts = name.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return { ok: false, reason: "unsafe_entry_path" };
  const candidate = path.resolve(destinationRoot, ...parts);
  if (!isInsidePath(destinationRoot, candidate) || !isInsidePath(groupRoot, candidate)) {
    return { ok: false, reason: "zip_slip_denied" };
  }
  try {
    assertSafeWorkspacePath(groupRoot, candidate);
  } catch (error) {
    return { ok: false, reason: error.code || "forbidden_entry_path" };
  }
  return { ok: true, path: candidate };
}

function assertSafeWorkspacePath(groupRoot, candidate) {
  const relative = normalizeRelative(groupRoot, candidate);
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (FORBIDDEN_SEGMENTS.has(lower)) throw toolError("forbidden_path", `Forbidden path segment: ${part}`);
    if (isSecretBasename(lower)) throw toolError("forbidden_secret_file", `Forbidden secret file: ${part}`);
  }
  const base = path.basename(candidate).toLowerCase();
  if (isSecretBasename(base)) throw toolError("forbidden_secret_file", `Forbidden secret file: ${base}`);
  const extension = path.extname(base).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) throw toolError("forbidden_secret_file", `Forbidden secret file extension: ${extension}`);
}

function isSecretBasename(base) {
  return FORBIDDEN_BASENAMES.has(base) || base.startsWith(".env.") || base.startsWith("credentials.");
}

function defaultDestination(relativePath) {
  const parsed = path.parse(relativePath);
  return path.join("extracted", parsed.name).replaceAll("\\", "/");
}

function requireRelativePath(value, label) {
  const text = String(value || "").trim();
  if (!text) throw toolError(`missing_${label.replace(/\s+/g, "_")}`, `Missing ${label}.`);
  if (path.isAbsolute(text)) throw toolError("absolute_path_denied", `${label} must be relative to the group workspace.`);
  return text;
}

function normalizeRelative(root, candidate) {
  return path.relative(root, candidate).replaceAll("\\", "/");
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
