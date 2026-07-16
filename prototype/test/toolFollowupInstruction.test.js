import test from "node:test";
import assert from "node:assert/strict";
import { buildToolFollowupInstruction } from "../src/discussionEngine.js";

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
});
