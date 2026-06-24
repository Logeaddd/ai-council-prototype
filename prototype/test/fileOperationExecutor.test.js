import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { approvePendingFileOperation, autoApprovePendingFileOperation, executeApprovedFileOperation } from "../src/fileOperationExecutor.js";
import { parseFileOperationProposals } from "../src/fileOperations.js";
import { enqueueFileOperationProposals, listPendingFileOperationProposals, readFileOperationAuditLog } from "../src/fileOperationQueue.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("approved write proposal executes and creates a git commit", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/output.js",
    content: "export const ok = true;\n",
    reason: "Create module.",
    expected_effect: "Module exists."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: pending.id });

  assert.equal(executed.status, "executed");
  assert.match(executed.commitHash, /^[0-9a-f]{7,}/);
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "output.js"), "utf8"), "export const ok = true;\n");
  assert.equal(git(group.groupPath, ["status", "--porcelain"]), "");
  const show = git(group.groupPath, ["show", "--name-only", "--oneline", executed.commitHash]);
  assert.match(show, /src\/output\.js/);
  assert.match(show, /shared\/file-ops\/pending/);
  assert.match(show, /shared\/logs\/file-ops\.jsonl/);
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "executed"), true);
});

test("execution refuses pending proposals that are not explicitly approved", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/output.js",
    content: "export const ok = true;\n",
    reason: "Create module.",
    expected_effect: "Module exists."
  });

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id
  }), /not approved/);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "output.js")), false);
});

test("execution refuses overwrite without dangerous confirmation", () => {
  const group = createReadyGitGroup();
  fs.mkdirSync(path.join(group.groupPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(group.groupPath, "src", "output.js"), "old\n", "utf8");
  git(group.groupPath, ["add", "--", "src/output.js"]);
  git(group.groupPath, ["commit", "-m", "test: add existing output"]);
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/output.js",
    content: "new\n",
    reason: "Overwrite module.",
    expected_effect: "Module is replaced."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id
  }), /overwrite_requires_confirmation/);
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "output.js"), "utf8"), "old\n");
});

test("execution refuses when unrelated dirty files are present", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "append",
    path: "notes.txt",
    content: "new note\n",
    reason: "Append note.",
    expected_effect: "Note is appended."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });
  fs.writeFileSync(path.join(group.groupPath, "unrelated.txt"), "dirty", "utf8");

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id
  }), /unrelated change/);
});




test("execution allows other queued proposals but commits only the current proposal", () => {
  const group = createReadyGitGroup();
  const first = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/first.js",
    content: "export const first = true;\n",
    reason: "Create first module.",
    expected_effect: "First module exists."
  });
  const second = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/second.js",
    content: "export const second = true;\n",
    reason: "Create second module.",
    expected_effect: "Second module exists."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: first.id, approvedBy: "user" });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: second.id, approvedBy: "user" });

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: first.id });
  const show = git(group.groupPath, ["show", "--name-only", "--format=", executed.commitHash]);
  const committedFiles = show.split(/\r?\n/).filter(Boolean);

  assert.ok(committedFiles.includes("src/first.js"));
  assert.ok(committedFiles.includes(`shared/file-ops/pending/${first.id}.json`));
  assert.equal(committedFiles.includes("src/second.js"), false);
  assert.equal(committedFiles.includes(`shared/file-ops/pending/${second.id}.json`), false);
  assert.equal(fs.existsSync(path.join(group.groupPath, "shared", "file-ops", "pending", `${second.id}.json`)), true);
  assert.match(git(group.groupPath, ["status", "--porcelain"]), new RegExp(`shared/file-ops/pending/${second.id}\\.json`));
});
test("execution refuses unrelated dirty framework state files", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/output.js",
    content: "export const ok = true;\n",
    reason: "Create module.",
    expected_effect: "Module exists."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });
  fs.writeFileSync(path.join(group.groupPath, "shared", "harness", "old-note.md"), "unrelated dirty framework state\n", "utf8");

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id
  }), /unrelated change: shared\/harness\/old-note\.md/);
});
test("full mode can auto-approve a non-dangerous write proposal", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/auto.js",
    content: "export const auto = true;\n",
    reason: "Create auto-approved module.",
    expected_effect: "Module exists."
  });

  const approved = autoApprovePendingFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id,
    mode: "full"
  });
  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: pending.id });

  assert.equal(approved.autoApproved, true);
  assert.equal(approved.approvedBy, "system:auto-full");
  assert.match(executed.commitHash, /^[0-9a-f]{7,}/);
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "auto.js"), "utf8"), "export const auto = true;\n");
});

test("full mode never auto-approves overwrite delete or bulk operations", () => {
  const overwriteGroup = createReadyGitGroup();
  fs.mkdirSync(path.join(overwriteGroup.groupPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(overwriteGroup.groupPath, "src", "existing.js"), "old\n", "utf8");
  git(overwriteGroup.groupPath, ["add", "--", "src/existing.js"]);
  git(overwriteGroup.groupPath, ["commit", "-m", "test: existing"]);
  const overwrite = createPendingProposal(overwriteGroup.groupPath, {
    op: "write",
    path: "src/existing.js",
    content: "new\n",
    reason: "Overwrite.",
    expected_effect: "Replaced."
  });
  assert.throws(() => autoApprovePendingFileOperation({
    groupPath: overwriteGroup.groupPath,
    proposalId: overwrite.id,
    mode: "full"
  }), /overwrite_requires_explicit_confirmation/);

  const deleteGroup = createReadyGitGroup();
  fs.writeFileSync(path.join(deleteGroup.groupPath, "old.txt"), "old\n", "utf8");
  git(deleteGroup.groupPath, ["add", "--", "old.txt"]);
  git(deleteGroup.groupPath, ["commit", "-m", "test: old file"]);
  const deletion = createPendingProposal(deleteGroup.groupPath, {
    op: "delete",
    path: "old.txt",
    reason: "Delete old file.",
    expected_effect: "Removed."
  });
  assert.throws(() => autoApprovePendingFileOperation({
    groupPath: deleteGroup.groupPath,
    proposalId: deletion.id,
    mode: "full"
  }), /auto_approval_only_allows_write_or_append/);

  const bulkGroup = createReadyGitGroup();
  const bulk = createPendingProposal(bulkGroup.groupPath, {
    op: "append",
    path: "notes.txt",
    content: "note\n",
    reason: "Append note.",
    expected_effect: "Note appended."
  });
  assert.throws(() => autoApprovePendingFileOperation({
    groupPath: bulkGroup.groupPath,
    proposalId: bulk.id,
    mode: "full",
    maxBatchSize: 2
  }), /bulk_requires_explicit_confirmation/);
});

test("automatic approval requires full mode", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "append",
    path: "notes.txt",
    content: "note\n",
    reason: "Append note.",
    expected_effect: "Note appended."
  });

  assert.throws(() => autoApprovePendingFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id,
    mode: "tool"
  }), /Full mode is required/);
});
function createReadyGitGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-exec-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "file-exec",
    members: [{ seatId: "executor", displayName: "Executor", model: "deepseek" }]
  });
  git(group.groupPath, ["init"]);
  git(group.groupPath, ["config", "user.email", "test@example.com"]);
  git(group.groupPath, ["config", "user.name", "Test User"]);
  git(group.groupPath, ["add", "."]);
  git(group.groupPath, ["commit", "-m", "test: initial workspace"]);
  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Create approved files.",
    recorderSeatId: "executor"
  });
  approveExecutionStandards({ groupPath: group.groupPath, approvedBy: "user" });
  git(group.groupPath, ["add", "."]);
  git(group.groupPath, ["commit", "-m", "test: approve standards"]);
  return group;
}

function createPendingProposal(groupPath, operation) {
  const parsed = parseFileOperationProposals({
    groupRoot: groupPath,
    source: { file_operations: [operation] },
    proposedBy: { seatId: "executor", name: "Executor" }
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