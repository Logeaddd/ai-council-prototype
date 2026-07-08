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

export function loadSessionContextArchiveItem(groupPath, request = {}, options = {}) {
  const id = requireSafeSessionId(request.sessionId || request.session_id);
  const root = path.resolve(groupPath);
  const sessionsDir = path.join(root, "sessions");
  const archiveDir = path.resolve(sessionsDir, id);
  if (archiveDir !== sessionsDir && !archiveDir.startsWith(`${sessionsDir}${path.sep}`)) {
    throw new Error("Session archive path escapes group workspace");
  }
  if (!fs.existsSync(archiveDir) || !fs.statSync(archiveDir).isDirectory()) {
    throw new Error(`Unknown session archive: ${id}`);
  }

  const round = normalizeRoundNumber(request.round);
  const maxBytes = clampNumber(options.maxBytes || request.maxBytes || request.max_bytes || 128 * 1024, 4096, 512 * 1024);
  const indexRecord = readSessionIndexRecords(sessionsDir).find((item) => item.sessionId === id);
  const payload = round
    ? {
      source: "local_context_archive",
      sourceType: "round_full",
      sessionId: id,
      round,
      sourcePath: `sessions/${id}/round_${round}_full.json`,
      content: readRequiredJson(path.join(archiveDir, `round_${round}_full.json`))
    }
    : {
      source: "local_context_archive",
      sourceType: "session_archive",
      sessionId: id,
      sourcePath: `sessions/${id}`,
      indexRecord,
      content: readSessionContextArchive(groupPath, id)
    };
  return limitArchivePayload(payload, maxBytes);
}

export function searchSessionContextArchive(groupPath, query, options = {}) {
  const terms = tokenizeSearchQuery(query);
  if (!terms.length) return [];
  const root = path.resolve(groupPath);
  const sessionsDir = path.join(root, "sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const limit = clampNumber(options.limit || 6, 1, 20);
  const maxSessions = clampNumber(options.maxSessions || 80, 1, 300);
  const records = readSessionIndexRecords(sessionsDir)
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0).getTime() - new Date(a.completedAt || a.createdAt || 0).getTime())
    .slice(0, maxSessions);

  const hits = [];
  for (const record of records) {
    hits.push(...buildSearchCandidates(root, record, terms));
  }

  return hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
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

function readRequiredJson(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Unknown archive item: ${path.basename(filePath)}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readSessionIndexRecords(sessionsDir) {
  const filePath = path.join(sessionsDir, "session_index.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildSearchCandidates(root, record, terms) {
  const candidates = [];
  const session = readRelativeJson(root, record.fullSessionPath);
  const finalText = [
    record.question,
    session?.finalDecision?.answer,
    ...(Array.isArray(session?.finalDecision?.risks) ? session.finalDecision.risks : []),
    ...(Array.isArray(session?.finalDecision?.next_actions) ? session.finalDecision.next_actions : [])
  ].join("\n");
  candidates.push(makeSearchHit({
    record,
    sourceType: "session_final",
    sourcePath: record.fullSessionPath,
    text: finalText,
    terms
  }));

  const rounds = Array.isArray(record.rounds) ? record.rounds : [];
  for (const roundRef of rounds) {
    const summary = readRelativeJson(root, roundRef.summaryPath);
    const summaryText = [
      `Round ${summary?.round || roundRef.round || ""}`,
      ...(Array.isArray(summary?.speakers) ? summary.speakers.map((speaker) => [
        speaker.agentName,
        speaker.status,
        speaker.textPreview
      ].filter(Boolean).join(": ")) : [])
    ].join("\n");
    candidates.push(makeSearchHit({
      record,
      round: Number(summary?.round || roundRef.round || 0),
      sourceType: "round_summary",
      sourcePath: roundRef.summaryPath,
      text: summaryText,
      terms
    }));
  }

  const manifest = readRelativeJson(root, record.fileManifestPath);
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    candidates.push(makeSearchHit({
      record,
      sourceType: "attachment_summary",
      sourcePath: `${record.archiveDir || ""}/${file.storedPath || ""}`.replaceAll("\\", "/"),
      text: [file.originalName, file.type, file.summary].filter(Boolean).join("\n"),
      terms
    }));
  }

  return candidates.filter(Boolean);
}

function makeSearchHit({ record, round, sourceType, sourcePath, text, terms }) {
  const cleanText = redactArchiveSearchText(text);
  const score = scoreSearchText(cleanText, terms);
  if (!score) return null;
  return {
    source: "local_context_archive",
    sourceType,
    sessionId: record.sessionId || "",
    question: truncate(record.question || "", 220),
    createdAt: record.createdAt || "",
    completedAt: record.completedAt || "",
    finalState: record.finalState || "",
    round: round || undefined,
    score,
    matchedTerms: terms.filter((term) => cleanText.toLowerCase().includes(term)),
    snippet: truncate(cleanText, 700),
    sourcePath: String(sourcePath || "")
  };
}

function readRelativeJson(root, relativePath) {
  if (!relativePath) return undefined;
  const filePath = path.resolve(root, String(relativePath));
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return undefined;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function tokenizeSearchQuery(query) {
  const text = String(query || "").toLowerCase().trim();
  if (!text) return [];
  const terms = (text.match(/[\p{L}\p{N}_-]+/gu) || [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 16);
  return [...new Set(terms)];
}

function scoreSearchText(text, terms) {
  const lower = String(text || "").toLowerCase();
  if (!lower || !terms.length) return 0;
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const count = lower.split(term).length - 1;
    if (count > 0) {
      matched += 1;
      score += count * Math.min(6, Math.max(1, term.length));
    }
  }
  if (matched > 1) score += matched * 2;
  return score;
}

function redactArchiveSearchText(value) {
  return String(value || "")
    .replace(/private-chat\.jsonl/gi, "[private-path-redacted]")
    .replace(/private_memory/gi, "[private-path-redacted]")
    .replace(/members[\\/][^\\/]+[\\/]inbox/gi, "[private-path-redacted]")
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1:[redacted]");
}

function limitArchivePayload(payload, maxBytes) {
  const redactedText = redactArchiveSearchText(JSON.stringify(payload));
  const bytes = Buffer.byteLength(redactedText, "utf8");
  if (bytes <= maxBytes) {
    return {
      ok: true,
      bytes,
      maxBytes,
      truncated: false,
      ...JSON.parse(redactedText)
    };
  }
  return {
    ok: true,
    source: payload.source,
    sourceType: payload.sourceType,
    sessionId: payload.sessionId,
    round: payload.round,
    sourcePath: payload.sourcePath,
    bytes,
    maxBytes,
    truncated: true,
    text: truncate(redactedText, maxBytes)
  };
}

function normalizeRoundNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  const round = Number(value);
  if (!Number.isInteger(round) || round < 1 || round > 1000) throw new Error("Invalid archive round");
  return round;
}

function clampNumber(value, min, max) {
  const count = Number(value);
  if (!Number.isFinite(count)) return min;
  return Math.min(max, Math.max(min, Math.floor(count)));
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
