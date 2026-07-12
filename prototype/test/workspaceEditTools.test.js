import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { executeWorkspaceEdit } from "../src/workspaceEditTools.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-edit-"));
}

test("workspace_edit creates directories and writes and appends real files", () => {
  const groupPath = workspace();
  const directory = executeWorkspaceEdit({ action: "mkdir", path: "shared/project/src" }, { groupPath });
  const written = executeWorkspaceEdit({ action: "write", path: "shared/project/src/main.js", code: "export const value = 1;\n" }, { groupPath });
  const appended = executeWorkspaceEdit({ action: "append", path: "shared/project/src/main.js", code: "export default value;\n" }, { groupPath });

  assert.equal(directory.workspaceChanges.created[0].path, "shared/project/src");
  assert.equal(written.workspaceChanges.created[0].path, "shared/project/src/main.js");
  assert.equal(appended.workspaceChanges.modified[0].path, "shared/project/src/main.js");
  assert.equal(fs.readFileSync(path.join(groupPath, "shared/project/src/main.js"), "utf8"), "export const value = 1;\nexport default value;\n");
});

test("workspace_edit overwrites an existing file on Windows-compatible paths", () => {
  const groupPath = workspace();
  const target = path.join(groupPath, "shared", "project", "README.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "old", "utf8");

  const result = executeWorkspaceEdit({ action: "write", path: "shared/project/README.md", code: "new" }, { groupPath });

  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(result.workspaceChanges.modified[0].path, "shared/project/README.md");
  assert.equal(fs.readdirSync(path.dirname(target)).some((name) => name.includes(".ai-council-") && name.endsWith(".tmp")), false);
});

test("workspace_edit performs exact replace and rejects ambiguous replacements", () => {
  const groupPath = workspace();
  const target = path.join(groupPath, "shared", "project", "app.txt");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "alpha\nbeta\n", "utf8");

  const result = executeWorkspaceEdit({ action: "replace", path: "shared/project/app.txt", oldText: "beta", newText: "gamma" }, { groupPath });
  assert.equal(result.replacements, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "alpha\ngamma\n");

  fs.writeFileSync(target, "same same", "utf8");
  assert.throws(
    () => executeWorkspaceEdit({ action: "replace", path: "shared/project/app.txt", oldText: "same", newText: "changed" }, { groupPath }),
    (error) => error.code === "replace_text_ambiguous"
  );
});

test("workspace_edit moves files without overwriting a destination", () => {
  const groupPath = workspace();
  const source = path.join(groupPath, "shared", "project", "old.txt");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "move me", "utf8");

  const result = executeWorkspaceEdit({ action: "move", path: "shared/project/old.txt", destination: "shared/project/new.txt" }, { groupPath });
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(groupPath, "shared", "project", "new.txt"), "utf8"), "move me");
  assert.equal(result.destination, "shared/project/new.txt");

  fs.writeFileSync(source, "again", "utf8");
  assert.throws(
    () => executeWorkspaceEdit({ action: "move", path: "shared/project/old.txt", destination: "shared/project/new.txt" }, { groupPath }),
    (error) => error.code === "destination_exists"
  );
});

test("workspace_edit rejects path escapes, internal files, and secret files", () => {
  const groupPath = workspace();
  for (const [target, code] of [
    ["../outside.txt", "path_escape_denied"],
    ["group.json", "forbidden_internal_path"],
    ["shared/logs/fake.jsonl", "forbidden_internal_path"],
    ["shared/project/.env", "forbidden_secret_file"],
    ["shared/project/private.pem", "forbidden_secret_extension"]
  ]) {
    assert.throws(
      () => executeWorkspaceEdit({ action: "write", path: target, code: "secret" }, { groupPath }),
      (error) => error.code === code,
      target
    );
  }
});

test("workspace_edit enforces the 256KB per-chunk limit", () => {
  const groupPath = workspace();
  const exact = "x".repeat(256 * 1024);
  executeWorkspaceEdit({ action: "write", path: "shared/project/exact.bin", code: exact }, { groupPath });
  assert.equal(fs.statSync(path.join(groupPath, "shared", "project", "exact.bin")).size, 256 * 1024);
  assert.throws(
    () => executeWorkspaceEdit({ action: "append", path: "shared/project/exact.bin", code: `${exact}x` }, { groupPath }),
    (error) => error.code === "content_too_large"
  );
});
