import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTextFileAtomically } from "../src/atomicFile.js";

test("atomic writes preserve the last complete document when replacement fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-atomic-write-"));
  const filePath = path.join(directory, "session.json");
  fs.writeFileSync(filePath, '{"status":"previous"}\n', "utf8");
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === filePath) throw new Error("simulated replacement interruption");
    return originalRename(from, to);
  };
  try {
    assert.throws(() => writeTextFileAtomically(filePath, '{"status":"next"}\n'), /simulated replacement interruption/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { status: "previous" });
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
});
