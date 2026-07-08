import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { executeReadListFileOperations } from "../src/fileOperationReader.js";

test("read/list file operations execute inside the group sandbox", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-read-list-"));
  fs.writeFileSync(path.join(groupPath, "README.md"), "real project note", "utf8");
  fs.mkdirSync(path.join(groupPath, "src"));
  fs.writeFileSync(path.join(groupPath, "src", "index.js"), "export const ok = true;", "utf8");

  const results = executeReadListFileOperations(groupPath, [
    { id: "read-1", op: "read", path: "README.md", source_agent_id: "builder" },
    { id: "list-1", op: "list", path: "src", source_agent_id: "builder" }
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].status, "completed");
  assert.equal(results[0].content, "real project note");
  assert.deepEqual(results[1].entries, ["index.js"]);
  assert.equal(fs.existsSync(path.join(groupPath, "shared", "logs", "file-ops.jsonl")), true);
});

test("read/list refuses forbidden secret paths", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-read-deny-"));
  fs.writeFileSync(path.join(groupPath, ".env"), "SECRET=1", "utf8");

  const [result] = executeReadListFileOperations(groupPath, [
    { id: "read-secret", op: "read", path: ".env", source_agent_id: "builder" }
  ]);

  assert.equal(result.status, "failed");
  assert.match(result.error, /Forbidden secret file/);
  assert.equal("content" in result, false);
});
