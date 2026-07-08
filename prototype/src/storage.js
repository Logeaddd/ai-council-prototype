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

export function listGroupSessions(groupPath, options = {}) {
  const dir = path.resolve(groupPath, "sessions");
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return summarizeSession(session, stat.mtime.toISOString());
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export function readGroupSession(groupPath, sessionId) {
  const id = String(sessionId || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  const root = path.resolve(groupPath, "sessions");
  const filePath = path.resolve(root, `${id}.json`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Session path escapes group workspace");
  }
  if (!fs.existsSync(filePath)) throw new Error(`Unknown session id: ${id}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function summarizeSession(session, fallbackTime) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const createdAt = session.createdAt || session.startedAt || messages[0]?.createdAt || fallbackTime;
  const completedAt = session.completedAt || messages.at(-1)?.createdAt || createdAt;
  const rounds = Math.max(0, ...messages.map((message) => Number(message.round || 0)));
  return {
    id: session.id || "",
    question: session.question || "",
    createdAt,
    completedAt,
    durationMs: Number(session.durationMs || durationBetween(createdAt, completedAt) || 0),
    messageCount: messages.length,
    rounds,
    finalState: session.finalDecision?.final_state || "",
    answerPreview: String(session.finalDecision?.answer || "").slice(0, 240)
  };
}

function durationBetween(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return b - a;
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
