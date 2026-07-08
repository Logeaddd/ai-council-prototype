import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  deletePublicMemory,
  formatPublicMemoriesForPrompt,
  listPublicMemories,
  upsertPublicMemory
} from "../src/publicMemory.js";

test("public memories can be created edited listed and deleted", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-public-memory-"));

  const created = upsertPublicMemory(groupPath, {
    title: "PetRabbit worldview",
    content: "The rabbit world treats star bonds as visible social status.",
    source: "summarizer",
    sourceSessionId: "session_1",
    createdBy: "Summarizer"
  });
  assert.equal(listPublicMemories(groupPath).length, 1);
  assert.equal(listPublicMemories(groupPath)[0].content.includes("star bonds"), true);

  const edited = upsertPublicMemory(groupPath, {
    ...created,
    content: "Edited public memory."
  });
  assert.equal(edited.id, created.id);
  assert.equal(listPublicMemories(groupPath)[0].content, "Edited public memory.");

  const deleted = deletePublicMemory(groupPath, created.id);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(listPublicMemories(groupPath), []);
});

test("public memories are formatted as editable summaries not source facts", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-public-memory-prompt-"));
  upsertPublicMemory(groupPath, {
    title: "Rule",
    content: "PUBLIC_MEMORY_SECRET",
    source: "user"
  });

  const prompt = formatPublicMemoriesForPrompt(groupPath);
  assert.match(prompt, /Public memory managed by the summarizer or user/);
  assert.match(prompt, /not as the original facts/);
  assert.match(prompt, /PUBLIC_MEMORY_SECRET/);
  assert.match(prompt, /Source: user/);
});
