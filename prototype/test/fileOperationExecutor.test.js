import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { approvePendingFileOperation, autoApprovePendingFileOperation, executeApprovedFileOperation, rejectPendingFileOperation, restoreDeletedFileOperation } from "../src/fileOperationExecutor.js";
import { createDeletionBackup, readDeletionBackup, recoverySummary } from "../src/fileRecovery.js";
import { parseFileOperationProposals } from "../src/fileOperations.js";
import { enqueueFileOperationProposals, listPendingFileOperationProposals, readFileOperationAuditLog, updatePendingFileOperationProposal } from "../src/fileOperationQueue.js";
import { hasMaterialWorkspaceChange } from "../src/observationCache.js";
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

test("approved identical rewrite is verified but does not count as material project progress", () => {
  const group = createReadyGitGroup();
  const target = path.join(group.groupPath, "src", "same.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const same = true;\n", "utf8");
  git(group.groupPath, ["add", "--", "src/same.js"]);
  git(group.groupPath, ["commit", "-m", "test: add same source"]);
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/same.js",
    content: "export const same = true;\n",
    reason: "Rewrite existing bytes.",
    expected_effect: "No project byte change."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user", dangerousConfirmed: true });

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: pending.id, dangerousConfirmed: true });

  assert.equal(executed.verification.ok, true);
  assert.equal(executed.verification.changed, false);
  assert.equal(hasMaterialWorkspaceChange(executed), false);
  assert.equal(fs.readFileSync(target, "utf8"), "export const same = true;\n");
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

test("pending proposals can be rejected without touching files", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/rejected.js",
    content: "export const rejected = true;\n",
    reason: "Create rejected module.",
    expected_effect: "Module would exist."
  });

  const rejected = rejectPendingFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id,
    rejectedBy: "user"
  });

  assert.equal(rejected.status, "rejected");
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "rejected.js")), false);
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "rejected" && item.id === pending.id), true);
  assert.throws(() => approvePendingFileOperation({
    groupPath: group.groupPath,
    proposalId: pending.id,
    approvedBy: "user"
  }), /not pending user approval/);
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

test("execution ignores runtime log and session state dirtiness", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/runtime-ok.js",
    content: "export const runtimeOk = true;\n",
    reason: "Create module while runtime logs are changing.",
    expected_effect: "Module exists."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });
  fs.mkdirSync(path.join(group.groupPath, "_supervisor"), { recursive: true });
  fs.mkdirSync(path.join(group.groupPath, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(group.groupPath, "shared", "logs"), { recursive: true });
  fs.mkdirSync(path.join(group.groupPath, "shared", "cache"), { recursive: true });
  fs.mkdirSync(path.join(group.groupPath, "shared", "usage"), { recursive: true });
  fs.writeFileSync(path.join(group.groupPath, "_supervisor", "events.jsonl"), "runtime event\n", "utf8");
  fs.writeFileSync(path.join(group.groupPath, "sessions", "active.json"), "{}", "utf8");
  fs.writeFileSync(path.join(group.groupPath, "shared", "logs", "commands.jsonl"), "runtime command\n", "utf8");
  fs.writeFileSync(path.join(group.groupPath, "shared", "cache", "compressed-transcript.jsonl"), "runtime cache\n", "utf8");
  fs.writeFileSync(path.join(group.groupPath, "shared", "usage", "usage.jsonl"), "runtime usage\n", "utf8");
  fs.writeFileSync(path.join(group.groupPath, "shared", "task_state.json"), "{}", "utf8");

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: pending.id });

  assert.equal(executed.status, "executed");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "runtime-ok.js"), "utf8"), "export const runtimeOk = true;\n");
});

test("execution ignores member private memory dirtiness", () => {
  const group = createReadyGitGroup();
  const pending = createPendingProposal(group.groupPath, {
    op: "write",
    path: "src/private-memory-ok.js",
    content: "export const privateMemoryOk = true;\n",
    reason: "Create module while member memory is changing.",
    expected_effect: "Module exists."
  });
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: pending.id, approvedBy: "user" });
  const memoryDir = path.join(group.groupPath, "members", "Builder", "private_memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "usage.jsonl"), "{\"tokens\":1}\n", "utf8");

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: pending.id });

  assert.equal(executed.status, "executed");
  assert.equal(
    fs.readFileSync(path.join(group.groupPath, "src", "private-memory-ok.js"), "utf8"),
    "export const privateMemoryOk = true;\n"
  );
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

test("full mode auto-approves overwrite delete and larger batches inside the workspace", () => {
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
  const overwriteApproval = autoApprovePendingFileOperation({
    groupPath: overwriteGroup.groupPath,
    proposalId: overwrite.id,
    mode: "full"
  });
  const overwriteExecuted = executeApprovedFileOperation({ groupPath: overwriteGroup.groupPath, proposalId: overwrite.id });
  assert.equal(overwriteApproval.dangerousConfirmed, true);
  assert.equal(overwriteExecuted.status, "executed");
  assert.equal(fs.readFileSync(path.join(overwriteGroup.groupPath, "src", "existing.js"), "utf8"), "new\n");

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
  const deleteApproval = autoApprovePendingFileOperation({
    groupPath: deleteGroup.groupPath,
    proposalId: deletion.id,
    mode: "full"
  });
  const deleteExecuted = executeApprovedFileOperation({ groupPath: deleteGroup.groupPath, proposalId: deletion.id });
  assert.equal(deleteApproval.dangerousConfirmed, true);
  assert.equal(deleteExecuted.status, "executed");
  assert.equal(fs.existsSync(path.join(deleteGroup.groupPath, "old.txt")), false);
  assert.equal(deleteExecuted.recovery.status, "deleted");
  assert.equal(deleteExecuted.recovery.sourcePath, "old.txt");
  assert.equal(deleteExecuted.recovery.sizeBytes, Buffer.byteLength("old\n"));
  assert.match(deleteExecuted.recovery.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(deleteGroup.groupPath, deleteExecuted.recovery.backupPath)), true);
  assert.equal(git(deleteGroup.groupPath, ["status", "--porcelain"]), "");

  const bulkGroup = createReadyGitGroup();
  const bulk = createPendingProposal(bulkGroup.groupPath, {
    op: "append",
    path: "notes.txt",
    content: "note\n",
    reason: "Append note.",
    expected_effect: "Note appended."
  });
  const bulkApproval = autoApprovePendingFileOperation({
    groupPath: bulkGroup.groupPath,
    proposalId: bulk.id,
    mode: "full",
    maxBatchSize: 2
  });
  const bulkExecuted = executeApprovedFileOperation({ groupPath: bulkGroup.groupPath, proposalId: bulk.id });
  assert.equal(bulkApproval.status, "approved");
  assert.equal(bulkExecuted.status, "executed");
});

test("deleted binary files restore byte-for-byte from a verified internal backup", () => {
  const group = createReadyGitGroup();
  const original = Buffer.from([0, 255, 1, 2, 13, 10, 42, 99]);
  fs.mkdirSync(path.join(group.groupPath, "assets"), { recursive: true });
  fs.writeFileSync(path.join(group.groupPath, "assets", "binary.dat"), original);
  git(group.groupPath, ["add", "--", "assets/binary.dat"]);
  git(group.groupPath, ["commit", "-m", "test: binary source"]);
  const deletion = createPendingProposal(group.groupPath, {
    op: "delete",
    path: "assets/binary.dat",
    reason: "Delete a binary file.",
    expected_effect: "The binary file is recoverable."
  });
  autoApprovePendingFileOperation({ groupPath: group.groupPath, proposalId: deletion.id, mode: "full" });

  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: deletion.id });
  assert.equal(fs.existsSync(path.join(group.groupPath, "assets", "binary.dat")), false);
  assert.equal(readDeletionBackup(group.groupPath, deletion.id).status, "deleted");
  assert.throws(() => restoreDeletedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id
  }), /restore_requires_confirmation/);

  const restored = restoreDeletedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    restoredBy: "user",
    confirmed: true
  });

  assert.equal(restored.status, "restored");
  assert.equal(restored.verification.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(group.groupPath, "assets", "binary.dat")), original);
  assert.equal(readDeletionBackup(group.groupPath, deletion.id).status, "restored");
  assert.match(restored.commitHash, /^[0-9a-f]{7,}/);
  assert.equal(git(group.groupPath, ["status", "--porcelain"]), "");
  const actions = readFileOperationAuditLog(group.groupPath)
    .filter((item) => item.id === deletion.id)
    .map((item) => item.action);
  assert.ok(actions.includes("delete_backup_prepared"));
  assert.ok(actions.includes("executed"));
  assert.ok(actions.includes("restored"));
  assert.throws(() => restoreDeletedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    confirmed: true
  }), /already restored/);
  const deletionShow = git(group.groupPath, ["show", "--name-only", "--format=", executed.commitHash]);
  const restoreShow = git(group.groupPath, ["show", "--name-only", "--format=", restored.commitHash]);
  assert.doesNotMatch(`${deletionShow}\n${restoreShow}`, /shared\/file-ops\/recovery/);
});

test("delete fails closed when a complete backup cannot be created", () => {
  const group = createReadyGitGroup();
  fs.writeFileSync(path.join(group.groupPath, "large.bin"), Buffer.alloc(32, 7));
  git(group.groupPath, ["add", "--", "large.bin"]);
  git(group.groupPath, ["commit", "-m", "test: large delete source"]);
  const deletion = createPendingProposal(group.groupPath, {
    op: "delete",
    path: "large.bin",
    reason: "Attempt a delete with a deliberately tiny backup limit.",
    expected_effect: "Deletion fails closed."
  });
  autoApprovePendingFileOperation({ groupPath: group.groupPath, proposalId: deletion.id, mode: "full" });

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    maxBackupBytes: 8
  }), /backup exceeds/);
  assert.deepEqual(fs.readFileSync(path.join(group.groupPath, "large.bin")), Buffer.alloc(32, 7));
  assert.equal(fs.existsSync(path.join(group.groupPath, "shared", "file-ops", "recovery", deletion.id)), false);
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.id === deletion.id && item.action === "delete_backup_failed"), true);
});

test("restore refuses a tampered backup and leaves the deleted target absent", () => {
  const group = createReadyGitGroup();
  fs.writeFileSync(path.join(group.groupPath, "tamper.txt"), "ORIGINAL", "utf8");
  git(group.groupPath, ["add", "--", "tamper.txt"]);
  git(group.groupPath, ["commit", "-m", "test: tamper source"]);
  const deletion = createPendingProposal(group.groupPath, {
    op: "delete",
    path: "tamper.txt",
    reason: "Delete before tamper test.",
    expected_effect: "Tampered backup is rejected."
  });
  autoApprovePendingFileOperation({ groupPath: group.groupPath, proposalId: deletion.id, mode: "full" });
  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: deletion.id });
  fs.writeFileSync(path.join(group.groupPath, executed.recovery.backupPath), "TAMPERED", "utf8");

  assert.throws(() => restoreDeletedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    confirmed: true
  }), /hash does not match|size does not match/);
  assert.equal(fs.existsSync(path.join(group.groupPath, "tamper.txt")), false);
});

test("restore recovers an interrupted deletion after the backup and file removal", () => {
  const group = createReadyGitGroup();
  fs.writeFileSync(path.join(group.groupPath, "interrupted.txt"), "INTERRUPTED", "utf8");
  git(group.groupPath, ["add", "--", "interrupted.txt"]);
  git(group.groupPath, ["commit", "-m", "test: interrupted source"]);
  const deletion = createPendingProposal(group.groupPath, {
    op: "delete",
    path: "interrupted.txt",
    reason: "Simulate interruption after backup.",
    expected_effect: "Recovery remains possible."
  });
  autoApprovePendingFileOperation({ groupPath: group.groupPath, proposalId: deletion.id, mode: "full" });
  const backup = createDeletionBackup({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    sourcePath: "interrupted.txt",
    sourceAbsolutePath: path.join(group.groupPath, "interrupted.txt")
  });
  updatePendingFileOperationProposal(group.groupPath, {
    ...deletion,
    status: "approved",
    dangerousConfirmed: true,
    recovery: recoverySummary(backup)
  });
  fs.rmSync(path.join(group.groupPath, "interrupted.txt"));
  assert.equal(git(group.groupPath, ["status", "--porcelain"]).includes("shared/file-ops/recovery"), false);

  const restored = restoreDeletedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    confirmed: true
  });
  assert.equal(restored.status, "restored");
  assert.equal(fs.readFileSync(path.join(group.groupPath, "interrupted.txt"), "utf8"), "INTERRUPTED");
});

test("delete stops if the source no longer matches its completed backup", () => {
  const group = createReadyGitGroup();
  fs.writeFileSync(path.join(group.groupPath, "changed.txt"), "FIRST", "utf8");
  git(group.groupPath, ["add", "--", "changed.txt"]);
  git(group.groupPath, ["commit", "-m", "test: changing source"]);
  const deletion = createPendingProposal(group.groupPath, {
    op: "delete",
    path: "changed.txt",
    reason: "Do not delete a changed source.",
    expected_effect: "Mismatched content remains."
  });
  autoApprovePendingFileOperation({ groupPath: group.groupPath, proposalId: deletion.id, mode: "full" });
  const backup = createDeletionBackup({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    sourcePath: "changed.txt",
    sourceAbsolutePath: path.join(group.groupPath, "changed.txt")
  });
  updatePendingFileOperationProposal(group.groupPath, {
    ...deletion,
    status: "approved",
    dangerousConfirmed: true,
    recovery: recoverySummary(backup)
  });
  fs.writeFileSync(path.join(group.groupPath, "changed.txt"), "SECOND", "utf8");

  assert.throws(() => executeApprovedFileOperation({
    groupPath: group.groupPath,
    proposalId: deletion.id,
    allowUnrelatedDirtyFiles: true
  }), /source file changed/i);
  assert.equal(fs.readFileSync(path.join(group.groupPath, "changed.txt"), "utf8"), "SECOND");
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
