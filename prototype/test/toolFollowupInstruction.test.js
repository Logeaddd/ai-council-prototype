import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolFollowupInstruction, hasPersistedAcquiredCapability, updateStagnantToolLoopCount } from "../src/discussionEngine.js";

test("tool follow-up moves from successful acquisition to real usage without exposing a benchmark solution", () => {
  const npm = buildToolFollowupInstruction([{
    tool: "install_package",
    status: "completed",
    result: { ok: true, manager: "npm", packageName: "chosen-image-package", environmentPath: "shared/environments/npm" }
  }]);
  assert.match(npm, /managed NODE_PATH/);
  assert.match(npm, /Import the package by its normal module name/);
  assert.match(npm, /next artifact-producing action/);
  assert.doesNotMatch(npm, /PNG|pixel|pngjs|Pillow/);

  const provisioned = buildToolFollowupInstruction([{
    tool: "provision_tool",
    status: "completed",
    result: { ok: true, status: "installed", command: "chosen-cli" }
  }]);
  assert.match(provisioned, /Invoke the acquired command/);
  assert.match(provisioned, /chosen-cli/);

  const shell = buildToolFollowupInstruction([{
    tool: "execute_command",
    status: "completed",
    command: "npm install chosen-image-package",
    result: { ok: true, exitCode: 0, stdout: "added 1 package" }
  }]);
  assert.match(shell, /direct package-manager command completed successfully/);

  const maskedFailure = buildToolFollowupInstruction([{
    tool: "execute_command",
    status: "completed",
    command: "apt-get install chosen-cli | tail -5",
    result: { ok: true, exitCode: 0, stdout: "E: Could not open lock file: Permission denied" }
  }]);
  assert.doesNotMatch(maskedFailure, /direct package-manager command completed successfully/);

  const managedFailure = buildToolFollowupInstruction([{
    tool: "install_package",
    status: "failed",
    manager: "first-runtime",
    packageName: "chosen-package",
    result: { ok: false, error: "runtime environment unavailable" }
  }]);
  assert.match(managedFailure, /Do not retry the same manager unchanged/);
  assert.match(managedFailure, /another already-detected runtime ecosystem/);

  const guessedDirectory = buildToolFollowupInstruction([{
    tool: "execute_command",
    status: "failed",
    command: "cd shared/environments/guessed && npm install chosen-package",
    result: { ok: false, exitCode: 2, stderr: "cd: can't cd to shared/environments/guessed: No such file or directory" }
  }]);
  assert.match(guessedDirectory, /Do not invent managed environment paths/);
  assert.match(guessedDirectory, /current existing workspace/);

  const placeholderWorkspace = buildToolFollowupInstruction([{
    tool: "execute_command",
    status: "failed",
    command: "cd /workspace && node render.js",
    result: { ok: false, exitCode: 2, stderr: "cd: can't cd to /workspace" }
  }]);
  assert.match(placeholderWorkspace, /Command tools already start in the current group workspace/);
  assert.match(placeholderWorkspace, /Remove the guessed cd prefix/);
});

test("failed skill paths trigger capability discovery or a generic execution fallback", () => {
  const failedRead = buildToolFollowupInstruction([{
    tool: "skill_read",
    skillId: "missing-document-skill",
    status: "failed",
    code: "skill_not_enabled",
    error: "not enabled"
  }]);
  assert.match(failedRead, /Do not retry the same skill_read unchanged/);
  assert.match(failedRead, /skill_list/);
  assert.match(failedRead, /skill_search plus skill_install\/skill_enable/);
  assert.match(failedRead, /generic package, runtime, CLI, or code path/);

  const invalidAlias = buildToolFollowupInstruction([], [{
    tool: "skill:missing-document-skill",
    status: "rejected",
    code: "invalid_tool"
  }]);
  assert.match(invalidAlias, /no dynamic tool named skill or skill:<id>/);
  assert.match(invalidAlias, /Do not repeat the invalid tool name/);
});

test("acquired capability followed by read-only wandering triggers action recovery without limiting useful pre-acquisition inspection", () => {
  const seenTargets = new Set();
  const acquisition = {
    tool: "install_package",
    status: "completed",
    result: { ok: true, manager: "npm", packageName: "chosen-package" }
  };
  let state = { count: 0, recoveryRequired: false };
  for (const path of ["input-a.json", "package.json", "deliverables"]) {
    state = updateStagnantToolLoopCount({
      requests: [{ tool: "read_file", path }],
      results: [{ tool: "read_file", status: "completed", result: { ok: true, path } }],
      current: state.count,
      seenTargets,
      history: [acquisition]
    });
  }
  assert.deepEqual(state, { count: 9, recoveryRequired: true });

  const preAcquisition = updateStagnantToolLoopCount({
    requests: [{ tool: "read_file", path: "new-source.js" }],
    results: [{ tool: "read_file", status: "completed", result: { ok: true } }],
    current: 0,
    seenTargets: new Set(),
    history: []
  });
  assert.deepEqual(preAcquisition, { count: 1, recoveryRequired: false });

  const mutation = updateStagnantToolLoopCount({
    requests: [{ tool: "workspace_edit", action: "write", path: "render.js" }],
    results: [{
      tool: "workspace_edit",
      status: "completed",
      result: { ok: true, workspaceChanges: { totalChanges: 1, created: [{ path: "render.js" }] } }
    }],
    current: 9,
    seenTargets,
    history: [acquisition]
  });
  assert.deepEqual(mutation, { count: 0, recoveryRequired: false });

  const persisted = updateStagnantToolLoopCount({
    requests: [{ tool: "list_directory", path: "another-new-location" }],
    results: [{ tool: "list_directory", status: "completed", result: { ok: true } }],
    current: 6,
    seenTargets: new Set(),
    history: [],
    capabilityReady: true
  });
  assert.deepEqual(persisted, { count: 9, recoveryRequired: true });
});

test("mixed repeated inspection cannot hide behind one novel target", () => {
  const seenTargets = new Set(["read_file:path:known.json"]);
  const state = updateStagnantToolLoopCount({
    requests: [
      { tool: "read_file", path: "known.json" },
      { tool: "read_file", path: "new.json" }
    ],
    results: [
      { tool: "read_file", status: "completed", result: { ok: true } },
      { tool: "read_file", status: "completed", result: { ok: true } }
    ],
    current: 6,
    seenTargets
  });
  assert.deepEqual(state, { count: 9, recoveryRequired: true });
});

test("endlessly novel inspection eventually requires action without imposing a tool-call ceiling", () => {
  const seenTargets = new Set();
  let state = { count: 0, recoveryRequired: false };
  for (let index = 0; index < 9; index += 1) {
    state = updateStagnantToolLoopCount({
      requests: [{ tool: "read_file", path: `source-${index}.json` }],
      results: [{ tool: "read_file", status: "completed", result: { ok: true } }],
      current: state.count,
      seenTargets
    });
  }
  assert.deepEqual(state, { count: 9, recoveryRequired: true });
});

test("failed capability calls cannot erase search-only stagnation", () => {
  let state = { count: 0, recoveryRequired: false };
  const seenTargets = new Set();
  for (let index = 0; index < 3; index += 1) {
    state = updateStagnantToolLoopCount({
      requests: [
        { tool: "skill_read", skillId: "missing-document-skill" },
        { tool: "web_search", query: `novel research wording ${index}` }
      ],
      results: [
        { tool: "skill_read", skillId: "missing-document-skill", status: "failed", code: "skill_not_enabled" },
        { tool: "web_search", status: "completed", result: { ok: true, results: [{ title: "source" }] } }
      ],
      current: state.count,
      seenTargets
    });
  }
  assert.deepEqual(state, { count: 9, recoveryRequired: true });
});

test("persisted managed packages remain visible as acquired capability across later user stages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-persisted-capability-"));
  try {
    assert.equal(hasPersistedAcquiredCapability(root), false);
    const packagePath = path.join(root, "shared", "environments", "npm", "node_modules", "chosen-package");
    fs.mkdirSync(packagePath, { recursive: true });
    fs.writeFileSync(path.join(packagePath, "package.json"), "{}", "utf8");
    assert.equal(hasPersistedAcquiredCapability(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
