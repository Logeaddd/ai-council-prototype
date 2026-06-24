import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendPrivateChatMessage, readPrivateChatMessages, readPrivateContextMessages } from "../src/privateChat.js";
import { initGroupWorkspace } from "../src/workspaceManager.js";

test("private chat persists to the target member inbox only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "private-chat-group",
    members: [
      { seatId: "builder", displayName: "Builder", model: "deepseek-chat" },
      { seatId: "critic", displayName: "Critic", model: "deepseek-chat" }
    ]
  });

  const privateText = "\u53ea\u7ed9 Builder \u7684\u4e0a\u4e0b\u6587\u3002";
  const message = appendPrivateChatMessage(group.groupPath, "builder", privateText);
  const builderInbox = path.join(group.groupPath, "members", "Builder", "inbox", "private-chat.jsonl");
  const criticInbox = path.join(group.groupPath, "members", "Critic", "inbox", "private-chat.jsonl");
  const sharedLog = path.join(group.groupPath, "shared", "logs", "private-chat.jsonl");

  assert.equal(message.audience, "builder");
  assert.ok(fs.existsSync(builderInbox));
  assert.equal(fs.existsSync(criticInbox), false);
  assert.match(fs.readFileSync(builderInbox, "utf8"), /Builder/);
  assert.doesNotMatch(fs.readFileSync(sharedLog, "utf8"), /Builder \u7684\u4e0a\u4e0b\u6587/);
  assert.equal(readPrivateChatMessages(group.groupPath, "builder")[0].text, privateText);
  assert.equal(readPrivateContextMessages(group.groupPath, "critic").length, 0);
});

test("private chat accepts custom member id aliases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-alias-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "private-chat-alias-group",
    members: [
      { seatId: "builder", displayName: "Builder", model: "deepseek-chat" }
    ]
  });
  const groupFile = path.join(group.groupPath, "group.json");
  const saved = JSON.parse(fs.readFileSync(groupFile, "utf8"));
  saved.seats[0].id = saved.seats[0].seatId;
  delete saved.seats[0].seatId;
  fs.writeFileSync(groupFile, JSON.stringify(saved, null, 2), "utf8");

  const message = appendPrivateChatMessage(group.groupPath, "builder", "Private note.");

  assert.equal(message.audience, "builder");
  assert.equal(readPrivateChatMessages(group.groupPath, "builder")[0].text, "Private note.");
});

test("private chat can create inbox for browser-only custom seats", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-browser-seat-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "private-chat-browser-seat",
    members: []
  });

  const message = appendPrivateChatMessage(group.groupPath, "seat_01", "Browser-only note.", {
    seat: { seatId: "seat_01", displayName: "Architect", role: "Planner" }
  });
  const inbox = path.join(group.groupPath, "members", "Architect-seat_01", "inbox", "private-chat.jsonl");

  assert.equal(message.seatName, "Architect");
  assert.ok(fs.existsSync(inbox));
  assert.equal(readPrivateChatMessages(group.groupPath, "seat_01", {
    seat: { seatId: "seat_01", displayName: "Architect" }
  })[0].text, "Browser-only note.");
});

test("private chat keeps same-name browser-only seats separate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-same-name-"));
  const group = initGroupWorkspace({
    root,
    groupFolderName: "private-chat-same-name",
    members: []
  });

  appendPrivateChatMessage(group.groupPath, "seat_01", "First note.", {
    seat: { seatId: "seat_01", displayName: "ai" }
  });
  appendPrivateChatMessage(group.groupPath, "seat_02", "Second note.", {
    seat: { seatId: "seat_02", displayName: "ai" }
  });

  assert.equal(readPrivateChatMessages(group.groupPath, "seat_01", {
    seat: { seatId: "seat_01", displayName: "ai" }
  })[0].text, "First note.");
  assert.equal(readPrivateChatMessages(group.groupPath, "seat_02", {
    seat: { seatId: "seat_02", displayName: "ai" }
  })[0].text, "Second note.");
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "ai-seat_01", "inbox", "private-chat.jsonl")));
  assert.ok(fs.existsSync(path.join(group.groupPath, "members", "ai-seat_02", "inbox", "private-chat.jsonl")));
});
