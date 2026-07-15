import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";

export function ensureSummaryCache(groupPath, group = undefined) {
  const root = path.resolve(groupPath);
  fs.mkdirSync(sharedCacheDir(root), { recursive: true });
  for (const seat of group?.seats || []) {
    const memberDir = memberPrivateDir(root, seat);
    if (memberDir) fs.mkdirSync(path.join(memberDir, "private_memory"), { recursive: true });
  }
}

export function readSummaryCache(groupPath, agent = {}, group = undefined) {
  const root = path.resolve(groupPath);
  const seat = findSeat(group, agent);
  const memberSummaryPath = memberShortSummaryPath(root, seat);
  const groupSummaryPath = groupSharedSummaryPath(root);
  return {
    memberShortSummary: readTextIfExists(memberSummaryPath),
    memberShortSummaryRecord: readSummaryRecord(memberSummaryPath, "member_short"),
    groupSharedSummary: readTextIfExists(groupSummaryPath),
    groupSharedSummaryRecord: readSummaryRecord(groupSummaryPath, "group_shared"),
    compressedTranscriptChunks: readJsonlIfExists(transcriptChunksPath(root))
  };
}

export function writeMemberShortSummary(groupPath, seat, summary, options = {}) {
  const filePath = memberShortSummaryPath(path.resolve(groupPath), seat);
  if (!filePath) throw new Error("Cannot write member summary without a private folder");
  writeSummaryTextAndRecord(filePath, summary, "member_short", options);
  return filePath;
}

export function writeGroupSharedSummary(groupPath, summary, options = {}) {
  const filePath = groupSharedSummaryPath(path.resolve(groupPath));
  writeSummaryTextAndRecord(filePath, summary, "group_shared", options);
  return filePath;
}

export function appendCompressedTranscriptChunk(groupPath, chunk = {}) {
  const root = path.resolve(groupPath);
  const filePath = transcriptChunksPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const record = {
    id: chunk.id || makeId("chunk"),
    createdAt: chunk.createdAt || nowIso(),
    sourceSessionId: chunk.sourceSessionId || "",
    fromRound: chunk.fromRound,
    toRound: chunk.toRound,
    summary: String(chunk.summary || "").trim(),
    protectedArtifacts: chunk.protectedArtifacts || [],
    protectedObjections: chunk.protectedObjections || [],
    sourceRefs: normalizeSourceRefs(chunk.sourceRefs || chunk.sources),
    provenance: normalizeProvenance(chunk.provenance, chunk.sourceRefs || chunk.sources)
  };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function appendSessionTranscriptChunk(groupPath, session) {
  if (!session?.messages?.length) return undefined;
  const rounds = session.messages.map((message) => message.round).filter((round) => typeof round === "number");
  const protectedArtifacts = (session.artifacts || []).map((artifact) => artifact.id).filter(Boolean);
  const protectedObjections = Object.entries(session.unresolvedObjections || {})
    .flatMap(([agentId, objections]) => (objections || []).map((objection) => `${agentId}: ${objection}`));
  return appendCompressedTranscriptChunk(groupPath, {
    sourceSessionId: session.id,
    fromRound: rounds.length ? Math.min(...rounds) : undefined,
    toRound: rounds.length ? Math.max(...rounds) : undefined,
    summary: summarizeSessionMessages(session.messages),
    protectedArtifacts,
    protectedObjections,
    sourceRefs: sessionMessageSources(session)
  });
}

export function updateDeterministicSummaries(groupPath, session, group = undefined, options = {}) {
  if (!groupPath || !session) return undefined;
  const root = path.resolve(groupPath);
  const maxLines = positiveInteger(options.maxLines) || 12;
  const groupSummary = buildGroupSummary(session, maxLines);
  const memberSummaries = [];
  if (groupSummary.text) writeGroupSharedSummary(root, groupSummary.text, { sourceRefs: groupSummary.sourceRefs, provenance: "attributed" });

  for (const seat of group?.seats || []) {
    const summary = buildMemberSummary(session, seat, maxLines);
    if (!summary.text) continue;
    writeMemberShortSummary(root, seat, summary.text, { sourceRefs: summary.sourceRefs, provenance: "attributed" });
    memberSummaries.push({ seatId: seat.seatId, displayName: seat.displayName, summary: summary.text });
  }

  return {
    groupSummary: groupSummary.text,
    memberSummaries
  };
}

function findSeat(group, agent) {
  if (!group?.seats) return undefined;
  return group.seats.find((seat) => {
    return seat.seatId === agent.id
      || seat.displayName === agent.name
      || seat.currentModel === agent.model
      || seat.role === agent.role;
  });
}

function memberShortSummaryPath(root, seat) {
  const memberDir = memberPrivateDir(root, seat);
  return memberDir ? path.join(memberDir, "private_memory", "short-summary.md") : undefined;
}

function memberPrivateDir(root, seat) {
  if (!seat?.privateFolder) return undefined;
  return path.resolve(root, seat.privateFolder);
}

function groupSharedSummaryPath(root) {
  return path.join(sharedCacheDir(root), "shared-summary.md");
}

function summaryRecordPath(summaryPath) {
  return summaryPath ? `${summaryPath}.metadata.json` : undefined;
}

function transcriptChunksPath(root) {
  return path.join(sharedCacheDir(root), "compressed-transcript.jsonl");
}

function sharedCacheDir(root) {
  return path.join(root, "shared", "cache");
}

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8").trim();
}

function writeSummaryTextAndRecord(filePath, summary, kind, options = {}) {
  const text = String(summary || "").trim();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${text}\n`, "utf8");
  const record = {
    schema: "ai-council.summary-record.v1",
    kind,
    updatedAt: nowIso(),
    text,
    sourceRefs: normalizeSourceRefs(options.sourceRefs || options.sources),
    provenance: normalizeProvenance(options.provenance, options.sourceRefs || options.sources)
  };
  fs.writeFileSync(summaryRecordPath(filePath), JSON.stringify(record, null, 2), "utf8");
  return record;
}

function readSummaryRecord(summaryPath, kind) {
  const text = readTextIfExists(summaryPath);
  if (!text) return undefined;
  const metadataPath = summaryRecordPath(summaryPath);
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return legacySummaryRecord(text, kind, "missing_provenance_sidecar");
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (parsed?.schema !== "ai-council.summary-record.v1" || parsed?.kind !== kind || String(parsed?.text || "").trim() !== text) {
      return legacySummaryRecord(text, kind, "summary_text_changed_after_record");
    }
    return {
      schema: parsed.schema,
      kind,
      updatedAt: String(parsed.updatedAt || ""),
      text,
      sourceRefs: normalizeSourceRefs(parsed.sourceRefs || parsed.sources),
      provenance: normalizeProvenance(parsed.provenance, parsed.sourceRefs || parsed.sources)
    };
  } catch {
    return legacySummaryRecord(text, kind, "invalid_provenance_sidecar");
  }
}

function legacySummaryRecord(text, kind, provenance) {
  return {
    schema: "ai-council.summary-record.v1",
    kind,
    text,
    sourceRefs: [],
    provenance
  };
}

function readJsonlIfExists(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => normalizeTranscriptChunk(JSON.parse(line)));
}

function normalizeTranscriptChunk(chunk = {}) {
  const sourceRefs = normalizeSourceRefs(chunk.sourceRefs || chunk.sources);
  return {
    ...chunk,
    sourceRefs,
    provenance: normalizeProvenance(chunk.provenance, sourceRefs)
  };
}

function summarizeSessionMessages(messages) {
  return messages.map((message) => {
    const response = message.response || {};
    if (response.status === "skip") return `R${message.round} ${message.agentName}: skip`;
    if (response.status === "error" || response.status === "unavailable") {
      return `R${message.round} ${message.agentName}: ${response.status} ${response.reason || ""}`.trim();
    }
    const text = response.argument || response.position || "";
    return `R${message.round} ${message.agentName}: ${truncate(text, 180)}`;
  }).join("\n");
}

function buildGroupSummary(session, maxLines) {
  const finalDecision = session.finalDecision || {};
  const lines = [
    `Session: ${session.id || ""}`,
    session.question ? `Question: ${truncate(session.question, 220)}` : "",
    finalDecision.answer ? `Final: ${truncate(finalDecision.answer, 260)}` : "",
    ...listLines("Risk", finalDecision.risks, 3),
    ...listLines("Next", finalDecision.next_actions, 3),
    ...artifactLines(session.artifacts, 3),
    ...objectionLines(session.unresolvedObjections, 4)
  ].filter(Boolean);
  return summaryDraft(lines.slice(0, maxLines).join("\n"), [
    ...sessionSummarySources(session),
    ...sessionArtifactSources(session),
    ...sessionObjectionSources(session)
  ]);
}

function buildMemberSummary(session, seat, maxLines) {
  const messages = (session.messages || []).filter((message) => {
    return message.agentId === seat.seatId
      || message.agentName === seat.displayName
      || message.agentName === seat.currentModel
      || message.agentName === seat.role;
  });
  const lines = [
    `Member: ${seat.displayName || seat.seatId}`,
    ...messages.slice(-4).map((message) => {
      const response = message.response || {};
      const status = response.status || "unknown";
      const content = response.argument || response.reason || response.position || "";
      return `R${message.round} ${status}: ${truncate(content, 220)}`;
    }),
    ...artifactLines((session.artifacts || []).filter((artifact) => {
      return artifact.source_agent_id === seat.seatId || artifact.source_agent_name === seat.displayName;
    }), 3),
    ...objectionLines({ [seat.seatId]: session.unresolvedObjections?.[seat.seatId] || [] }, 3)
  ].filter(Boolean);
  const sourceRefs = [
    ...messages.map((message, index) => messageSource(session, message, index)),
    ...sessionArtifactSources(session, (artifact) => artifact.source_agent_id === seat.seatId || artifact.source_agent_name === seat.displayName),
    ...sessionObjectionSources(session, [seat.seatId])
  ];
  return summaryDraft(lines.slice(0, maxLines).join("\n"), sourceRefs);
}

function summaryDraft(text, sourceRefs) {
  return {
    text: String(text || "").trim(),
    sourceRefs: normalizeSourceRefs(sourceRefs)
  };
}

function sessionMessageSources(session = {}) {
  return (session.messages || []).map((message, index) => messageSource(session, message, index));
}

function sessionSummarySources(session = {}) {
  const sessionId = String(session.id || "session");
  return [sourceRef("session_question", sessionId), ...sessionMessageSources(session)];
}

function sessionArtifactSources(session = {}, predicate = () => true) {
  return (session.artifacts || [])
    .filter((artifact) => predicate(artifact))
    .map((artifact, index) => sourceRef("artifact", artifact.id || `${session.id || "session"}:artifact:${index}`));
}

function sessionObjectionSources(session = {}, agentIds = undefined) {
  const allowed = agentIds ? new Set(agentIds) : undefined;
  return Object.entries(session.unresolvedObjections || {})
    .filter(([agentId]) => !allowed || allowed.has(agentId))
    .flatMap(([agentId, objections]) => (objections || []).map((objection, index) => {
      const id = typeof objection === "object" ? objection.id || objection.issue || index : index;
      return sourceRef("objection", `${agentId}:${id}`);
    }));
}

function messageSource(session, message = {}, index = 0) {
  return sourceRef("member_message", message.id || `${session.id || "session"}:message:${message.modelCallIndex || index}`);
}

function sourceRef(type, id) {
  return { type: String(type || "").trim(), id: String(id || "").trim() };
}

function normalizeSourceRefs(value) {
  const seen = new Set();
  const refs = [];
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    const type = String(item?.type || item?.sourceType || "").trim();
    const id = String(item?.id || item?.eventId || item?.sourceId || "").trim();
    if (!type || !id || seen.has(`${type}\u001f${id}`)) continue;
    seen.add(`${type}\u001f${id}`);
    refs.push({ type, id });
  }
  return refs;
}

function normalizeProvenance(value, sourceRefs) {
  if (String(value || "").trim()) return String(value).trim();
  return normalizeSourceRefs(sourceRefs).length ? "attributed" : "unattributed";
}

function listLines(prefix, items = [], limit = 3) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => `${prefix}: ${truncate(item, 180)}`);
}

function artifactLines(artifacts = [], limit = 3) {
  return artifacts
    .filter((artifact) => artifact?.id || artifact?.title || artifact?.content)
    .slice(-limit)
    .map((artifact) => `Artifact: ${artifact.id || artifact.title || "artifact"} ${truncate(artifact.title || artifact.type || "", 80)}`.trim());
}

function objectionLines(unresolvedObjections = {}, limit = 4) {
  return Object.entries(unresolvedObjections)
    .flatMap(([agentId, objections]) => (objections || []).map((objection) => `Objection ${agentId}: ${truncate(objection, 180)}`))
    .slice(0, limit);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
