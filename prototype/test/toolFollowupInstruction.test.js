import test from "node:test";
import assert from "node:assert/strict";
import { buildToolFollowupInstruction, updateStagnantToolLoopCount } from "../src/discussionEngine.js";

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
  assert.deepEqual(state, { count: 3, recoveryRequired: true });

  const preAcquisition = updateStagnantToolLoopCount({
    requests: [{ tool: "read_file", path: "new-source.js" }],
    results: [{ tool: "read_file", status: "completed", result: { ok: true } }],
    current: 2,
    seenTargets: new Set(),
    history: []
  });
  assert.deepEqual(preAcquisition, { count: 0, recoveryRequired: false });

  const mutation = updateStagnantToolLoopCount({
    requests: [{ tool: "workspace_edit", action: "write", path: "render.js" }],
    results: [{
      tool: "workspace_edit",
      status: "completed",
      result: { ok: true, workspaceChanges: { totalChanges: 1, created: [{ path: "render.js" }] } }
    }],
    current: 3,
    seenTargets,
    history: [acquisition]
  });
  assert.deepEqual(mutation, { count: 0, recoveryRequired: false });
});
