import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initGroupWorkspace, replaceMember } from "../src/workspaceManager.js";

test("initializes custom group workspace with shared and member folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-ws-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "产品决策组",
    members: [
      { seatId: "builder", displayName: "gpt-5", model: "gpt-5", role: "Builder" },
      { seatId: "critic", displayName: "claude", model: "claude-opus", role: "Critic" }
    ]
  });

  assert.equal(group.groupFolderName, "产品决策组");
  assert.equal(group.seats.length, 2);
  assert.ok(fs.existsSync(path.join(group.groupPath, "shared", "approved")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "gpt-5", "private_memory")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "claude", "handoff.md")));
});

test("replacement inherits previous private folder by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-ws-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "test-group",
    members: [{ seatId: "builder", displayName: "gpt-5", model: "gpt-5" }]
  });

  const before = group.seats[0].privateFolder;
  const result = replaceMember({
    groupPath: group.groupPath,
    seatId: "builder",
    nextDisplayName: "gpt-6",
    nextModel: "gpt-6"
  });

  assert.equal(result.seat.privateFolder, before);
  assert.equal(result.seat.previous.displayName, "gpt-5");
});

test("replacement can create a new private folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-ws-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "test-group",
    members: [{ seatId: "builder", displayName: "gpt-5", model: "gpt-5" }]
  });

  const before = group.seats[0].privateFolder;
  const result = replaceMember({
    groupPath: group.groupPath,
    seatId: "builder",
    nextDisplayName: "gpt-6",
    nextModel: "gpt-6",
    newPrivateFolder: true,
    folderName: "gpt-6-fresh"
  });

  assert.notEqual(result.seat.privateFolder, before);
  assert.equal(result.seat.privateFolder, "members/gpt-6-fresh");
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "gpt-6-fresh", "handoff.md")));
});
