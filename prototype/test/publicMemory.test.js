import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendAgentSemanticPublicMemories,
  appendSummarizerPublicMemories,
  deletePublicMemory,
  extractExplicitUserMemory,
  formatPublicMemoriesForPrompt,
  listPublicMemories,
  rememberExplicitUserMemory,
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

test("explicit user directives are captured with original provenance and deduplicated", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-explicit-memory-"));
  const directive = "记住：不要为了完成单项任务迎合用户，我们做的是通用 agent。";

  const first = rememberExplicitUserMemory(groupPath, directive, {
    sourceSessionId: "session_explicit_1",
    createdAt: "2026-07-19T01:02:03.000Z"
  });
  const second = rememberExplicitUserMemory(groupPath, directive, {
    sourceSessionId: "session_explicit_2"
  });

  assert.equal(first.status, "saved");
  assert.equal(first.savedCount, 1);
  assert.equal(second.status, "no_new_memory");
  assert.equal(second.duplicateCount, 1);
  const memories = listPublicMemories(groupPath);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, directive);
  assert.equal(memories[0].source, "user_explicit");
  assert.equal(memories[0].sourceSessionId, "session_explicit_1");
  assert.equal(memories[0].createdBy, "user");
  assert.equal(memories[0].provenance, "original_user_directive");
  assert.match(formatPublicMemoriesForPrompt(groupPath), /authoritative user instructions/);
  assert.match(formatPublicMemoriesForPrompt(groupPath), /Provenance: original user directive/);
});

test("explicit memory extraction rejects questions and examples", () => {
  assert.deepEqual(extractExplicitUserMemory("你还记得我说过什么吗？"), []);
  assert.deepEqual(extractExplicitUserMemory("我让他记住什么，它真的能计入记忆吗？"), []);
  assert.deepEqual(extractExplicitUserMemory("例如，记住：这里展示的是示例文案。"), []);
  assert.deepEqual(extractExplicitUserMemory("Do you remember what I said?"), []);
  assert.deepEqual(extractExplicitUserMemory("从现在起，所有成员必须保留用户的原始要求。"), ["从现在起，所有成员必须保留用户的原始要求。"]);
});

test("disabled explicit memory does not create a memory file", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-explicit-memory-disabled-"));
  const result = rememberExplicitUserMemory(groupPath, "请记住：DISABLED_EXPLICIT_MEMORY", { enabled: false });

  assert.equal(result.status, "disabled");
  assert.deepEqual(listPublicMemories(groupPath), []);
  assert.equal(fs.existsSync(path.join(groupPath, "shared", "memory", "public-memory.json")), false);
});

test("agent semantic memory accepts verbatim durable meaning in any language and rejects paraphrases", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-semantic-memory-"));
  const directives = [
    "wo xihuan mei ci dou gei chu ke yanzheng de zhengju",
    "Ich bevorzuge nachvollziehbare Belege statt kurzer Behauptungen.",
    "私は短い返事よりも、根拠のある詳しい説明を好みます。",
    "Мне нужны проверяемые доказательства, а не краткие заявления."
  ];
  const sourceText = directives.join("\n");
  const result = appendAgentSemanticPublicMemories(groupPath, [
    ...directives,
    "The user prefers evidence."
  ], {
    sourceText,
    sourceSessionId: "session_semantic",
    sourceAgentId: "member_semantic"
  });

  assert.equal(result.savedCount, 4);
  assert.equal(result.rejectedCount, 1);
  assert.deepEqual(listPublicMemories(groupPath).map((item) => item.content), directives);
  assert.ok(listPublicMemories(groupPath).every((item) => item.source === "user_semantic"));
  assert.ok(listPublicMemories(groupPath).every((item) => item.provenance === "original_user_directive"));
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
