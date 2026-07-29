import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { addMember, initGroupWorkspace, reorderSeats, replaceMember } from "../src/workspaceManager.js";

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

test("adding a member creates a new seat and private folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-ws-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "test-group",
    members: [{ seatId: "seat_01", displayName: "成员 1", model: "mock-builder" }]
  });

  const result = addMember({
    groupPath: group.groupPath,
    displayName: "新成员",
    model: "mock-extra"
  });
  const saved = JSON.parse(fs.readFileSync(path.join(group.groupPath, "group.json"), "utf8"));

  assert.equal(result.seat.seatId, "seat_02");
  assert.equal(result.seat.displayName, "新成员");
  assert.equal(saved.seats.length, 2);
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "新成员", "handoff.md")));
});

test("adding a member stores full configuration, role flags, and permission tier", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-ws-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "configured-group",
    members: [{ seatId: "seat_01", displayName: "成员 1", model: "mock-builder" }]
  });

  const result = addMember({
    groupPath: group.groupPath,
    displayName: "审查员",
    model: "deepseek-chat",
    providerPreset: "deepseek",
    apiBaseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    credentialPoolId: "deepseek-primary",
    permission: "tool",
    role: "reviewer",
    reviewIntensity: 3
  });
  const saved = JSON.parse(fs.readFileSync(path.join(group.groupPath, "group.json"), "utf8"));
  const savedSeat = saved.seats.find((seat) => seat.seatId === result.seat.seatId);

  assert.equal(savedSeat.displayName, "审查员");
  assert.equal(savedSeat.model, "deepseek-chat");
  assert.equal(savedSeat.currentModel, "deepseek-chat");
  assert.equal(savedSeat.providerPreset, "deepseek");
  assert.equal(savedSeat.apiBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(savedSeat.apiUrl, "https://api.deepseek.com/v1");
  assert.equal(savedSeat.apiKey, "sk-test");
  assert.equal(savedSeat.credentialPoolId, "deepseek-primary");
  assert.equal(savedSeat.role, "reviewer");
  assert.equal(savedSeat.reviewer, true);
  assert.equal(savedSeat.mandatoryRedTeam, true);
  assert.equal(savedSeat.judge, false);
  assert.equal(savedSeat.reviewIntensity, 3);
  assert.equal(saved.permissions.seatTiers[result.seat.seatId], "tool");

  const summarizer = addMember({
    groupPath: group.groupPath,
    displayName: "总结者",
    model: "gpt-4.1-mini",
    providerPreset: "openai",
    apiBaseUrl: "https://api.openai.com/v1",
    permission: "text",
    role: "summarizer"
  });
  const savedAgain = JSON.parse(fs.readFileSync(path.join(group.groupPath, "group.json"), "utf8"));
  const summarizerSeat = savedAgain.seats.find((seat) => seat.seatId === summarizer.seat.seatId);
  assert.equal(summarizerSeat.role, "summarizer");
  assert.equal(summarizerSeat.reviewer, false);
  assert.equal(summarizerSeat.mandatoryRedTeam, false);
  assert.equal(summarizerSeat.judge, true);
  assert.equal(savedAgain.permissions.seatTiers[summarizer.seat.seatId], "text");
});

test("reordering seats persists the exact member order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-reorder-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "ordered-group",
    members: [
      { seatId: "member", displayName: "成员", model: "deepseek-chat" },
      { seatId: "reviewer", displayName: "审查者", model: "deepseek-chat", role: "reviewer" },
      { seatId: "judge", displayName: "总结者", model: "deepseek-chat", role: "summarizer" }
    ]
  });

  const result = reorderSeats({
    groupPath: group.groupPath,
    seatIds: ["judge", "member", "reviewer"]
  });
  const saved = JSON.parse(fs.readFileSync(path.join(group.groupPath, "group.json"), "utf8"));

  assert.deepEqual(result.group.seats.map((seat) => seat.seatId), ["judge", "member", "reviewer"]);
  assert.deepEqual(saved.seats.map((seat) => seat.displayName), ["总结者", "成员", "审查者"]);
  assert.throws(
    () => reorderSeats({ groupPath: group.groupPath, seatIds: ["judge", "member"] }),
    /every current seat exactly once/,
  );
  assert.throws(
    () => reorderSeats({ groupPath: group.groupPath, seatIds: ["judge", "judge", "member"] }),
    /duplicate/,
  );
});
