import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";
import { isPublicSessionTombstoned, listTombstonedPublicSessionIds, syncPublicEventJournal } from "./publicEventJournal.js";
import { writeTextFileAtomically } from "./atomicFile.js";

export function writeSession(session, baseDir) {
  const dir = path.resolve(baseDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  writeTextFileAtomically(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function writeGroupSession(session, groupPath) {
  const dir = path.resolve(groupPath, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  writeTextFileAtomically(filePath, JSON.stringify(session, null, 2));
  syncPublicEventJournal(session, groupPath);
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
  const deleted = new Set(listTombstonedPublicSessionIds(groupPath));
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !deleted.has(name.slice(0, -5)))
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
  if (isPublicSessionTombstoned(groupPath, id)) throw new Error(`Deleted session id: ${id}`);
  const root = path.resolve(groupPath, "sessions");
  const filePath = path.resolve(root, `${id}.json`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Session path escapes group workspace");
  }
  if (!fs.existsSync(filePath)) throw new Error(`Unknown session id: ${id}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readRecentGroupSessions(groupPath, options = {}) {
  const excludedIds = new Set([
    String(options.excludeSessionId || "").trim(),
    ...(Array.isArray(options.excludeSessionIds) ? options.excludeSessionIds.map((item) => String(item || "").trim()) : [])
  ].filter(Boolean));
  const sessions = [];
  for (const summary of listGroupSessions(groupPath, { limit: options.limit || 200 })) {
    if (!summary.id || excludedIds.has(summary.id)) continue;
    try {
      sessions.push(readGroupSession(groupPath, summary.id));
    } catch {}
  }
  return sessions;
}

export function readSessionContextArchive(groupPath, sessionId) {
  const id = requireSafeSessionId(sessionId);
  if (isPublicSessionTombstoned(groupPath, id)) throw new Error(`Deleted session archive: ${id}`);
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
  if (isPublicSessionTombstoned(groupPath, id)) throw new Error(`Deleted session archive: ${id}`);
  const root = path.resolve(groupPath);
  const sessionsDir = path.join(root, "sessions");
  const archiveDir = path.resolve(sessionsDir, id);
  if (archiveDir !== sessionsDir && !archiveDir.startsWith(`${sessionsDir}${path.sep}`)) {
    throw new Error("Session archive path escapes group workspace");
  }
  const round = normalizeRoundNumber(request.round);
  const maxBytes = clampNumber(options.maxBytes || request.maxBytes || request.max_bytes || 128 * 1024, 4096, 512 * 1024);
  if (!fs.existsSync(archiveDir) || !fs.statSync(archiveDir).isDirectory()) {
    const storedSession = readStoredSessionFile(sessionsDir, id);
    if (!storedSession) throw new Error(`Unknown session archive: ${id}`);
    return limitArchivePayload(buildStoredSessionLoadPayload(storedSession, round), maxBytes);
  }

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
  const excludedIds = normalizeExcludedSessionIds(options);
  for (const id of listTombstonedPublicSessionIds(groupPath)) excludedIds.add(id);
  const records = readSessionIndexRecords(sessionsDir)
    .filter((record) => !excludedIds.has(String(record.sessionId || "")))
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0).getTime() - new Date(a.completedAt || a.createdAt || 0).getTime())
    .slice(0, maxSessions);

  const hits = [];
  for (const record of records) {
    hits.push(...buildSearchCandidates(root, record, terms));
  }
  const indexedIds = new Set(records.map((record) => String(record.sessionId || "")));
  for (const session of readStoredSessionFiles(sessionsDir, { limit: maxSessions })) {
    if (!session?.id || indexedIds.has(String(session.id)) || excludedIds.has(String(session.id))) continue;
    hits.push(...buildStoredSessionSearchCandidates(session, terms));
  }

  return hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export function listSessionHistoryCatalogue(groupPath, options = {}) {
  const sessionsDir = path.resolve(groupPath, "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  const limit = clampNumber(options.limit || 12, 1, 40);
  const excludedIds = normalizeExcludedSessionIds(options);
  for (const id of listTombstonedPublicSessionIds(groupPath)) excludedIds.add(id);
  const byId = new Map(readSessionIndexRecords(sessionsDir)
    .filter((record) => !excludedIds.has(String(record.sessionId || "")))
    .map((record) => [String(record.sessionId || ""), record]));
  for (const summary of listGroupSessions(groupPath, { limit: 200 })) {
    if (!summary.id || excludedIds.has(summary.id) || byId.has(summary.id)) continue;
    byId.set(summary.id, {
      sessionId: summary.id,
      question: summary.question,
      createdAt: summary.createdAt,
      completedAt: summary.completedAt,
      status: summary.status,
      finalState: summary.finalState,
      roundCount: summary.rounds,
      messageCount: summary.messageCount
    });
  }
  return [...byId.values()]
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0).getTime() - new Date(a.completedAt || a.createdAt || 0).getTime())
    .slice(0, limit)
    .map((record) => ({
      sessionId: String(record.sessionId || ""),
      question: truncate(record.question || "", 180),
      createdAt: String(record.createdAt || ""),
      completedAt: String(record.completedAt || ""),
      finalState: String(record.finalState || ""),
      roundCount: Number(record.roundCount || 0),
      messageCount: Number(record.messageCount || 0)
    }))
    .filter((record) => record.sessionId && record.question);
}

export function searchLiveSessionContext(session, query, options = {}) {
  const terms = tokenizeSearchQuery(query);
  if (!terms.length || !session?.id) return [];
  const record = liveSessionRecord(session);
  const visible = visibleLiveSession(session, options.agent, options.transcriptVisibility);
  const candidates = [];
  candidates.push(makeLiveSearchHit({
    record,
    sourceType: "live_session_question",
    sourcePath: `live:${record.sessionId}`,
    text: [record.question, session.finalDecision?.answer].filter(Boolean).join("\n"),
    terms
  }));
  for (const round of liveRoundNumbers(visible.messages)) {
    const text = liveRoundSearchText(visible, round);
    candidates.push(makeLiveSearchHit({
      record,
      round,
      sourceType: "live_round",
      sourcePath: `live:${record.sessionId}:round:${round}`,
      text,
      terms
    }));
  }
  const limit = clampNumber(options.limit || 6, 1, 20);
  return candidates
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit);
}

export function loadLiveSessionContext(session, request = {}, options = {}) {
  const requestedId = String(request.sessionId || request.session_id || "").trim();
  if (!session?.id || requestedId !== session.id) throw new Error("Unknown live session id");
  const round = normalizeRoundNumber(request.round);
  const visible = visibleLiveSession(session, options.agent, options.transcriptVisibility);
  const payload = round
    ? {
      source: "live_session_context",
      sourceType: "live_round_full",
      sessionId: session.id,
      round,
      sourcePath: `live:${session.id}:round:${round}`,
      content: {
        schema: "ai-council.live-round.v1",
        sessionId: session.id,
        round,
        messages: visible.messages.filter((message) => Number(message.round || 0) === round),
        toolExecutionResults: filterByRound(visible.toolExecutionResults, round),
        fileOperationExecutionResults: filterByRound(visible.fileOperationExecutionResults, round),
        fileOperationProposals: filterByRound(visible.fileOperationProposals, round)
      }
    }
    : {
      source: "live_session_context",
      sourceType: "live_session",
      sessionId: session.id,
      sourcePath: `live:${session.id}`,
      content: {
        schema: "ai-council.live-session.v1",
        sessionId: session.id,
        question: session.question || "",
        status: session.status || "running",
        messages: visible.messages,
        toolExecutionResults: visible.toolExecutionResults,
        fileOperationExecutionResults: visible.fileOperationExecutionResults,
        fileOperationProposals: visible.fileOperationProposals
      }
    };
  return limitArchivePayload(payload, clampNumber(options.maxBytes || request.maxBytes || request.max_bytes || 128 * 1024, 4096, 512 * 1024));
}

function writeRoundArchives(archiveDir, session) {
  const messages = sessionTranscriptMessages(session);
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
  const messages = sessionTranscriptMessages(session);
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

function readStoredSessionFiles(sessionsDir, options = {}) {
  if (!fs.existsSync(sessionsDir)) return [];
  const limit = clampNumber(options.limit || 200, 1, 500);
  return fs.readdirSync(sessionsDir)
    .filter((name) => /^session_[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => readStoredSessionFile(sessionsDir, path.basename(name, ".json")))
    .filter(Boolean)
    .sort((a, b) => new Date(b.completedAt || b.createdAt || b.startedAt || 0).getTime() - new Date(a.completedAt || a.createdAt || a.startedAt || 0).getTime())
    .slice(0, limit);
}

function normalizeExcludedSessionIds(options = {}) {
  return new Set([
    String(options.excludeSessionId || "").trim(),
    ...(Array.isArray(options.excludeSessionIds) ? options.excludeSessionIds.map((item) => String(item || "").trim()) : [])
  ].filter(Boolean));
}

function readStoredSessionFile(sessionsDir, sessionId) {
  const id = String(sessionId || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const filePath = path.join(sessionsDir, `${id}.json`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function buildStoredSessionLoadPayload(session, round) {
  const visible = visibleLiveSession(session, {}, "full");
  const content = round
    ? {
      schema: "ai-council.stored-round.v1",
      sessionId: session.id || "",
      question: session.question || "",
      round,
      messages: visible.messages.filter((message) => Number(message.round || 0) === round),
      toolExecutionResults: filterByRound(visible.toolExecutionResults, round),
      fileOperationExecutionResults: filterByRound(visible.fileOperationExecutionResults, round),
      fileOperationProposals: filterByRound(visible.fileOperationProposals, round)
    }
    : {
      schema: "ai-council.stored-session.v1",
      sessionId: session.id || "",
      question: session.question || "",
      status: session.status || "",
      createdAt: session.createdAt || session.startedAt || "",
      completedAt: session.completedAt || "",
      messages: visible.messages,
      toolExecutionResults: visible.toolExecutionResults,
      fileOperationExecutionResults: visible.fileOperationExecutionResults,
      fileOperationProposals: visible.fileOperationProposals,
      artifacts: Array.isArray(session.artifacts) ? session.artifacts : [],
      unresolvedObjections: session.unresolvedObjections || {},
      consensusByRound: Array.isArray(session.consensusByRound) ? session.consensusByRound : [],
      finalDecision: session.finalDecision || null
    };
  return {
    source: "stored_session_context",
    sourceType: round ? "stored_round_full" : "stored_session_full",
    sessionId: session.id || "",
    round: round || undefined,
    sourcePath: `sessions/${session.id || ""}.json${round ? `#round-${round}` : ""}`,
    content
  };
}

function buildStoredSessionSearchCandidates(session, terms) {
  const record = liveSessionRecord(session);
  const visible = visibleLiveSession(session, {}, "full");
  const sourcePath = `sessions/${record.sessionId}.json`;
  const candidates = [makeSearchHit({
    record,
    sourceType: "stored_session",
    sourcePath,
    text: [
      record.question,
      session.finalDecision?.answer,
      ...(Array.isArray(session.finalDecision?.risks) ? session.finalDecision.risks : []),
      ...(Array.isArray(session.finalDecision?.next_actions) ? session.finalDecision.next_actions : [])
    ].filter(Boolean).join("\n"),
    terms
  })];
  for (const round of liveRoundNumbers(visible.messages)) {
    candidates.push(makeSearchHit({
      record,
      round,
      sourceType: "stored_round",
      sourcePath: `${sourcePath}#round-${round}`,
      text: liveRoundSearchText(visible, round),
      terms
    }));
  }
  return candidates.filter(Boolean);
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
    const full = readRelativeJson(root, roundRef.fullPath);
    candidates.push(makeSearchHit({
      record,
      round: Number(full?.round || roundRef.round || 0),
      sourceType: "round_full",
      sourcePath: roundRef.fullPath,
      text: archivedRoundSearchText(full),
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

function archivedRoundSearchText(round = {}) {
  return [
    ...(Array.isArray(round.messages) ? round.messages.map(formatPublicMessageForSearch) : []),
    ...compactSearchRecords(round.toolExecutionResults, "tool"),
    ...compactSearchRecords(round.fileOperationExecutionResults, "file operation"),
    ...compactSearchRecords(round.fileOperationProposals, "file proposal")
  ].filter(Boolean).join("\n");
}

function liveSessionRecord(session) {
  return {
    sessionId: String(session.id || ""),
    question: String(session.question || ""),
    createdAt: String(session.createdAt || session.startedAt || ""),
    completedAt: String(session.completedAt || ""),
    finalState: String(session.finalDecision?.final_state || "")
  };
}

function visibleLiveSession(session, agent = {}, visibility = "full") {
  const ownOnly = visibility === "own";
  const owns = (item = {}) => String(item.agentId || item.source_agent_id || item.sourceAgentId || item.proposedBy?.seatId || item.proposedBy?.id || "") === String(agent.id || "");
  return {
    messages: sessionTranscriptMessages(session).filter((item) => !ownOnly || owns(item)),
    toolExecutionResults: (Array.isArray(session.toolExecutionResults) ? session.toolExecutionResults : []).filter((item) => !ownOnly || owns(item)),
    fileOperationExecutionResults: (Array.isArray(session.fileOperationExecutionResults) ? session.fileOperationExecutionResults : []).filter((item) => !ownOnly || owns(item)),
    fileOperationProposals: (Array.isArray(session.fileOperationProposals) ? session.fileOperationProposals : []).filter((item) => !ownOnly || owns(item))
  };
}

function liveRoundNumbers(messages = []) {
  return [...new Set(messages.map((message) => Number(message.round || 0)).filter((round) => round > 0))].sort((a, b) => a - b);
}

function liveRoundSearchText(visible, round) {
  return [
    ...(visible.messages || []).filter((message) => Number(message.round || 0) === round).map(formatPublicMessageForSearch),
    ...compactSearchRecords(filterByRound(visible.toolExecutionResults, round), "tool"),
    ...compactSearchRecords(filterByRound(visible.fileOperationExecutionResults, round), "file operation"),
    ...compactSearchRecords(filterByRound(visible.fileOperationProposals, round), "file proposal")
  ].filter(Boolean).join("\n");
}

function formatPublicMessageForSearch(message = {}) {
  return [message.agentName, message.response?.status, message.response?.argument, message.response?.reason, message.displayText].filter(Boolean).join(": ");
}

function compactSearchRecords(records, label) {
  return (Array.isArray(records) ? records : []).map((record) => `${label}: ${redactArchiveSearchText(JSON.stringify(record))}`);
}

function makeLiveSearchHit({ record, round, sourceType, sourcePath, text, terms }) {
  const cleanText = redactArchiveSearchText(text);
  const score = scoreSearchText(cleanText, terms);
  if (!score) return null;
  return {
    source: "live_session_context",
    sourceType,
    sessionId: record.sessionId,
    question: truncate(record.question, 220),
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    finalState: record.finalState,
    round: round || undefined,
    score,
    matchedTerms: terms.filter((term) => cleanText.toLowerCase().includes(term)),
    snippet: truncate(cleanText, 700),
    sourcePath
  };
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
  const messages = sessionTranscriptMessages(session);
  const createdAt = session.createdAt || session.startedAt || messages[0]?.createdAt || fallbackTime;
  const completedAt = session.completedAt || messages.at(-1)?.createdAt || createdAt;
  const rounds = Math.max(0, ...messages.map((message) => Number(message.round || 0)));
  return {
    id: session.id || "",
    question: session.question || "",
    status: session.status || "",
    createdAt,
    completedAt,
    durationMs: Number(session.durationMs || durationBetween(createdAt, completedAt) || 0),
    messageCount: messages.length,
    rounds,
    finalState: session.finalDecision?.final_state || "",
    answerPreview: String(session.finalDecision?.answer || "").slice(0, 240)
  };
}

function sessionTranscriptMessages(session = {}) {
  return [
    ...(Array.isArray(session.interimMessages) ? session.interimMessages : []),
    ...(Array.isArray(session.messages) ? session.messages : [])
  ].sort((a, b) => {
    const time = new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime();
    if (time) return time;
    return Number(a?.modelCallIndex || 0) - Number(b?.modelCallIndex || 0);
  });
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
  return /^(user prefers|user wants|user requires|remember\s*:|project rule\s*:|durable memory\s*:|preference\s*:|用户偏好\s*[：:]|用户希望|用户要求|记住\s*[：:]|项目规则\s*[：:]|长期记忆\s*[：:]|偏好\s*[：:])/i.test(text);
}

function hasEphemeralMeetingLanguage(text) {
  return /\b(decision|risk|next action|minority report|critic|judge|builder|smoke test|this session|this discussion)\b|本次会话|本次讨论|本轮|下一步|少数意见|审查者|总结者|构建者|冒烟测试/i.test(text);
}

export function readMemoryPending(baseDir) {
  const filePath = path.resolve(baseDir, "memory", "pending.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
