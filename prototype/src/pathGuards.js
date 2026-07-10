import path from "node:path";

const WORKSPACE_PATH_ALIASES = new Set(["workspace", "group"]);
const WORKSPACE_PATH_PREFIX_ALIASES = [
  "root/workspace",
  "home/oai/share",
  "mnt/data"
];

export function isInsidePath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(root, input, options = {}) {
  const baseDir = options.baseDir || root;
  const raw = requirePath(input, options.name || "path");
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(baseDir, raw));
  if (!isInsidePath(root, resolved)) {
    const error = new Error(`${options.name || "path"} must stay inside ${root}`);
    error.statusCode = 403;
    throw error;
  }
  return resolved;
}

export function normalizeWorkspacePathAlias(input, options = {}) {
  const raw = requirePath(input, options.name || "path");
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("//")) return { path: raw, aliased: false };

  const candidate = normalized.startsWith("/") ? normalized.replace(/^\/+/, "") : normalized;
  const lowerCandidate = candidate.toLowerCase();
  for (const prefix of WORKSPACE_PATH_PREFIX_ALIASES) {
    if (lowerCandidate === prefix || lowerCandidate.startsWith(`${prefix}/`)) {
      const rest = candidate.slice(prefix.length).replace(/^\/+/, "");
      return {
        path: rest || ".",
        aliased: true,
        alias: prefix
      };
    }
  }
  const firstSlash = candidate.indexOf("/");
  const firstSegment = (firstSlash === -1 ? candidate : candidate.slice(0, firstSlash)).toLowerCase();
  if (!WORKSPACE_PATH_ALIASES.has(firstSegment)) return { path: raw, aliased: false };
  if (candidate.length > firstSegment.length && candidate[firstSegment.length] !== "/") {
    return { path: raw, aliased: false };
  }

  const rest = candidate.slice(firstSegment.length).replace(/^\/+/, "");
  return {
    path: rest || ".",
    aliased: true,
    alias: firstSegment
  };
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`Missing ${name}`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}
