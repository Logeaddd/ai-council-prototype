import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";
import { filterDurableMemoryCandidates } from "./storage.js";

const MAX_MEMORY_ITEMS = 80;
const MAX_MEMORY_TEXT = 4000;

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

export function formatPublicMemoriesForPrompt(groupPath) {
  const items = listPublicMemories(groupPath);
  if (!items.length) return "";
  return [
    "Public memory managed by the summarizer or user. Treat it as an editable summary, not as the original facts.",
    ...items.map((item, index) => {
      return [
        `Memory ${index + 1}: ${item.title || item.id}`,
        `Source: ${item.source || "unknown"}`,
        item.sourceAgentId ? `Source member: ${item.sourceAgentId}` : "",
        `Updated: ${item.updatedAt || item.createdAt || "unknown"}`,
        item.sourceSessionId ? `Source session: ${item.sourceSessionId}` : "",
        item.provenance === "editable_summary_not_original_fact" ? "Provenance: editable summary; not original fact" : "",
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
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function memoryTitle(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return cleanText(text.replace(/^(user prefers|user wants|user requires|remember\s*:|project rule\s*:|durable memory\s*:|preference\s*:|用户偏好\s*[：:]|用户希望|用户要求|记住\s*[：:]|项目规则\s*[：:]|长期记忆\s*[：:]|偏好\s*[：:])\s*/i, ""), 80)
    || "Summarizer memory";
}
