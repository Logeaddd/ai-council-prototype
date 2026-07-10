import { validateFileOperationPath } from "./fileSandbox.js";
import { makeId } from "./types.js";

const ALLOWED_FILE_OPS = new Set(["read", "list", "write", "append", "delete"]);
const WRITE_LIKE_OPS = new Set(["write", "append"]);

export function parseFileOperationProposals(options = {}) {
  const groupRoot = requireGroupRoot(options.groupRoot);
  const source = options.source ?? {};
  const operations = extractFileOperations(source);
  const accepted = [];
  const rejected = [];

  operations.forEach((operation, index) => {
    const result = normalizeFileOperation({ groupRoot, operation, index, proposedBy: options.proposedBy });
    if (result.accepted) accepted.push(result.proposal);
    else rejected.push(result.rejection);
  });

  return { accepted, rejected };
}

export function extractFileOperations(source) {
  if (!source || typeof source !== "object") return [];
  const direct = source.file_operations;
  if (Array.isArray(direct)) return direct;

  const artifacts = Array.isArray(source.artifacts) ? source.artifacts : [];
  for (const artifact of artifacts) {
    const parsed = parseArtifactFileOperations(artifact);
    if (parsed.length) return parsed;
  }
  return [];
}

function normalizeFileOperation({ groupRoot, operation, index, proposedBy }) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return reject(index, "invalid_operation", "File operation must be an object.");
  }

  const op = normalizeOp(operation.op ?? operation.operation ?? operation.action);
  if (!ALLOWED_FILE_OPS.has(op)) {
    return reject(index, "invalid_op", "File operation op must be one of read, list, write, append, delete.");
  }

  const pathValue = stringField(operation.path);
  if (!pathValue) return reject(index, "missing_path", "File operation path is required.");

  const reason = stringField(operation.reason);
  if (!reason) return reject(index, "missing_reason", "File operation reason is required.");

  const expectedEffect = stringField(operation.expected_effect) || reason;

  const content = contentField(operation.content);
  if (WRITE_LIKE_OPS.has(op) && content === undefined) {
    return reject(index, "missing_content", "File operation content is required for write and append.");
  }

  let sandbox;
  try {
    sandbox = validateFileOperationPath(groupRoot, pathValue);
  } catch (error) {
    return reject(index, error.code || "path_denied", error.message || "File operation path denied.");
  }
  const normalizedPath = sandbox.relativePath || ".";
  if (normalizedPath === "." && op !== "list") {
    return reject(index, "root_path_not_allowed", "Only list operations may target the workspace root path.");
  }

  return {
    accepted: true,
    proposal: {
      id: makeId("fop"),
      op,
      path: normalizedPath,
      resolvedPath: sandbox.path,
      reason,
      expected_effect: expectedEffect,
      content: WRITE_LIKE_OPS.has(op) ? content : undefined,
      proposedBy: normalizeProposedBy(proposedBy),
      sourceIndex: index,
      status: "proposed"
    }
  };
}

function parseArtifactFileOperations(artifact) {
  if (!artifact || typeof artifact !== "object") return [];
  const type = String(artifact.type || "").toLowerCase();
  const title = String(artifact.title || "").toLowerCase();
  if (!type.includes("file") && !title.includes("file_operations")) return [];

  const content = String(artifact.content || "").trim();
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.file_operations) ? parsed.file_operations : [];
  } catch {
    return [];
  }
}

function reject(index, code, reason) {
  return {
    accepted: false,
    rejection: {
      sourceIndex: index,
      code,
      reason
    }
  };
}

function normalizeOp(value) {
  return String(value || "").trim().toLowerCase();
}

function stringField(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function contentField(value) {
  return typeof value === "string" ? value : undefined;
}

function normalizeProposedBy(value) {
  if (!value || typeof value !== "object") return {};
  return {
    seatId: stringField(value.seatId),
    name: stringField(value.name),
    role: stringField(value.role)
  };
}

function requireGroupRoot(value) {
  const root = stringField(value);
  if (!root) throw new Error("Missing groupRoot");
  return root;
}
