import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const JOURNAL_SCHEMA = "ai-council.public-event.v1";
const INDEX_SCHEMA = "ai-council.public-event-index.v1";
const HOT_CACHE_SCHEMA = "ai-council.public-event-hot-cache.v1";
const COMPRESSION_SCHEMA = "ai-council.public-event-compression.v1";
const MAX_INDEX_TEXT = 2400;
const DEFAULT_HOT_EVENTS = 40;
const MAX_HOT_EVENTS = 120;

export function syncPublicEventJournal(session, groupPath) {
  if (!session?.id || !groupPath) return { appended: 0, total: 0 };
  const paths = journalPaths(groupPath);
  fs.mkdirSync(paths.dir, { recursive: true });
  const index = readOrRebuildIndex(groupPath);
  const known = new Set(index.events.map((item) => item.id));
  const candidates = buildSessionEvents(session).filter((event) => !known.has(event.id));
  if (!candidates.length) return { appended: 0, total: index.events.length, journalPath: paths.relativeJournal };

  let offset = fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0;
  const lines = [];
  for (const candidate of candidates) {
    const event = { ...candidate, sequence: index.lastSequence + 1 };
    index.lastSequence = event.sequence;
    const line = `${JSON.stringify(event)}\n`;
    const length = Buffer.byteLength(line, "utf8");
    lines.push(line);
    index.events.push(indexEntry(event, offset, length));
    offset += length;
  }
  fs.appendFileSync(paths.journal, lines.join(""), "utf8");
  writeIndex(paths.index, index);
  writeHotCache(paths, index);
  return { appended: candidates.length, total: index.events.length, journalPath: paths.relativeJournal };
}

export function tombstonePublicEvents(groupPath, selector = {}, options = {}) {
  const sessionId = String(selector.sessionId || selector.session_id || "").trim();
  if (!sessionId) throw journalError("missing_session_id", "Deleting retained public history requires a sessionId.");
  const paths = journalPaths(groupPath);
  fs.mkdirSync(paths.dir, { recursive: true });
  const index = readOrRebuildIndex(groupPath);
  if (index.deletedSessionIds.includes(sessionId)) return { status: "already_deleted", sessionId, tombstonedEvents: 0 };
  const targets = index.events.filter((item) => item.sessionId === sessionId && item.type !== "deletion_tombstone" && !item.tombstoned);
  if (!targets.length) throw journalError("unknown_session", `No retained public events were found for session ${sessionId}.`);

  const occurredAt = new Date().toISOString();
  const targetEventIds = targets.map((item) => item.id);
  const digest = crypto.createHash("sha256").update(`${sessionId}\n${targetEventIds.join("\n")}\n${occurredAt}`).digest("hex").slice(0, 16);
  const event = {
    schema: JOURNAL_SCHEMA,
    id: `tombstone:${safePart(sessionId)}:${digest}`,
    sequence: index.lastSequence + 1,
    type: "deletion_tombstone",
    occurredAt,
    sessionId: "",
    taskId: "",
    taskText: "",
    actor: { kind: "user", id: String(options.requestedBy || "user"), name: "User" },
    round: 0,
    status: "applied",
    tool: "",
    filePaths: [],
    commitHashes: [],
    text: `Deleted retained public session ${sessionId}.`,
    source: { kind: "user_deletion", path: paths.relativeJournal, pointer: "" },
    payload: {
      scope: "session",
      targetSessionId: sessionId,
      targetEventIds,
      reason: truncate(options.reason || "user_requested_deletion", 500)
    }
  };
  const offset = fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0;
  const line = `${JSON.stringify(event)}\n`;
  fs.appendFileSync(paths.journal, line, "utf8");
  index.lastSequence = event.sequence;
  index.events.push(indexEntry(event, offset, Buffer.byteLength(line, "utf8")));
  index.tombstonedIds = unique([...index.tombstonedIds, ...targetEventIds]);
  index.deletedSessionIds = unique([...index.deletedSessionIds, sessionId]);
  applyTombstones(index);
  writeIndex(paths.index, index);
  writeHotCache(paths, index);
  return { status: "deleted", sessionId, tombstoneEventId: event.id, tombstonedEvents: targetEventIds.length };
}

export function listTombstonedPublicSessionIds(groupPath) {
  return [...readOrRebuildIndex(groupPath).deletedSessionIds];
}

export function isPublicSessionTombstoned(groupPath, sessionId) {
  return readOrRebuildIndex(groupPath).deletedSessionIds.includes(String(sessionId || ""));
}

export function readPublicEventHotCache(groupPath, options = {}) {
  const paths = journalPaths(groupPath);
  const limit = clamp(options.limit || DEFAULT_HOT_EVENTS, 1, MAX_HOT_EVENTS);
  const journalBytes = fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0;
  try {
    const cache = JSON.parse(fs.readFileSync(paths.hotCache, "utf8"));
    if (cache?.schema !== HOT_CACHE_SCHEMA || !Array.isArray(cache.events) || Number(cache.sourceJournalBytes || 0) !== journalBytes) {
      throw new Error("stale hot cache");
    }
    const filtered = filteredHotCache(cache, options);
    return { ...filtered, events: filtered.events.slice(-limit) };
  } catch {
    const index = readOrRebuildIndex(groupPath);
    const cache = writeHotCache(paths, index);
    const filtered = filteredHotCache(cache, options);
    return { ...filtered, events: filtered.events.slice(-limit) };
  }
}

export function readPublicEventCompression(groupPath) {
  const paths = journalPaths(groupPath);
  const journalBytes = fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0;
  try {
    const compression = JSON.parse(fs.readFileSync(paths.compression, "utf8"));
    if (compression?.schema !== COMPRESSION_SCHEMA || !Array.isArray(compression.windows) || Number(compression.sourceJournalBytes || 0) !== journalBytes) {
      throw new Error("stale compression");
    }
    return compression;
  } catch {
    return writeCompression(paths, readOrRebuildIndex(groupPath));
  }
}

export function queryPublicEvents(groupPath, filters = {}) {
  return queryPublicEventPage(groupPath, filters).events;
}

export function queryPublicEventPage(groupPath, filters = {}) {
  const index = readOrRebuildIndex(groupPath);
  const terms = tokenize(filters.query || filters.text);
  const types = stringSet(filters.type || filters.eventType || filters.eventTypes);
  const actors = stringSet(filters.actor || filters.actorId || filters.actorName);
  const tools = stringSet(filters.tool || filters.tools);
  const statuses = stringSet(filters.status || filters.statuses);
  const task = normalize(filters.task || filters.taskId);
  const file = normalize(filters.file || filters.path);
  const commit = normalize(filters.commit || filters.commitHash);
  const sessionId = normalize(filters.sessionId);
  const excludedSessionIds = stringSet(filters.excludeSessionId || filters.excludeSessionIds);
  const fromMs = timestamp(filters.from || filters.fromTime || filters.after);
  const toMs = timestamp(filters.to || filters.toTime || filters.before);
  const includeDeleted = Boolean(filters.includeDeleted);
  const limit = clamp(filters.limit || filters.count || 20, 1, 200);
  const offset = clamp(filters.offset ?? filters.pageOffset ?? 0, 0, 1000000);

  const matched = index.events
    .map((item) => ({ item, score: matchScore(item, { terms, types, actors, tools, statuses, task, file, commit, sessionId, excludedSessionIds, fromMs, toMs, includeDeleted }) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || b.item.sequence - a.item.sequence);
  const events = matched
    .slice(offset, offset + limit)
    .map(({ item, score }) => ({
      ...item,
      score,
      source: "local_public_event_journal",
      sourcePath: `${index.journalPath}#event=${item.id}`
    }));
  return {
    events,
    pagination: {
      offset,
      limit,
      total: matched.length,
      hasMore: offset + events.length < matched.length,
      nextOffset: offset + events.length < matched.length ? offset + events.length : null
    }
  };
}

export function loadPublicEvent(groupPath, eventId, options = {}) {
  const id = String(eventId || "").trim();
  if (!id) throw new Error("Missing public event id");
  const paths = journalPaths(groupPath);
  const index = readOrRebuildIndex(groupPath);
  const entry = index.events.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown public event id: ${id}`);
  if (entry.tombstoned && !options.includeDeleted) throw journalError("event_deleted", `Public event ${id} was deleted by a retained tombstone.`);
  const handle = fs.openSync(paths.journal, "r");
  try {
    const buffer = Buffer.alloc(entry.length);
    fs.readSync(handle, buffer, 0, entry.length, entry.offset);
    const event = JSON.parse(buffer.toString("utf8").trim());
    return {
      source: "local_public_event_journal",
      sourceType: event.type,
      eventId: event.id,
      sessionId: event.sessionId,
      sourcePath: `${paths.relativeJournal}#event=${event.id}`,
      content: event
    };
  } finally {
    fs.closeSync(handle);
  }
}

export function rebuildPublicEventIndex(groupPath) {
  const paths = journalPaths(groupPath);
  fs.mkdirSync(paths.dir, { recursive: true });
  const index = emptyIndex(paths.relativeJournal);
  if (!fs.existsSync(paths.journal)) {
    writeIndex(paths.index, index);
    return normalizeIndex(index);
  }
  const buffer = fs.readFileSync(paths.journal);
  let start = 0;
  for (let cursor = 0; cursor <= buffer.length; cursor += 1) {
    if (cursor < buffer.length && buffer[cursor] !== 10) continue;
    const end = cursor < buffer.length ? cursor + 1 : cursor;
    if (end <= start) continue;
    const line = buffer.subarray(start, end).toString("utf8").trim();
    if (line) {
      try {
        const event = JSON.parse(line);
        if (event?.id && event?.schema === JOURNAL_SCHEMA) {
          index.events.push(indexEntry(event, start, end - start));
          index.lastSequence = Math.max(index.lastSequence, Number(event.sequence || 0));
          if (event.type === "deletion_tombstone") {
            index.tombstonedIds.push(...array(event.payload?.targetEventIds));
            if (event.payload?.targetSessionId) index.deletedSessionIds.push(String(event.payload.targetSessionId));
          }
        }
      } catch {
        index.invalidLines += 1;
      }
    }
    start = end;
  }
  index.tombstonedIds = unique(index.tombstonedIds);
  index.deletedSessionIds = unique(index.deletedSessionIds);
  applyTombstones(index);
  writeIndex(paths.index, index);
  writeHotCache(paths, index);
  writeCompression(paths, index);
  return index;
}

function buildSessionEvents(session) {
  const sessionId = String(session.id);
  const taskId = String(session.executionState?.taskId || sessionId);
  const taskText = String(session.executionState?.taskQuestion || session.question || "");
  const sourcePath = `sessions/${sessionId}.json`;
  const base = { schema: JOURNAL_SCHEMA, sessionId, taskId, taskText, sourcePath };
  const events = [makeEvent(base, {
    id: `${sessionId}:user:0`,
    type: "user_message",
    occurredAt: session.createdAt || session.startedAt,
    actor: { kind: "user", id: "user", name: "User" },
    status: "sent",
    text: session.question || "",
    payload: { text: session.question || "" },
    pointer: "/question"
  })];

  const transcriptMessages = [
    ...array(session.interimMessages).map((message, index) => ({ message, field: "interimMessages", index })),
    ...array(session.messages).map((message, index) => ({ message, field: "messages", index }))
  ].sort((a, b) => new Date(a.message?.createdAt || 0).getTime() - new Date(b.message?.createdAt || 0).getTime());
  for (const item of transcriptMessages) {
    const { message, field, index } = item;
    events.push(makeEvent(base, {
      id: field === "interimMessages" ? `${sessionId}:interim:${index}` : `${sessionId}:message:${index}`,
      type: message.interim ? "member_interim" : "member_message",
      occurredAt: message.createdAt || message.startedAt,
      actor: actor(message),
      round: message.round,
      status: message.response?.status || "unknown",
      text: message.response?.argument || message.response?.reason || message.displayText || "",
      payload: publicMessage(message),
      pointer: `/${field}/${index}`
    }));
  }
  addCollectionEvents(events, base, session.toolExecutionResults, "tool_result", "toolExecutionResults");
  addCollectionEvents(events, base, session.fileOperationProposals, "file_operation_proposal", "fileOperationProposals");
  addCollectionEvents(events, base, session.fileOperationExecutionResults, "file_operation_result", "fileOperationExecutionResults");
  addCollectionEvents(events, base, session.rejectedToolRequests, "tool_rejected", "rejectedToolRequests");

  if (session.finalDecision && session.status !== "running") {
    events.push(makeEvent(base, {
      id: `${sessionId}:final`,
      type: "final_decision",
      occurredAt: session.completedAt,
      actor: { kind: "system", id: "finalizer", name: "Finalizer" },
      status: session.finalDecision.final_state || session.status || "completed",
      text: session.finalDecision.answer || "",
      payload: session.finalDecision,
      pointer: "/finalDecision"
    }));
  }
  const status = String(session.status || "running");
  events.push(makeEvent(base, {
    id: `${sessionId}:status:${safePart(status)}`,
    type: "session_status",
    occurredAt: status === "running" ? session.createdAt || session.startedAt : session.completedAt,
    actor: { kind: "system", id: "engine", name: "AI Council" },
    status,
    text: [status, session.guardStopReason, session.interruptionReason].filter(Boolean).join(" "),
    payload: {
      status,
      guardStopReason: session.guardStopReason || "",
      interruptionReason: session.interruptionReason || ""
    },
    pointer: "/status"
  }));
  return events;
}

function addCollectionEvents(events, base, items, type, field) {
  for (const [index, item] of array(items).entries()) {
    events.push(makeEvent(base, {
      id: `${base.sessionId}:${type}:${index}:${safePart(item?.id || index)}`,
      type,
      occurredAt: item?.createdAt,
      actor: actor(item),
      round: item?.round,
      status: item?.status || "unknown",
      tool: item?.tool || "",
      text: eventText(item),
      payload: item,
      pointer: `/${field}/${index}`
    }));
  }
}

function makeEvent(base, value) {
  const payload = value.payload ?? null;
  return {
    ...base,
    id: value.id,
    type: value.type,
    occurredAt: String(value.occurredAt || new Date().toISOString()),
    actor: value.actor || { kind: "system", id: "", name: "" },
    round: Math.max(0, Number(value.round || 0)),
    status: String(value.status || ""),
    tool: String(value.tool || ""),
    filePaths: extractPaths(payload),
    commitHashes: extractCommits(payload),
    text: String(value.text || ""),
    source: { kind: "group_session", path: base.sourcePath, pointer: value.pointer || "" },
    payload
  };
}

function publicMessage(message = {}) {
  return {
    round: message.round,
    agentId: message.agentId || "",
    agentName: message.agentName || "",
    response: message.response || null,
    artifacts: array(message.artifacts),
    displayText: message.displayText || "",
    rawText: message.rawText || "",
    interim: Boolean(message.interim),
    phase: message.phase || "",
    modelCallIndex: Number(message.modelCallIndex || 0),
    error: message.error || "",
    startedAt: message.startedAt || "",
    createdAt: message.createdAt || "",
    durationMs: Number(message.durationMs || 0)
  };
}

function indexEntry(event, offset, length) {
  return {
    id: event.id,
    sequence: Number(event.sequence || 0),
    type: event.type,
    occurredAt: event.occurredAt,
    sessionId: event.sessionId,
    round: Number(event.round || 0),
    actorId: event.actor?.id || "",
    actorName: event.actor?.name || "",
    taskId: event.taskId || "",
    status: event.status || "",
    tool: event.tool || "",
    filePaths: array(event.filePaths),
    commitHashes: array(event.commitHashes),
    preview: truncate(event.text, 700),
    text: truncate([event.taskText, event.text, event.tool, ...array(event.filePaths), ...array(event.commitHashes)].filter(Boolean).join("\n"), MAX_INDEX_TEXT),
    offset,
    length
  };
}

function matchScore(item, filters) {
  if (item.tombstoned && !filters.includeDeleted) return -1;
  if (filters.types.size && !filters.types.has(normalize(item.type))) return -1;
  if (filters.actors.size && ![normalize(item.actorId), normalize(item.actorName)].some((value) => filters.actors.has(value))) return -1;
  if (filters.tools.size && !filters.tools.has(normalize(item.tool))) return -1;
  if (filters.statuses.size && !filters.statuses.has(normalize(item.status))) return -1;
  if (filters.task && !normalize(`${item.taskId}\n${item.text}`).includes(filters.task)) return -1;
  if (filters.file && !item.filePaths.some((value) => normalize(value).includes(filters.file))) return -1;
  if (filters.commit && !item.commitHashes.some((value) => normalize(value).startsWith(filters.commit))) return -1;
  if (filters.sessionId && normalize(item.sessionId) !== filters.sessionId) return -1;
  if (filters.excludedSessionIds.has(normalize(item.sessionId))) return -1;
  const occurred = timestamp(item.occurredAt);
  if (filters.fromMs && occurred < filters.fromMs) return -1;
  if (filters.toMs && occurred > filters.toMs) return -1;
  const haystack = normalize(item.text);
  if (filters.terms.length && !filters.terms.every((term) => haystack.includes(term))) return -1;
  return filters.terms.reduce((score, term) => score + countOccurrences(haystack, term), 0)
    + (filters.types.size ? 5 : 0)
    + (filters.actors.size ? 4 : 0)
    + (filters.tools.size ? 4 : 0)
    + (filters.file ? 4 : 0)
    + (filters.commit ? 6 : 0);
}

function readOrRebuildIndex(groupPath) {
  const paths = journalPaths(groupPath);
  if (!fs.existsSync(paths.index)) return rebuildPublicEventIndex(groupPath);
  try {
    const index = JSON.parse(fs.readFileSync(paths.index, "utf8"));
    if (index?.schema !== INDEX_SCHEMA || !Array.isArray(index.events)) throw new Error("invalid index");
    if (fs.existsSync(paths.journal) && Number(index.journalBytes || 0) !== fs.statSync(paths.journal).size) {
      return rebuildPublicEventIndex(groupPath);
    }
    return index;
  } catch {
    return rebuildPublicEventIndex(groupPath);
  }
}

function writeIndex(filePath, index) {
  const journalPath = path.join(path.dirname(filePath), "public-events.jsonl");
  index.journalBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0;
  index.updatedAt = new Date().toISOString();
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function writeHotCache(paths, index) {
  const events = index.events.filter((item) => !item.tombstoned).slice(-MAX_HOT_EVENTS).map((item) => ({
    eventId: item.id,
    sequence: item.sequence,
    type: item.type,
    occurredAt: item.occurredAt,
    sessionId: item.sessionId,
    round: item.round,
    actorId: item.actorId,
    actorName: item.actorName,
    status: item.status,
    tool: item.tool,
    filePaths: item.filePaths,
    commitHashes: item.commitHashes,
    text: truncate(item.preview || item.text, 700),
    sourcePath: `${index.journalPath}#event=${item.id}`
  }));
  const cache = {
    schema: HOT_CACHE_SCHEMA,
    source: "derived_from_public_event_journal",
    sourceJournalPath: index.journalPath,
    sourceJournalBytes: fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0,
    rebuiltAt: new Date().toISOString(),
    events
  };
  const temporary = `${paths.hotCache}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(temporary, paths.hotCache);
  return cache;
}

function filteredHotCache(cache, options) {
  const excluded = stringSet(options.excludeSessionId || options.excludeSessionIds);
  return {
    ...cache,
    events: cache.events.filter((item) => !excluded.has(normalize(item.sessionId)))
  };
}

function writeCompression(paths, index) {
  const bySession = new Map();
  for (const event of index.events.filter((item) => !item.tombstoned)) {
    if (!bySession.has(event.sessionId)) bySession.set(event.sessionId, []);
    bySession.get(event.sessionId).push(event);
  }
  const windows = [...bySession.entries()].map(([sessionId, events]) => compressedWindow(sessionId, events));
  const compression = {
    schema: COMPRESSION_SCHEMA,
    source: "deterministic_derivation_from_public_event_journal",
    sourceJournalPath: index.journalPath,
    sourceJournalBytes: fs.existsSync(paths.journal) ? fs.statSync(paths.journal).size : 0,
    rebuiltAt: new Date().toISOString(),
    windows
  };
  const temporary = `${paths.compression}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(compression, null, 2), "utf8");
  fs.renameSync(temporary, paths.compression);
  return compression;
}

function compressedWindow(sessionId, events) {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const user = sorted.find((item) => item.type === "user_message");
  const final = [...sorted].reverse().find((item) => item.type === "final_decision");
  const failures = sorted.filter((item) => ["failed", "unavailable", "rejected", "needs_revision", "guard_stopped"].includes(normalize(item.status)));
  const latestMembers = sorted.filter((item) => item.type === "member_message").slice(-3);
  return {
    id: `session-window:${sessionId}`,
    sessionId,
    sourceEventIds: sorted.map((item) => item.id),
    sourceSequenceStart: sorted[0]?.sequence || 0,
    sourceSequenceEnd: sorted.at(-1)?.sequence || 0,
    eventCount: sorted.length,
    occurredAtStart: sorted[0]?.occurredAt || "",
    occurredAtEnd: sorted.at(-1)?.occurredAt || "",
    typeCounts: countValues(sorted.map((item) => item.type)),
    actors: unique(sorted.map((item) => item.actorName || item.actorId)),
    statuses: unique(sorted.map((item) => item.status)),
    tools: unique(sorted.map((item) => item.tool)),
    filePaths: unique(sorted.flatMap((item) => item.filePaths || [])).slice(0, 200),
    commitHashes: unique(sorted.flatMap((item) => item.commitHashes || [])).slice(0, 50),
    summary: [
      user?.preview ? `User: ${user.preview}` : "",
      ...latestMembers.map((item) => `${item.actorName || item.actorId || "Member"} [${item.status || "unknown"}]: ${item.preview || ""}`),
      ...failures.slice(-3).map((item) => `Failure ${item.type} [${item.status}]: ${item.preview || ""}`),
      final?.preview ? `Final [${final.status || "unknown"}]: ${final.preview}` : ""
    ].filter(Boolean).join("\n")
  };
}

function countValues(values) {
  const counts = {};
  for (const value of values.filter(Boolean)) counts[value] = Number(counts[value] || 0) + 1;
  return counts;
}

function unique(values) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function emptyIndex(journalPath) {
  return { schema: INDEX_SCHEMA, journalPath, journalBytes: 0, lastSequence: 0, invalidLines: 0, updatedAt: "", tombstonedIds: [], deletedSessionIds: [], events: [] };
}

function normalizeIndex(index) {
  index.tombstonedIds = unique(array(index.tombstonedIds));
  index.deletedSessionIds = unique(array(index.deletedSessionIds));
  applyTombstones(index);
  return index;
}

function applyTombstones(index) {
  const deleted = new Set(index.tombstonedIds);
  for (const event of index.events) event.tombstoned = deleted.has(event.id);
}

function journalPaths(groupPath) {
  const root = path.resolve(groupPath);
  const dir = path.join(root, "shared", "memory", "events");
  return {
    dir,
    journal: path.join(dir, "public-events.jsonl"),
    index: path.join(dir, "public-events.index.json"),
    hotCache: path.join(dir, "public-events.hot.json"),
    compression: path.join(dir, "public-events.compressed.json"),
    relativeJournal: "shared/memory/events/public-events.jsonl"
  };
}

function actor(value = {}) {
  return {
    kind: value.source_agent_id || value.agentId ? "member" : "system",
    id: String(value.source_agent_id || value.agentId || ""),
    name: String(value.source_agent_name || value.agentName || "")
  };
}

function eventText(value = {}) {
  return [value.reason, value.error, value.command, value.query, value.path, value.destination, value.result?.stdout, value.result?.stderr]
    .filter(Boolean).join("\n");
}

function extractPaths(value) {
  const found = new Set();
  walk(value, (key, item) => {
    if (!/(?:^|_)(?:path|paths|file|files|destination|cwd|created|modified|deleted|observedArtifacts)$/i.test(key)) return;
    for (const entry of Array.isArray(item) ? item : [item]) {
      if (typeof entry !== "string") continue;
      const text = String(entry || "").trim();
      if (text && text.length <= 1000) found.add(text.replaceAll("\\", "/"));
    }
  });
  return [...found].slice(0, 200);
}

function extractCommits(value) {
  const found = new Set();
  walk(value, (key, item) => {
    if (!/(?:commit|hash|head|revision)/i.test(key)) return;
    for (const match of String(item || "").matchAll(/\b[0-9a-f]{7,40}\b/gi)) found.add(match[0].toLowerCase());
  });
  return [...found].slice(0, 50);
}

function walk(value, visit, depth = 0) {
  if (!value || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) walk(item, visit, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    if (item && typeof item === "object") walk(item, visit, depth + 1);
  }
}

function stringSet(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(values.map(normalize).filter(Boolean));
}

function tokenize(value) {
  return normalize(value).split(/\s+/).filter(Boolean).slice(0, 20);
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replaceAll("\\", "/");
}

function timestamp(value) {
  if (!value) return 0;
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : 0;
}

function countOccurrences(text, term) {
  if (!term) return 0;
  return Math.max(1, text.split(term).length - 1);
}

function safePart(value) {
  return String(value || "item").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "item";
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? Math.floor(number) : min));
}

function journalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
