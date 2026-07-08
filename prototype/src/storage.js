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

export function writeContextArchive(session, groupPath, options = {}) {
  const id = requireSafeSessionId(session?.id);
  const root = path.resolve(groupPath);
  const sessionsDir = path.join(root, "sessions");
  const archiveDir = path.join(sessionsDir, id);
  fs.mkdirSync(archiveDir, { recursive: true });

  const policy = buildContextPolicy(options.contextPolicy);
  const contextPolicyPath = writeJson(path.join(archiveDir, "context_policy.json"), policy);
  const fileArchive = writeArchivedAttachments(archiveDir, options.attachments || []);
  const rounds = writeRoundArchives(archiveDir, session);
  const indexRecord = buildSessionIndexRecord(session, {
    contextPolicyPath: relative(root, contextPolicyPath),
    archiveDir: relative(root, archiveDir),
    fullSessionPath: relative(root, path.join(sessionsDir, `${id}.json`)),
    fileManifestPath: relative(root, fileArchive.manifestPath),
    rounds
  });

  fs.mkdirSync(sessionsDir, { recursive: true });
  upsertJsonlRecord(path.join(sessionsDir, "session_index.jsonl"), indexRecord, "sessionId");

  return {
    archiveDir,
    contextPolicyPath,
    indexRecord,
    rounds,
    fileManifestPath: fileArchive.manifestPath,
    archivedFiles: fileArchive.files
  };
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

export function readSessionContextArchive(groupPath, sessionId) {
  const id = requireSafeSessionId(sessionId);
  const root = path.resolve(groupPath, "sessions");
  const archiveDir = path.resolve(root, id);
  if (archiveDir !== root && !archiveDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Session archive path escapes group workspace");
  }
  if (!fs.existsSync(archiveDir) || !fs.statSync(archiveDir).isDirectory()) {
    throw new Error(`Unknown session archive: ${id}`);
  }
  return {
    sessionId: id,
    contextPolicy: readJsonIfExists(path.join(archiveDir, "context_policy.json")),
    fileManifest: readJsonIfExists(path.join(archiveDir, "files", "file_manifest.json")),
    rounds: fs.readdirSync(archiveDir)
      .filter((name) => /^round_\d+_summary\.json$/.test(name))
      .sort(naturalCompare)
      .map((name) => readJsonIfExists(path.join(archiveDir, name)))
      .filter(Boolean)
  };
}

function writeRoundArchives(archiveDir, session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const roundNumbers = [...new Set(messages.map((message) => Number(message.round || 0)).filter((round) => round > 0))]
    .sort((a, b) => a - b);
  const rounds = [];
  for (const round of roundNumbers) {
    const roundMessages = messages.filter((message) => Number(message.round || 0) === round);
    const full = {
      schema: "ai-council.round-full.v1",
      sessionId: session.id || "",
      round,
      messages: roundMessages,
      toolExecutionResults: filterByRound(session.toolExecutionResults, round),
      fileOperationExecutionResults: filterByRound(session.fileOperationExecutionResults, round),
      fileOperationProposals: filterByRound(session.fileOperationProposals, round)
    };
    const summary = {
      schema: "ai-council.round-summary.v1",
      sessionId: session.id || "",
      round,
      source: "deterministic_summary",
      sourceFullPath: `round_${round}_full.json`,
      messageCount: roundMessages.length,
      speakers: roundMessages.map((message) => ({
        agentId: message.agentId || "",
        agentName: message.agentName || "",
        status: message.response?.status || "unknown",
        textPreview: truncate(message.response?.argument || message.response?.reason || message.displayText || "", 260)
      })),
      toolResultCount: full.toolExecutionResults.length,
      fileResultCount: full.fileOperationExecutionResults.length
    };
    const fullPath = writeJson(path.join(archiveDir, `round_${round}_full.json`), full);
    const summaryPath = writeJson(path.join(archiveDir, `round_${round}_summary.json`), summary);
    rounds.push({
      round,
      fullPath: path.basename(fullPath),
      summaryPath: path.basename(summaryPath),
      messageCount: roundMessages.length
    });
  }
  return rounds;
}

function writeArchivedAttachments(archiveDir, attachments) {
  const filesDir = path.join(archiveDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const files = (Array.isArray(attachments) ? attachments : []).map((attachment, index) => {
    const name = safeFileName(`attachment_${String(index + 1).padStart(3, "0")}_${attachment?.name || "file.txt"}`);
    const filePath = path.join(filesDir, name);
    const content = typeof attachment?.content === "string" ? attachment.content : "";
    fs.writeFileSync(filePath, content, "utf8");
    return {
      index,
      originalName: String(attachment?.name || ""),
      type: String(attachment?.type || ""),
      sizeBytes: Number(attachment?.sizeBytes || Buffer.byteLength(content, "utf8")),
      truncated: Boolean(attachment?.truncated),
      storedPath: `files/${name}`,
      summary: truncate(content, 240)
    };
  });
  const manifestPath = writeJson(path.join(filesDir, "file_manifest.json"), {
    schema: "ai-council.file-manifest.v1",
    source: "user_attachments_or_imported_project_files",
    files
  });
  return { manifestPath, files };
}

function buildSessionIndexRecord(session, pointers) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const createdAt = session.createdAt || session.startedAt || messages[0]?.createdAt || nowIso();
  const completedAt = session.completedAt || messages.at(-1)?.createdAt || createdAt;
  return {
    schema: "ai-council.session-index.v1",
    sessionId: session.id || "",
    question: session.question || "",
    createdAt,
    completedAt,
    status: session.status || "",
    finalState: session.finalDecision?.final_state || "",
    messageCount: messages.length,
    roundCount: pointers.rounds.length,
    contextPolicyPath: pointers.contextPolicyPath,
    fullSessionPath: pointers.fullSessionPath,
    archiveDir: pointers.archiveDir,
    fileManifestPath: pointers.fileManifestPath,
    rounds: pointers.rounds.map((round) => ({
      round: round.round,
      fullPath: `${pointers.archiveDir}/${round.fullPath}`,
      summaryPath: `${pointers.archiveDir}/${round.summaryPath}`,
      messageCount: round.messageCount
    }))
  };
}

function buildContextPolicy(value = {}) {
  return {
    schema: "ai-council.context-policy.v1",
    storage: "zero_loss_storage",
    defaultInjection: "limited_recent_context",
    loading: "on_demand_by_tool",
    hiddenChainOfThought: "not_stored_or_shared",
    privateChat: "target_member_only_unless_user_makes_public_memory",
    summaries: "summaries_are_not_source_facts",
    compression: "compressed_content_must_keep_source_pointer",
    createdAt: nowIso(),
    ...value
  };
}

function filterByRound(items = [], round) {
  return (Array.isArray(items) ? items : []).filter((item) => Number(item.round || 0) === round);
}

function upsertJsonlRecord(filePath, record, key) {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const next = [
    ...existing.filter((item) => item?.[key] !== record[key]),
    record
  ];
  fs.writeFileSync(filePath, next.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireSafeSessionId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  return id;
}

function safeFileName(value) {
  return String(value || "file.txt")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 180);
}

function relative(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
