import path from "node:path";

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

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`Missing ${name}`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}
