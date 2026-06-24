import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { approvePendingFileOperation, executeApprovedFileOperation } from "../src/fileOperationExecutor.js";
import { parseFileOperationProposals } from "../src/fileOperations.js";
import { enqueueFileOperationProposals, listFileOperationReviewItems, readFileOperationAuditLog } from "../src/fileOperationQueue.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("file operation workflow queues previews approves executes commits and supports git handoff", () => {
  const group = createReadyGitGroup();
  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Create src/hello.js with a small greeting export.",
    recorderSeatId: "executor"
  });
  approveExecutionStandards({ groupPath: group.groupPath, approvedBy: "user" });
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    proposedBy: { seatId: "executor", name: "Executor" },
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/hello.js",
          content: "export function hello(name = 'world') {\n  return `hello ${name}`;\n}\n",
          reason: "Add the requested greeting module.",
          expected_effect: "A reusable hello function exists."
        }
      ]
    }
  });

  const queued = enqueueFileOperationProposals({ groupPath: group.groupPath, accepted: parsed.accepted, rejected: parsed.rejected });
  const reviewItems = listFileOperationReviewItems(group.groupPath);
  approvePendingFileOperation({ groupPath: group.groupPath, proposalId: queued.queued[0].id, approvedBy: "user" });
  const executed = executeApprovedFileOperation({ groupPath: group.groupPath, proposalId: queued.queued[0].id });

  assert.equal(queued.queued.length, 1);
  assert.equal("content" in reviewItems[0], false);
  assert.match(reviewItems[0].preview.text, /hello/);
  assert.equal(fs.readFileSync(path.join(group.groupPath, "src", "hello.js"), "utf8"), "export function hello(name = 'world') {\n  return `hello ${name}`;\n}\n");
  assert.match(executed.commitHash, /^[0-9a-f]{7,}/);
  assert.equal(git(group.groupPath, ["status", "--porcelain"]), "");
  const show = git(group.groupPath, ["show", "--name-only", "--oneline", executed.commitHash]);
  assert.match(show, /src\/hello\.js/);
  assert.match(show, /shared\/file-ops\/pending/);
  assert.match(show, /shared\/logs\/file-ops\.jsonl/);
  assert.equal(readFileOperationAuditLog(group.groupPath).some((item) => item.action === "executed"), true);
});

test("file operation workflow rejects forbidden paths before queueing", () => {
  const group = createReadyGitGroup();
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    source: {
      file_operations: [
        {
          op: "write",
          path: ".env",
          content: "SECRET=bad\n",
          reason: "Try to write a secret file.",
          expected_effect: "Should be blocked."
        },
        {
          op: "read",
          path: "../outside.txt",
          reason: "Try to escape the group root.",
          expected_effect: "Should be blocked."
        }
      ]
    }
  });

  assert.equal(parsed.accepted.length, 0);
  assert.equal(parsed.rejected.length, 2);
  assert.deepEqual(parsed.rejected.map((item) => item.code).sort(), ["forbidden_secret_file", "path_escape_denied"].sort());
});

function createReadyGitGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-workflow-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "workflow-group",
    members: [{ seatId: "executor", displayName: "Executor", model: "deepseek" }]
  });
  git(group.groupPath, ["init"]);
  git(group.groupPath, ["config", "user.email", "test@example.com"]);
  git(group.groupPath, ["config", "user.name", "Test User"]);
  git(group.groupPath, ["add", "--", "."]);
  git(group.groupPath, ["commit", "-m", "test: initialize group"]);
  return group;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}