import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { parseFileOperationProposals } from "../src/fileOperations.js";
import { enqueueFileOperationProposals, listFileOperationReviewItems, listPendingFileOperationProposals, readFileOperationAuditLog } from "../src/fileOperationQueue.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("file operation queue allows read/list pending without approved execution standards", () => {
  const group = createGroup();
  fs.writeFileSync(path.join(group.groupPath, "README.md"), "hello", "utf8");
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    source: {
      file_operations: [
        {
          op: "read",
          path: "README.md",
          reason: "Inspect docs.",
          expected_effect: "Docs context is available."
        }
      ]
    },
    proposedBy: { seatId: "executor", name: "Executor" }
  });

  const result = enqueueFileOperationProposals({
    groupPath: group.groupPath,
    accepted: parsed.accepted,
    rejected: parsed.rejected
  });

  assert.equal(result.queued.length, 1);
  assert.equal(result.queued[0].status, "pending_user_approval");
  assert.equal(listPendingFileOperationProposals(group.groupPath).length, 1);
});

test("file operation queue rejects write-like proposals until standards are approved", () => {
  const group = createGroup();
  const fakeSecret = "sk" + "-test-should-not-log";
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/output.js",
          content: `export const key = '${fakeSecret}';`,
          reason: "Create module.",
          expected_effect: "Module exists."
        }
      ]
    }
  });

  const result = enqueueFileOperationProposals({
    groupPath: group.groupPath,
    accepted: parsed.accepted,
    rejected: parsed.rejected
  });
  const auditText = fs.readFileSync(path.join(group.groupPath, "shared", "logs", "file-ops.jsonl"), "utf8");

  assert.equal(result.queued.length, 0);
  assert.equal(result.rejected[0].code, "execution_standards_not_approved");
  assert.equal(listPendingFileOperationProposals(group.groupPath).length, 0);
  assert.doesNotMatch(auditText, new RegExp(fakeSecret));
  assert.match(auditText, /content_summary/);
});

test("file operation queue stores approved write-like proposals and audit records", () => {
  const group = createGroup();
  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Create a small module.",
    recorderSeatId: "executor"
  });
  approveExecutionStandards({
    groupPath: group.groupPath,
    approvedBy: "user"
  });
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/output.js",
          content: "export const ok = true;",
          reason: "Create module.",
          expected_effect: "Module exists."
        },
        {
          op: "read",
          path: ".env",
          reason: "Read secret.",
          expected_effect: "Should be rejected."
        }
      ]
    },
    proposedBy: { seatId: "executor", name: "Executor" }
  });

  const result = enqueueFileOperationProposals({
    groupPath: group.groupPath,
    accepted: parsed.accepted,
    rejected: parsed.rejected
  });
  const pending = listPendingFileOperationProposals(group.groupPath);
  const audit = readFileOperationAuditLog(group.groupPath);

  assert.equal(result.queued.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].op, "write");
  assert.equal(pending[0].content, "export const ok = true;");
  assert.equal(audit.filter((item) => item.action === "queued").length, 1);
  assert.equal(audit.filter((item) => item.action === "rejected").length, 1);
  assert.equal(fs.existsSync(path.join(group.groupPath, "src", "output.js")), false);
});


test("file operation review items hide raw content and show redacted preview", () => {
  const group = createGroup();
  const fakeSecret = "sk" + "-secret-review-preview";
  prepareExecutionStandards({
    groupPath: group.groupPath,
    finalAnswer: "Create a small module.",
    recorderSeatId: "executor"
  });
  approveExecutionStandards({ groupPath: group.groupPath, approvedBy: "user" });
  const parsed = parseFileOperationProposals({
    groupRoot: group.groupPath,
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/output.js",
          content: `export const apiKey = '${fakeSecret}';\n`,
          reason: "Create module.",
          expected_effect: "Module exists."
        }
      ]
    },
    proposedBy: { seatId: "executor", name: "Executor" }
  });
  enqueueFileOperationProposals({ groupPath: group.groupPath, accepted: parsed.accepted, rejected: parsed.rejected });

  const reviewItems = listFileOperationReviewItems(group.groupPath);

  assert.equal(reviewItems.length, 1);
  assert.equal("content" in reviewItems[0], false);
  assert.equal("resolvedPath" in reviewItems[0], false);
  assert.match(reviewItems[0].preview.text, /sk-\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(reviewItems[0]), new RegExp(fakeSecret));
  assert.equal(reviewItems[0].content_summary.redacted, true);
});
function createGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-queue-"));
  return initGroupWorkspace({
    root,
    groupFolderName: "file-queue",
    members: [
      { seatId: "executor", displayName: "Executor", model: "deepseek" }
    ]
  });
}
