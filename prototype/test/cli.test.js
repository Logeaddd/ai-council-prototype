import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("harness-check help is informational and never starts the product check", () => {
  const result = spawnSync(process.execPath, ["./src/cli.js", "harness-check", "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /harness-check --report/);
  assert.doesNotMatch(result.stderr, /\[harness-check\] starting/);
});

test("any command help exits before runtime validation or execution", () => {
  const result = spawnSync(process.execPath, ["./src/cli.js", "run", "--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node src\/cli\.js run --question/);
  assert.doesNotMatch(result.stderr, /Missing|AI_COUNCIL/);
});
