import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards, readExecutionStandards } from "../src/executionStandards.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

function createGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-exec-"));
  return initGroupWorkspace({
    root,
    groupFolderName: "execution-standards",
    members: [
      { seatId: "recorder", displayName: "Recorder", model: "gpt-5" },
      { seatId: "reviewer", displayName: "Reviewer", model: "claude" }
    ]
  });
}

test("group workspace includes a shared harness folder", () => {
  const group = createGroup();
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "harness")));
});

test("prepares execution and verification standards without executing work", () => {
  const group = createGroup();
  const result = prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Build a clean council UI.",
    recorderSeatId: "recorder",
    reviewerSeatIds: ["reviewer"]
  });

  assert.equal(result.manifest.status, "pending_user_approval");
  assert.equal(result.manifest.recorderSeatId, "recorder");
  assert.deepEqual(result.manifest.reviewerSeatIds, ["reviewer"]);
  assert.match(result.executionStandard, /# Execution Standard/);
  assert.match(result.executionStandard, /does not grant tools or start execution/);
  assert.match(result.verificationStandard, /# Verification Standard/);
  assert.match(result.verificationStandard, /Git commit/);
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "harness", "execution-standard.md")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "harness", "verification-standard.md")));
});

test("approves standards only after standard files exist", () => {
  const group = createGroup();
  assert.throws(() => approveExecutionStandards({
    groupPath: group.groupPath,
    approvedBy: "user"
  }), /must exist/);

  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Update the workspace docs.",
    recorderSeatId: "recorder"
  });
  const approved = approveExecutionStandards({
    groupPath: group.groupPath,
    approvedBy: "user"
  });

  assert.equal(approved.manifest.status, "approved");
  assert.equal(approved.manifest.approvedBy, "user");
  assert.ok(fs.existsSync(path.join(group.groupPath, "approvals", "execution-standards.user.approval.json")));
});

test("reads missing standards as a non-approved missing state", () => {
  const group = createGroup();
  const result = readExecutionStandards(group.groupPath);
  assert.equal(result.manifest.status, "missing");
  assert.equal(result.executionStandard, "");
  assert.equal(result.verificationStandard, "");
});
