import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initGroupWorkspace } from "../src/workspaceManager.js";
import { addReview, createRecorderDraft, finalizeDraft, listApproved, listDrafts } from "../src/writeFlow.js";

function createGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-write-"));
  return initGroupWorkspace({
    root,
    groupFolderName: "write-flow",
    members: [
      { seatId: "recorder", displayName: "Recorder", model: "gpt-5" },
      { seatId: "reviewer", displayName: "Reviewer", model: "claude" }
    ]
  });
}

test("recorder can create a draft without reviewers", () => {
  const group = createGroup();
  const { draft, draftPath } = createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    content: "Remember: user prefers quiet UI."
  });

  assert.equal(draft.status, "pending_user_final_approval");
  assert.equal(draft.recorderName, "Recorder");
  assert.ok(fs.existsSync(draftPath));
  assert.equal(listDrafts(group.groupPath).length, 1);
});

test("assigned reviewer must review before final approval", () => {
  const group = createGroup();
  const { draft } = createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    reviewerSeatIds: ["reviewer"],
    content: "A reviewed note."
  });

  assert.equal(draft.status, "pending_review");
  assert.throws(() => finalizeDraft({
    groupPath: group.groupPath,
    draftId: draft.id,
    approvedBy: "user"
  }), /not ready/);

  const reviewed = addReview({
    groupPath: group.groupPath,
    draftId: draft.id,
    reviewerSeatId: "reviewer",
    verdict: "approve",
    comment: "Looks good."
  });
  assert.equal(reviewed.draft.status, "pending_user_final_approval");
});

test("final approval moves draft into approved folder", () => {
  const group = createGroup();
  const { draft } = createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    content: "Approved note."
  });

  const finalized = finalizeDraft({
    groupPath: group.groupPath,
    draftId: draft.id,
    approvedBy: "user"
  });

  assert.ok(fs.existsSync(finalized.finalPath));
  assert.equal(finalized.draft.status, "approved");
  assert.equal(listDrafts(group.groupPath).length, 0);
  assert.equal(listApproved(group.groupPath).length, 1);
});

test("drafts can be filtered by status", () => {
  const group = createGroup();
  createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    reviewerSeatIds: ["reviewer"],
    content: "Needs review."
  });
  createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    content: "Ready for approval."
  });

  assert.equal(listDrafts(group.groupPath, { status: "pending_review" }).length, 1);
  assert.equal(listDrafts(group.groupPath, { status: "pending_user_final_approval" }).length, 1);
});

test("a rejected review blocks final approval", () => {
  const group = createGroup();
  const { draft } = createRecorderDraft({
    groupPath: group.groupPath,
    recorderSeatId: "recorder",
    reviewerSeatIds: ["reviewer"],
    content: "Needs changes."
  });

  const reviewed = addReview({
    groupPath: group.groupPath,
    draftId: draft.id,
    reviewerSeatId: "reviewer",
    verdict: "reject",
    comment: "This needs revision."
  });

  assert.equal(reviewed.draft.status, "changes_requested");
  assert.throws(() => finalizeDraft({
    groupPath: group.groupPath,
    draftId: draft.id,
    approvedBy: "user"
  }), /not ready/);
});
