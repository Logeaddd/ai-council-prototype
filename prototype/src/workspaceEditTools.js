import fs from "node:fs";
import path from "node:path";
import { validateFileOperationPath } from "./fileSandbox.js";

const MAX_CONTENT_BYTES = 256 * 1024;

export function executeWorkspaceEdit(request = {}, options = {}) {
  const action = String(request.action || "").toLowerCase();
  const groupPath = options.groupPath;
  if (!groupPath) throw toolError("missing_workspace", "workspace_edit requires a group workspace.");
  if (action === "mkdir") return makeDirectory(groupPath, request);
  if (action === "write") return writeFile(groupPath, request, false);
  if (action === "append") return writeFile(groupPath, request, true);
  if (action === "replace") return replaceText(groupPath, request);
  if (action === "move") return movePath(groupPath, request);
  throw toolError("unsupported_workspace_edit", "workspace_edit action must be mkdir, write, append, replace, or move.");
}

function makeDirectory(groupPath, request) {
  const target = validateFileOperationPath(groupPath, request.path);
  const existed = fs.existsSync(target.path);
  fs.mkdirSync(target.path, { recursive: true });
  return editResult(actionRecord(request, target.relativePath), {
    created: existed ? [] : [{ path: target.relativePath, type: "directory" }]
  });
}

function writeFile(groupPath, request, append) {
  const target = validateFileOperationPath(groupPath, request.path);
  const content = boundedContent(request.code, append ? "append content" : "write content");
  const existed = fs.existsSync(target.path);
  if (existed && !fs.statSync(target.path).isFile()) throw toolError("not_a_file", "workspace_edit target is not a file.");
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  if (append) {
    fs.appendFileSync(target.path, content, "utf8");
  } else {
    atomicWrite(target.path, content);
  }
  return editResult(actionRecord(request, target.relativePath), {
    created: existed ? [] : [{ path: target.relativePath, type: "file" }],
    modified: existed ? [{ path: target.relativePath, type: "file" }] : [],
    bytesWritten: Buffer.byteLength(content)
  });
}

function replaceText(groupPath, request) {
  const target = validateFileOperationPath(groupPath, request.path);
  if (!fs.existsSync(target.path) || !fs.statSync(target.path).isFile()) throw toolError("file_not_found", "workspace_edit replace target was not found.");
  const oldText = boundedContent(request.oldText, "oldText");
  const newText = boundedContent(request.newText, "newText", { allowEmpty: true });
  if (!oldText) throw toolError("missing_old_text", "workspace_edit replace requires oldText.");
  const current = fs.readFileSync(target.path, "utf8");
  const first = current.indexOf(oldText);
  if (first < 0) throw toolError("replace_text_not_found", "oldText was not found in the target file.");
  if (!request.replaceAll && current.indexOf(oldText, first + oldText.length) >= 0) {
    throw toolError("replace_text_ambiguous", "oldText occurs more than once; provide a larger exact block or set replaceAll.");
  }
  const next = request.replaceAll ? current.split(oldText).join(newText) : `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
  atomicWrite(target.path, next);
  return editResult(actionRecord(request, target.relativePath), {
    modified: [{ path: target.relativePath, type: "file" }],
    replacements: request.replaceAll ? current.split(oldText).length - 1 : 1,
    bytesWritten: Buffer.byteLength(next)
  });
}

function movePath(groupPath, request) {
  const source = validateFileOperationPath(groupPath, request.path);
  const destination = validateFileOperationPath(groupPath, request.destination);
  if (!fs.existsSync(source.path)) throw toolError("source_not_found", "workspace_edit move source was not found.");
  if (fs.existsSync(destination.path)) throw toolError("destination_exists", "workspace_edit move destination already exists.");
  fs.mkdirSync(path.dirname(destination.path), { recursive: true });
  fs.renameSync(source.path, destination.path);
  return editResult(actionRecord(request, source.relativePath), {
    created: [{ path: destination.relativePath, type: "moved" }],
    deleted: [{ path: source.relativePath, type: "moved" }],
    destination: destination.relativePath
  });
}

function actionRecord(request, relativePath) {
  return { action: String(request.action || ""), path: relativePath };
}

function editResult(base, extra = {}) {
  const created = extra.created || [];
  const modified = extra.modified || [];
  const deleted = extra.deleted || [];
  return {
    ok: true,
    source: "workspace_edit",
    ...base,
    ...extra,
    workspaceChanges: {
      status: "completed",
      complete: true,
      created,
      modified,
      deleted,
      totalChanges: created.length + modified.length + deleted.length,
      omittedChanges: 0
    }
  };
}

function boundedContent(value, label, options = {}) {
  const content = String(value ?? "");
  if (!options.allowEmpty && !content) throw toolError("missing_content", `workspace_edit requires ${label}.`);
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw toolError("content_too_large", `${label} exceeds ${MAX_CONTENT_BYTES} bytes; split it into write plus append chunks.`);
  return content;
}

function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.ai-council-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(tempPath, filePath);
      fs.rmSync(tempPath, { force: true });
    } else {
      fs.renameSync(tempPath, filePath);
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
