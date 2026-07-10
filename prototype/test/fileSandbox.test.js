import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { isForbiddenFilePath, validateFileOperationPath } from "../src/fileSandbox.js";

test("file sandbox accepts relative paths inside group root", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, "src"), { recursive: true });

  const resolved = validateFileOperationPath(groupRoot, "src/output.txt");

  assert.equal(resolved.relativePath, "src/output.txt");
  assert.ok(resolved.path.startsWith(fs.realpathSync.native(groupRoot)));
});

test("file sandbox accepts workspace path aliases inside group root", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, "src"), { recursive: true });

  const resolved = validateFileOperationPath(groupRoot, "/workspace/src/output.txt");

  assert.equal(resolved.relativePath, "src/output.txt");
  assert.ok(resolved.path.startsWith(fs.realpathSync.native(groupRoot)));
});

test("file sandbox rejects absolute paths and parent traversal", () => {
  const groupRoot = makeGroupRoot();
  assert.throws(() => validateFileOperationPath(groupRoot, path.join(groupRoot, "ok.txt")), /relative/);
  assert.throws(() => validateFileOperationPath(groupRoot, "../escape.txt"), /stay inside/);
  assert.throws(() => validateFileOperationPath(groupRoot, "/workspace/../escape.txt"), /stay inside/);
});

test("file sandbox rejects forbidden secret files", () => {
  const groupRoot = makeGroupRoot();
  for (const file of [".env", "deploy.pem", "private.key", "credentials.json", "id_rsa"]) {
    assert.throws(() => validateFileOperationPath(groupRoot, file), /Forbidden/);
  }
});

test("file sandbox rejects .git internals after realpath resolution", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, ".git", "objects"), { recursive: true });
  assert.throws(() => validateFileOperationPath(groupRoot, ".git/objects/x"), /Forbidden path segment/);
});

test("file sandbox rejects internal recovery files", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, "shared", "file-ops", "recovery", "fop_1"), { recursive: true });
  fs.writeFileSync(path.join(groupRoot, "shared", "file-ops", "recovery", "fop_1", "content.bin"), "secret");
  assert.throws(
    () => validateFileOperationPath(groupRoot, "shared/file-ops/recovery/fop_1/content.bin"),
    /Forbidden internal path/
  );
});

test("file sandbox rejects council runtime and private state", () => {
  const groupRoot = makeGroupRoot();
  for (const relativePath of [
    "group.json",
    "members/A/private_memory/summary.md",
    "sessions/session.json",
    "approvals/approval.json",
    "shared/logs/commands.jsonl",
    "shared/cache/shared-summary.md",
    "shared/task_state.json"
  ]) {
    assert.throws(() => validateFileOperationPath(groupRoot, relativePath), /Forbidden internal/);
  }
});

test("file sandbox rejects symlink escape using realpath", { skip: process.platform === "win32" && !canSymlink() }, () => {
  const groupRoot = makeGroupRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
  fs.symlinkSync(outside, path.join(groupRoot, "linked"), "dir");

  assert.throws(() => validateFileOperationPath(groupRoot, "linked/secret.txt"), /escapes the group root/);
});

test("file sandbox helper treats outside and forbidden paths as forbidden", () => {
  const groupRoot = makeGroupRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-outside-"));

  assert.equal(isForbiddenFilePath(groupRoot, path.join(groupRoot, "safe.txt")), false);
  assert.equal(isForbiddenFilePath(groupRoot, path.join(groupRoot, ".env")), true);
  assert.equal(isForbiddenFilePath(groupRoot, path.join(outside, "safe.txt")), true);
});

function makeGroupRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-group-"));
}

function canSymlink() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-link-check-"));
  try {
    fs.symlinkSync(tmp, path.join(tmp, "self"), "dir");
    return true;
  } catch {
    return false;
  }
}
