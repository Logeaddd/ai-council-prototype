import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readGroupIndex, recordIdForPath, removeGroupIndexRecord, updateGroupIndexRecord, upsertGroupIndexRecord } from "../src/groupIndex.js";

test("group index can create, pin, rename, and remove records without deleting folders", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-index-"));
  const groupPath = path.join(tmp, "real-group-folder");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "keep.txt"), "do not delete", "utf8");

  let index = upsertGroupIndexRecord(tmp, {
    name: "Alpha",
    path: groupPath
  });
  assert.equal(index.groups.length, 1);
  assert.equal(index.groups[0].name, "Alpha");
  assert.equal(index.groups[0].path, groupPath);

  index = updateGroupIndexRecord(tmp, index.groups[0].id, {
    name: "Pinned Alpha",
    pinned: true,
    lastOpenedAt: "2026-06-19T00:00:00.000Z"
  });
  assert.equal(index.groups[0].name, "Pinned Alpha");
  assert.equal(index.groups[0].pinned, true);
  assert.equal(index.lastGroupId, index.groups[0].id);

  index = removeGroupIndexRecord(tmp, index.groups[0].id);
  assert.equal(index.groups.length, 0);
  assert.equal(fs.existsSync(path.join(groupPath, "keep.txt")), true);
});

test("group index is stored under local user-data", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-index-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  upsertGroupIndexRecord(tmp, { path: groupPath, name: "Group" });
  assert.ok(fs.existsSync(path.join(tmp, "user-data", "groups-index.json")));
  assert.equal(readGroupIndex(tmp).groups[0].name, "Group");
});

test("distinct group paths under a long shared parent produce distinct ids", () => {
  const longParent = path.join(os.tmpdir(), "agent-council-very-long-shared-parent-folder", "prototype");
  const names = ["哲学", "哲学1", "哲学2", "完全不同的名字"];
  const ids = names.map((name) => recordIdForPath(path.join(longParent, name)));
  assert.equal(new Set(ids).size, names.length);
});

test("creating multiple groups keeps every record in the index", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-index-multi-"));
  const longParent = path.join(tmp, "agent-council-very-long-shared-parent-folder", "prototype");
  const names = ["哲学", "哲学1", "哲学2", "完全不同的名字"];
  let index;
  for (const name of names) {
    const groupPath = path.join(longParent, name);
    fs.mkdirSync(groupPath, { recursive: true });
    index = upsertGroupIndexRecord(tmp, {
      id: recordIdForPath(groupPath),
      name,
      path: groupPath
    });
  }
  assert.equal(index.groups.length, names.length);
  const indexedNames = new Set(index.groups.map((group) => group.name));
  for (const name of names) {
    assert.ok(indexedNames.has(name), `index missing group ${name}`);
  }
});
