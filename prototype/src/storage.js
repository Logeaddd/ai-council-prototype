import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";

export function writeSession(session, baseDir) {
  const dir = path.resolve(baseDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
  return filePath;
}

export function writeGroupSession(session, groupPath) {
  const dir = path.resolve(groupPath, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
  return filePath;
}

export function appendMemoryCandidates(finalDecision, session, baseDir) {
  const candidates = filterDurableMemoryCandidates(finalDecision.memory_candidates ?? []);
  if (!candidates.length) return [];

  const dir = path.resolve(baseDir, "memory");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "pending.jsonl");
  const records = candidates.map((content) => ({
    id: makeId("mem"),
    content,
    source_session_id: session.id,
    source: "final_judge_call",
    proposed_by: "judge",
    status: "pending_user_confirmation",
    created_at: nowIso()
  }));
  fs.appendFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return records;
}

export function filterDurableMemoryCandidates(candidates) {
  return candidates.filter((candidate) => {
    const text = String(candidate ?? "").trim();
    if (!text) return false;
    return hasDurablePrefix(text) && !hasEphemeralMeetingLanguage(text);
  });
}

function hasDurablePrefix(text) {
  return /^(user prefers|user wants|user requires|remember:|project rule:|durable memory:|preference:)/i.test(text);
}

function hasEphemeralMeetingLanguage(text) {
  return /\b(decision|risk|next action|minority report|critic|judge|builder|smoke test|this session|this discussion)\b/i.test(text);
}

export function readMemoryPending(baseDir) {
  const filePath = path.resolve(baseDir, "memory", "pending.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
