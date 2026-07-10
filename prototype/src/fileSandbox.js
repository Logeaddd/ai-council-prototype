import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";

const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);
const FORBIDDEN_BASENAMES = new Set([".env", "credentials", "credentials.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const FORBIDDEN_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

export function validateFileOperationPath(groupRoot, relativePath, options = {}) {
  const rootRealPath = realpathExisting(groupRoot);
  const candidate = resolveRelativeCandidate(rootRealPath, relativePath);
  const resolvedRealPath = resolveRealOperationPath(candidate, options);

  assertInside(rootRealPath, resolvedRealPath);
  assertNotForbidden(rootRealPath, resolvedRealPath);

  return {
    root: rootRealPath,
    path: resolvedRealPath,
    relativePath: normalizeRelative(rootRealPath, resolvedRealPath)
  };
}

export function isForbiddenFilePath(groupRoot, candidatePath) {
  const root = path.resolve(groupRoot);
  const candidate = path.resolve(candidatePath);
  if (!isInsidePath(root, candidate)) return true;
  try {
    assertNotForbidden(root, candidate);
    return false;
  } catch {
    return true;
  }
}

function resolveRelativeCandidate(rootRealPath, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw sandboxError("missing_path", "Missing file operation path", 400);
  }
  const alias = normalizeWorkspacePathAlias(relativePath);
  const raw = alias.path;
  if (!alias.aliased && path.isAbsolute(raw)) {
    throw sandboxError("absolute_path_denied", "File operation paths must be relative to the group root", 403);
  }
  const candidate = path.resolve(rootRealPath, raw);
  if (!isInsidePath(rootRealPath, candidate)) {
    throw sandboxError("path_escape_denied", "File operation path must stay inside the group root", 403);
  }
  return candidate;
}

function resolveRealOperationPath(candidate, options = {}) {
  if (fs.existsSync(candidate)) return fs.realpathSync.native(candidate);
  const parent = nearestExistingParent(candidate);
  const parentRealPath = fs.realpathSync.native(parent);
  return path.resolve(parentRealPath, path.relative(parent, candidate));
}

function nearestExistingParent(candidate) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) throw sandboxError("missing_parent", "No existing parent directory for file operation", 400);
    current = next;
  }
  return current;
}

function realpathExisting(root) {
  if (!root || !fs.existsSync(root)) throw sandboxError("missing_group_root", "Group root does not exist", 400);
  return fs.realpathSync.native(root);
}

function assertInside(rootRealPath, resolvedRealPath) {
  if (!isInsidePath(rootRealPath, resolvedRealPath)) {
    throw sandboxError("realpath_escape_denied", "Resolved file operation path escapes the group root", 403);
  }
}

function assertNotForbidden(rootRealPath, resolvedRealPath) {
  const relative = normalizeRelative(rootRealPath, resolvedRealPath);
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) {
      throw sandboxError("forbidden_segment", `Forbidden path segment: ${part}`, 403);
    }
  }

  const base = path.basename(resolvedRealPath).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(base) || base.startsWith("credentials.")) {
    throw sandboxError("forbidden_secret_file", `Forbidden secret file: ${base}`, 403);
  }

  const extension = path.extname(base).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    throw sandboxError("forbidden_secret_extension", `Forbidden secret file extension: ${extension}`, 403);
  }
}

function normalizeRelative(rootRealPath, resolvedRealPath) {
  return path.relative(rootRealPath, resolvedRealPath).replaceAll("\\", "/");
}

function sandboxError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
