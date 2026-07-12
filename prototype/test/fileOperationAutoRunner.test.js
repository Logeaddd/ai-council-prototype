import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { approvePendingFileOperation } from "../src/fileOperationExecutor.js";
import { runAutoFileOperations } from "../src/fileOperationAutoRunner.js";
import { parseFileOperationProposals } from "../src/fileOperations.js";
import { enqueueFileOperationProposals, listPendingFileOperationProposals, readFileOperationAuditLog } from "../src/fileOperationQueue.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

function baseSession(final_state = "ready_to_execute") {
  return {
    finalDecision: { final_state },
    fileOperationExecutionResults: [],
    fileOperationExecutionState: "not_requested"
  };
}

test("auto runner executes safe latest proposals only for full permission", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const first = queueProposal(group.groupPath, {
    op: "write",
    path: "src/value.js",
    content: "export const value = 1;\n",
    reason: "Create initial value.",
    expected_effect: "Initial value exists."
  }, "executor");
  const latest = queueProposal(group.groupPath, {
    op: "write",
    path: "src/value.js",
    content: "export const value = 2;\n",
    reason: "Create latest value.",
    expected_effect: "Latest value exists."
  }, "executor");
  const session = baseSession();

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group });

  assert.equal(result.state, "executed");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "value.js"), "utf8"), "export const value = 2;\n");
  const executed = result.results.find((item) => item.status === "executed");
  assert.equal(executed.proposalId, latest.id);
  assert.match(executed.commitHash, /^[0-9a-f]{7,}/);
  const show = git(group.groupPath, ["show", "--name-only", "--format=", executed.commitHash]);
  assert.match(show, new RegExp(`shared/file-ops/pending/${latest.id}\\.json`));
  assert.doesNotMatch(show, new RegExp(`shared/file-ops/pending/${first.id}\\.json`));
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "superseded"), true);
});


test("auto runner executes only explicitly selected final proposals", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const rejected = queueProposal(group.groupPath, {
    op: "write",
    path: "src/rejected.js",
    content: "export const rejected = true;\n",
    reason: "Create rejected module.",
    expected_effect: "Rejected module exists."
  }, "executor");
  const selected = queueProposal(group.groupPath, {
    op: "write",
    path: "src/selected.js",
    content: "export const selected = true;\n",
    reason: "Create selected module.",
    expected_effect: "Selected module exists."
  }, "executor");
  const session = baseSession();
  session.finalDecision.selected_file_operation_ids = [selected.id];

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group });

  assert.equal(result.state, "executed");
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "selected.js")), true);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "rejected.js")), false);
  assert.equal(result.results.some((item) => item.proposalId === selected.id && item.status === "executed"), true);
  assert.equal(result.results.some((item) => item.proposalId === rejected.id && item.status === "not_selected"), true);
  const pending = listPendingFileOperationProposals(group.groupPath);
  const rejectedProposal = pending.find((proposal) => proposal.id === rejected.id);
  assert.equal(rejectedProposal.status, "pending_user_approval");
  assert.equal(rejectedProposal.autoExecutionStatus, "not_selected");
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "not_selected"), true);
  const approved = approvePendingFileOperation({ groupPath: group.groupPath, proposalId: rejected.id, approvedBy: "user" });
  assert.equal(approved.status, "approved");
});

test("auto runner records unknown selected proposal ids", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const selected = queueProposal(group.groupPath, {
    op: "write",
    path: "src/selected.js",
    content: "export const selected = true;\n",
    reason: "Create selected module.",
    expected_effect: "Selected module exists."
  }, "executor");
  const session = baseSession();
  session.finalDecision.selected_file_operation_ids = ["missing-proposal", selected.id];

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group });

  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "selected.js")), true);
  assert.equal(result.results.some((item) => item.proposalId === "missing-proposal" && item.reason === "unknown_selected_file_operation_id"), true);
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.id === "missing-proposal" && item.code === "unknown_selected_file_operation_id"), true);
});

test("auto runner does not resurrect superseded proposals", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const first = queueProposal(group.groupPath, {
    op: "write",
    path: "src/value.js",
    content: "export const value = 1;\n",
    reason: "Create old value.",
    expected_effect: "Old value exists."
  }, "executor");
  const latest = queueProposal(group.groupPath, {
    op: "write",
    path: "src/value.js",
    content: "export const value = 2;\n",
    reason: "Create latest value.",
    expected_effect: "Latest value exists."
  }, "executor");

  const firstRun = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });
  const secondRun = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(firstRun.state, "executed");
  assert.equal(secondRun.state, "not_requested");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "value.js"), "utf8"), "export const value = 2;\n");
  const pending = listPendingFileOperationProposals(group.groupPath);
  const oldProposal = pending.find((proposal) => proposal.id === first.id);
  const latestProposal = pending.find((proposal) => proposal.id === latest.id);
  assert.equal(oldProposal.status, "superseded");
  assert.equal(latestProposal.status, "executed");
});

test("auto runner leaves usable-with-risks proposals pending", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  queueProposal(group.groupPath, {
    op: "write",
    path: "src/risky.js",
    content: "export const risky = true;\n",
    reason: "Create risky file.",
    expected_effect: "File exists."
  }, "executor");
  const session = baseSession("usable_with_risks");

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group });

  assert.equal(result.state, "blocked_by_policy");
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "risky.js")), false);
  const pending = listPendingFileOperationProposals(group.groupPath);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending_user_approval");
  assert.equal(pending[0].autoExecutionStatus, "skipped_policy");
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "skipped_policy"), true);
  const approved = approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending[0].id, approvedBy: "user" });
  assert.equal(approved.status, "approved");
});

test("auto runner keeps existing proposals pending while file capability is disabled", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const proposal = queueProposal(group.groupPath, {
    op: "write",
    path: "src/disabled.js",
    content: "export const disabled = true;\n",
    reason: "This must remain pending while files are disabled.",
    expected_effect: "No file is written."
  }, "executor");

  const result = runAutoFileOperations({
    groupPath: group.groupPath,
    session: baseSession(),
    group,
    appSettings: { capabilities: { toolAccess: { files: false } } }
  });

  assert.equal(result.state, "blocked_by_policy");
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "disabled.js")), false);
  assert.equal(result.results[0].proposalId, proposal.id);
  assert.equal(result.results[0].status, "capability_disabled");
  const pending = listPendingFileOperationProposals(group.groupPath).find((item) => item.id === proposal.id);
  assert.equal(pending.status, "pending_user_approval");
  assert.equal(pending.autoExecutionStatus, "capability_disabled");
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "capability_disabled"), true);
});

test("auto runner blocks batches above distinct path limit", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  for (const name of ["a", "b", "c", "d"]) {
    queueProposal(group.groupPath, {
      op: "write",
      path: `src/${name}.js`,
      content: `export const ${name} = true;\n`,
      reason: `Create ${name}.`,
      expected_effect: "File exists."
    }, "executor");
  }
  const session = baseSession();

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group, maxAutoFilesPerRun: 3 });

  assert.equal(result.state, "blocked_by_policy");
  assert.equal(result.results.filter((item) => item.reason?.startsWith("max_auto_files_exceeded")).length, 4);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "a.js")), false);
});

test("full permission has no implicit per-run approval batch limit", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  for (const name of ["a", "b", "c", "d", "e"]) {
    queueProposal(group.groupPath, {
      op: "write",
      path: `src/${name}.js`,
      content: `export const ${name} = true;\n`,
      reason: `Create ${name}.`,
      expected_effect: "File exists."
    }, "executor");
  }

  const result = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(result.state, "executed");
  assert.equal(result.results.filter((item) => item.status === "executed").length, 5);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "e.js")), true);
});

test("auto runner requires full effective seat permission", () => {
  const group = createReadyGitGroup({ defaultTier: "text", seatTiers: { executor: "full", reviewer: "tool" } });
  queueProposal(group.groupPath, {
    op: "write",
    path: "src/executor.js",
    content: "export const executor = true;\n",
    reason: "Executor can write.",
    expected_effect: "File exists."
  }, "executor");
  queueProposal(group.groupPath, {
    op: "write",
    path: "src/reviewer.js",
    content: "export const reviewer = true;\n",
    reason: "Reviewer cannot auto write.",
    expected_effect: "File pending."
  }, "reviewer");
  const session = baseSession();

  const result = runAutoFileOperations({ groupPath: group.groupPath, session, group });

  assert.equal(result.state, "partial_executed");
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "executor.js")), true);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "reviewer.js")), false);
  assert.equal(result.results.some((item) => item.status === "skipped_permission" && item.path === "src/reviewer.js"), true);
  const pending = listPendingFileOperationProposals(group.groupPath);
  const reviewerProposal = pending.find((proposal) => proposal.path === "src/reviewer.js");
  assert.equal(reviewerProposal.status, "pending_user_approval");
  assert.equal(reviewerProposal.autoExecutionStatus, "skipped_permission");
  const approved = approvePendingFileOperation({ groupPath: group.groupPath, proposalId: reviewerProposal.id, approvedBy: "user" });
  assert.equal(approved.status, "approved");
});

test("auto runner continues when prior tool commands left generated files dirty", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  fs.mkdirSync(path.join(group.groupPath, "tools"), { recursive: true });
  fs.writeFileSync(path.join(group.groupPath, "tools", "downloaded.bin"), "generated by command\n", "utf8");
  queueProposal(group.groupPath, {
    op: "write",
    path: "src/after-command.js",
    content: "export const afterCommand = true;\n",
    reason: "Create source after a command generated a file.",
    expected_effect: "Source exists."
  }, "executor");

  const result = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(result.state, "executed");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "after-command.js"), "utf8"), "export const afterCommand = true;\n");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "tools", "downloaded.bin"), "utf8"), "generated by command\n");
  assert.match(git(group.groupPath, ["status", "--porcelain"]), /tools\//);
});

test("auto runner overwrites pre-existing files for full permission", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  fs.mkdirSync(path.join(group.groupPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(group.groupPath, "src", "existing.js"), "old\n", "utf8");
  git(group.groupPath, ["add", "--", "src/existing.js"]);
  git(group.groupPath, ["commit", "-m", "test: existing"]);
  queueProposal(group.groupPath, {
    op: "write",
    path: "src/existing.js",
    content: "new\n",
    reason: "Try overwrite.",
    expected_effect: "Should replace the file."
  }, "executor");

  const result = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(result.state, "executed");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "existing.js"), "utf8"), "new\n");
  assert.equal(result.results[0].status, "executed");
  const pending = listPendingFileOperationProposals(group.groupPath);
  assert.equal(pending[0].status, "executed");
  assert.equal(pending[0].autoApproved, true);
  assert.equal(pending[0].dangerousConfirmed, true);
});

test("auto runner deletes files for full permission", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  fs.writeFileSync(path.join(group.groupPath, "old.txt"), "old\n", "utf8");
  git(group.groupPath, ["add", "--", "old.txt"]);
  git(group.groupPath, ["commit", "-m", "test: old file"]);
  queueProposal(group.groupPath, {
    op: "delete",
    path: "old.txt",
    reason: "Delete old file.",
    expected_effect: "Should remove the file."
  }, "executor");

  const result = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(result.state, "executed");
  assert.equal(fs.existsSync(path.join(group.groupPath, "old.txt")), false);
  assert.equal(result.results[0].status, "executed");
  const pending = listPendingFileOperationProposals(group.groupPath);
  assert.equal(pending[0].status, "executed");
  assert.equal(pending[0].autoApproved, true);
  assert.equal(pending[0].dangerousConfirmed, true);
});

test("auto runner terminalizes unsupported unsafe operations", () => {
  const group = createReadyGitGroup({ defaultTier: "full" });
  const proposal = queueProposal(group.groupPath, {
    op: "read",
    path: "src/value.js",
    reason: "Read a file.",
    expected_effect: "Should not auto execute."
  }, "executor");

  const firstRun = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });
  const secondRun = runAutoFileOperations({ groupPath: group.groupPath, session: baseSession(), group });

  assert.equal(firstRun.state, "blocked_by_policy");
  assert.equal(firstRun.results[0].reason, "unsupported_auto_op:read");
  assert.equal(secondRun.state, "not_requested");
  const pending = listPendingFileOperationProposals(group.groupPath);
  assert.equal(pending.find((item) => item.id === proposal.id).status, "skipped_policy");
  assert.equal(pending.find((item) => item.id === proposal.id).autoExecutionStatus, "skipped_policy");
});

function createReadyGitGroup(permissions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-auto-runner-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "auto-runner",
    members: [
      { seatId: "executor", displayName: "Executor", model: "deepseek" },
      { seatId: "reviewer", displayName: "Reviewer", model: "deepseek" }
    ]
  });
  group.permissions = permissions;
  fs.writeFileSync(path.join(group.groupPath, "group.json"), JSON.stringify(group, null, 2), "utf8");
  git(group.groupPath, ["init"]);
  git(group.groupPath, ["config", "user.email", "test@example.com"]);
  git(group.groupPath, ["config", "user.name", "Test User"]);
  git(group.groupPath, ["add", "--", "."]);
  git(group.groupPath, ["commit", "-m", "test: initialize group"]);
  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Auto execute safe file proposals.",
    recorderSeatId: "executor"
  });
  approveExecutionStandards({ groupPath: group.groupPath, approvedBy: "user" });
  git(group.groupPath, ["add", "--", "."]);
  git(group.groupPath, ["commit", "-m", "test: approve standards"]);
  return group;
}

function queueProposal(groupPath, operation, seatId) {
  const parsed = parseFileOperationProposals({
    groupRoot: groupPath,
    source: { file_operations: [operation] },
    proposedBy: { seatId, name: seatId }
  });
  const queued = enqueueFileOperationProposals({
    groupPath,
    accepted: parsed.accepted,
    rejected: parsed.rejected
  });
  assert.equal(queued.rejected.length, 0);
  return queued.queued[0];
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
