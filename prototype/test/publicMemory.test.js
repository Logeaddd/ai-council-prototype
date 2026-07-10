import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSummarizerPublicMemories,
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

test("summarizer memories keep provenance, filter meeting notes, and deduplicate content", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-summarizer-memory-"));
  const first = appendSummarizerPublicMemories(groupPath, [
    "Project rule: Keep release artifacts under dist.",
    "Next action: run the build in this discussion."
  ], {
    sourceSessionId: "session_summary_1",
    sourceAgentId: "finalizer",
    sourceAgentName: "Finalizer"
  });
  const second = appendSummarizerPublicMemories(groupPath, [
    "  PROJECT RULE:   Keep release artifacts under dist.  "
  ], {
    sourceSessionId: "session_summary_2",
    sourceAgentId: "finalizer",
    sourceAgentName: "Finalizer"
  });

  assert.equal(first.savedCount, 1);
  assert.equal(first.durableCount, 1);
  assert.equal(second.savedCount, 0);
  assert.equal(second.duplicateCount, 1);
  const memories = listPublicMemories(groupPath);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].source, "summarizer");
  assert.equal(memories[0].sourceAgentId, "finalizer");
  assert.equal(memories[0].sourceSessionId, "session_summary_1");
  assert.equal(memories[0].provenance, "editable_summary_not_original_fact");
  assert.match(formatPublicMemoriesForPrompt(groupPath), /editable summary; not original fact/);
});

test("summarizer durable filter supports Chinese memory labels without storing meeting actions", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-chinese-memory-"));
  const result = appendSummarizerPublicMemories(groupPath, [
    "项目规则：发布文件统一放在 dist 目录。",
    "下一步：本轮运行构建。"
  ], {
    sourceSessionId: "session_cn",
    sourceAgentId: "summarizer",
    sourceAgentName: "总结者"
  });

  assert.equal(result.savedCount, 1);
  assert.equal(result.savedIds.length, 1);
  assert.equal(listPublicMemories(groupPath)[0].content, "项目规则：发布文件统一放在 dist 目录。");
});
