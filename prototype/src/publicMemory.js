import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";
import { filterDurableMemoryCandidates } from "./storage.js";

const MAX_MEMORY_ITEMS = 80;
const MAX_MEMORY_TEXT = 4000;

const EXPLICIT_MEMORY_PATTERNS = [
  /(?:^|[\n。！？!?；;，,])\s*((?:我(?:现在|再次|再|明确)?(?:告诉|要求|提醒)你(?:们)?[，,:：\s]*)?(?:(?:请|务必|一定(?:要)?|必须)\s*)?(?:(?:你|你们|系统|所有成员|各成员|成员|AI|agent)\s*(?:要|必须|务必)?\s*)?记住(?!了?[吗么嘛]|没有|什么)[，,:：\s]+[^\n]+)/giu,
  /(?:^|[\n。！？!?；;])\s*((?:项目规则|长期规则|全局规则|永久规则|长期记忆|用户偏好|用户要求)\s*[：:]\s*[^\n]+)/giu,
  /(?:^|[\n。！？!?；;])\s*((?:以后|今后|从现在起|往后)[，,:：\s]*(?:(?:你|你们|系统|所有成员|各成员|成员|AI|agent)\s*)?(?:必须|务必|要|不要|不准|永远|始终|一律)\s*[^\n]+)/giu,
  /(?:^|[\n.!?;])\s*((?:(?:please|always|you must|you need to)\s+)?remember\s*(?::|,|that)\s*[^\n]+)/giu,
  /(?:^|[\n.!?;])\s*((?:project rule|durable memory|user preference|user requirement)\s*:\s*[^\n]+)/giu,
  /(?:^|[\n.!?;])\s*((?:from now on|going forward|in the future)\s*[^\n]+)/giu
];

const EXAMPLE_PREFIX_RE = /(?:比如|例如|举例|示例|文案|正则|匹配|提到|引用|原话|say|example|regex|quote)\s*$/iu;
const MEMORY_QUESTION_RE = /(?:记住|remember)[^\n]{0,80}(?:什么|哪些|怎么|如何|是否|能不能|会不会|了吗|没有|吗|么|嘛|what|which|how|whether|do you|did you|can you|have you)[^\n]*[？?]\s*$/iu;

export function listPublicMemories(groupPath) {
  const filePath = publicMemoryPath(groupPath);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.map(normalizeMemoryRecord).filter((item) => item.content);
}

export function upsertPublicMemory(groupPath, record = {}) {
  const current = listPublicMemories(groupPath);
  const now = nowIso();
  const id = cleanId(record.id) || makeId("pmem");
  const nextRecord = normalizeMemoryRecord({
    ...record,
    id,
    updatedAt: now,
    createdAt: record.createdAt || current.find((item) => item.id === id)?.createdAt || now
  });
  if (!nextRecord.content) throw new Error("Public memory content is required");

  const withoutOld = current.filter((item) => item.id !== id);
  const items = [...withoutOld, nextRecord].slice(-MAX_MEMORY_ITEMS);
  writePublicMemoryFile(groupPath, items);
  return nextRecord;
}

export function deletePublicMemory(groupPath, id) {
  const clean = cleanId(id);
  if (!clean) throw new Error("Public memory id is required");
  const before = listPublicMemories(groupPath);
  const items = before.filter((item) => item.id !== clean);
  writePublicMemoryFile(groupPath, items);
  return { ok: true, deleted: before.length !== items.length, id: clean };
}

export function appendSummarizerPublicMemories(groupPath, candidates, options = {}) {
  const durable = filterDurableMemoryCandidates(Array.isArray(candidates) ? candidates : [])
    .map((item) => cleanText(item, MAX_MEMORY_TEXT))
    .filter(Boolean);
  const current = listPublicMemories(groupPath);
  const known = new Set(current.map((item) => normalizedContentKey(item.content)));
  const saved = [];
  let duplicates = 0;

  for (const content of durable) {
    const key = normalizedContentKey(content);
    if (!key || known.has(key)) {
      duplicates += 1;
      continue;
    }
    known.add(key);
    saved.push(normalizeMemoryRecord({
      title: memoryTitle(content),
      content,
      source: "summarizer",
      sourceSessionId: options.sourceSessionId,
      sourceAgentId: options.sourceAgentId,
      createdBy: options.sourceAgentName || options.sourceAgentId || "summarizer",
      provenance: "editable_summary_not_original_fact"
    }));
  }

  if (saved.length) {
    writePublicMemoryFile(groupPath, [...current, ...saved].slice(-MAX_MEMORY_ITEMS));
  }
  return {
    status: saved.length ? "saved" : "no_new_memory",
    candidateCount: Array.isArray(candidates) ? candidates.length : 0,
    durableCount: durable.length,
    savedCount: saved.length,
    duplicateCount: duplicates,
    savedIds: saved.map((item) => item.id)
  };
}

export function extractExplicitUserMemory(text) {
  const source = cleanText(text, MAX_MEMORY_TEXT);
  if (!source) return [];
  const found = [];

  for (const pattern of EXPLICIT_MEMORY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const content = cleanText(match[1], MAX_MEMORY_TEXT);
      if (!content || isExplicitMemoryFalsePositive(source, match.index || 0, content)) continue;
      found.push(content);
    }
  }

  const seen = new Set();
  return found.filter((content) => {
    const key = normalizedContentKey(content);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rememberExplicitUserMemory(groupPath, text, options = {}) {
  if (options.enabled === false) {
    return { status: "disabled", reason: "memory_capability_disabled", candidateCount: 0, savedCount: 0, duplicateCount: 0 };
  }
  if (!groupPath) {
    return { status: "not_applicable", reason: "group_workspace_unavailable", candidateCount: 0, savedCount: 0, duplicateCount: 0 };
  }

  const candidates = extractExplicitUserMemory(text);
  if (!candidates.length) {
    return { status: "no_explicit_memory", candidateCount: 0, savedCount: 0, duplicateCount: 0, upgradedCount: 0, savedIds: [] };
  }

  const current = listPublicMemories(groupPath);
  const indexByKey = new Map(current.map((item, index) => [normalizedContentKey(item.content), index]));
  const saved = [];
  let duplicates = 0;
  let upgraded = 0;

  for (const content of candidates) {
    const key = normalizedContentKey(content);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = current[existingIndex];
      if (existing.source === "user_explicit" && existing.provenance === "original_user_directive") {
        duplicates += 1;
        continue;
      }
      const replacement = normalizeMemoryRecord({
        ...existing,
        title: memoryTitle(content),
        content,
        source: "user_explicit",
        sourceSessionId: options.sourceSessionId,
        sourceAgentId: "",
        createdBy: "user",
        provenance: "original_user_directive",
        updatedAt: options.createdAt || nowIso()
      });
      current[existingIndex] = replacement;
      saved.push(replacement);
      upgraded += 1;
      continue;
    }

    const record = normalizeMemoryRecord({
      title: memoryTitle(content),
      content,
      source: "user_explicit",
      sourceSessionId: options.sourceSessionId,
      createdBy: "user",
      provenance: "original_user_directive",
      createdAt: options.createdAt
    });
    indexByKey.set(key, current.length);
    current.push(record);
    saved.push(record);
  }

  if (saved.length) writePublicMemoryFile(groupPath, current.slice(-MAX_MEMORY_ITEMS));
  return {
    status: saved.length ? "saved" : "no_new_memory",
    candidateCount: candidates.length,
    savedCount: saved.length,
    duplicateCount: duplicates,
    upgradedCount: upgraded,
    savedIds: saved.map((item) => item.id)
  };
}

export function formatPublicMemoriesForPrompt(groupPath) {
  const items = listPublicMemories(groupPath);
  if (!items.length) return "";
  return [
    "Public memory managed by the summarizer or user. Summarizer entries are an editable summary, not as the original facts. The system captures entries marked as original user directives; they are authoritative user instructions unless a newer user instruction supersedes them.",
    ...items.map((item, index) => {
      return [
        `Memory ${index + 1}: ${item.title || item.id}`,
        `Source: ${item.source || "unknown"}`,
        item.sourceAgentId ? `Source member: ${item.sourceAgentId}` : "",
        `Updated: ${item.updatedAt || item.createdAt || "unknown"}`,
        item.sourceSessionId ? `Source session: ${item.sourceSessionId}` : "",
        item.provenance === "editable_summary_not_original_fact" ? "Provenance: editable summary; not original fact" : "",
        item.provenance === "original_user_directive" ? "Provenance: original user directive" : "",
        item.content
      ].filter(Boolean).join("\n");
    })
  ].join("\n\n");
}

function normalizeMemoryRecord(record = {}) {
  return {
    id: cleanId(record.id) || makeId("pmem"),
    title: cleanText(record.title, 160),
    content: cleanText(record.content, MAX_MEMORY_TEXT),
    source: cleanText(record.source || "user", 80),
    sourceSessionId: cleanText(record.sourceSessionId || "", 120),
    sourceAgentId: cleanText(record.sourceAgentId || "", 120),
    createdBy: cleanText(record.createdBy || "user", 80),
    provenance: cleanText(record.provenance || "", 120),
    createdAt: cleanText(record.createdAt || nowIso(), 80),
    updatedAt: cleanText(record.updatedAt || record.createdAt || nowIso(), 80)
  };
}

function writePublicMemoryFile(groupPath, items) {
  const filePath = publicMemoryPath(groupPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, items }, null, 2), "utf8");
}

function publicMemoryPath(groupPath) {
  return path.join(path.resolve(groupPath), "shared", "memory", "public-memory.json");
}

function cleanText(value, max) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120);
}

function normalizedContentKey(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function isExplicitMemoryFalsePositive(source, matchIndex, content) {
  const prefix = source.slice(Math.max(0, matchIndex - 24), matchIndex).trim();
  if (EXAMPLE_PREFIX_RE.test(prefix)) return true;
  if (MEMORY_QUESTION_RE.test(content)) return true;
  return false;
}

function memoryTitle(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return cleanText(text.replace(/^(user prefers|user wants|user requires|remember\s*:|project rule\s*:|durable memory\s*:|preference\s*:|用户偏好\s*[：:]|用户希望|用户要求|记住\s*[：:]|项目规则\s*[：:]|长期记忆\s*[：:]|偏好\s*[：:])\s*/i, ""), 80)
    || "Summarizer memory";
}
