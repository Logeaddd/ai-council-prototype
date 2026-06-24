const DEFAULT_INTENSITY = 2;
const LIMITS_BY_INTENSITY = {
  1: { maxNew: 2, blocking: new Set(["blocker"]) },
  2: { maxNew: 5, blocking: new Set(["blocker", "major"]) },
  3: { maxNew: 8, blocking: new Set(["blocker", "major"]) }
};

export function reviewIntensity(agent = {}, settings = {}) {
  const value = Number(agent.reviewIntensity ?? settings.reviewIntensity ?? DEFAULT_INTENSITY);
  return [1, 2, 3].includes(value) ? value : DEFAULT_INTENSITY;
}

export function reviewIntensityRules(agent = {}, settings = {}) {
  const intensity = reviewIntensity(agent, settings);
  return {
    intensity,
    maxNewObjectionsPerRound: LIMITS_BY_INTENSITY[intensity].maxNew,
    blockingSeverities: [...LIMITS_BY_INTENSITY[intensity].blocking]
  };
}

export function isReviewerLike(agent = {}) {
  return Boolean(agent.mandatoryRedTeam || agent.reviewer);
}

export function normalizeObjectionItems(value, options = {}) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item, index) => normalizeObjectionItem(item, index, options))
    .filter(Boolean);
}

export function normalizeResolvedIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim()))];
}

export function applyObjectionLedger(session, agent, response, options = {}) {
  session.objectionLedger ||= {};
  const agentLedger = session.objectionLedger[agent.id] || {};
  const reviewerLike = isReviewerLike(agent);
  const intensity = reviewIntensity(agent, options.groupSettings);
  const limits = LIMITS_BY_INTENSITY[intensity];
  const resolvedIds = normalizeResolvedIds(response.resolved_ids);
  const incomingItems = reviewerLike || hasBlockingItems(response.objection_items)
    ? response.objection_items || []
    : [];

  if (!Object.keys(agentLedger).length && !resolvedIds.length && !incomingItems.length) {
    return session.objectionLedger;
  }

  for (const id of resolvedIds) {
    resolveLedgerItem(session, agent, id, options);
  }

  const globalOpenItems = unresolvedLedgerItems(session);
  const acceptedNew = [];
  const rejectedNew = [];
  let newCount = 0;

  for (const rawItem of incomingItems) {
    const duplicate = findDuplicate(rawItem, globalOpenItems);
    const isExisting = Boolean(agentLedger[rawItem.id]);
    if (duplicate && !isExisting) {
      rejectedNew.push({ ...rawItem, rejected_reason: `duplicate_of:${duplicate.id}` });
      continue;
    }

    if (!isExisting && newCount >= limits.maxNew) {
      rejectedNew.push({ ...rawItem, rejected_reason: "new_objection_limit_exceeded" });
      continue;
    }

    const item = applyIntensityPolicy(rawItem, intensity, {
      round: options.round,
      agent
    });
    agentLedger[item.id] = {
      ...agentLedger[item.id],
      ...item,
      status: "open",
      first_round: agentLedger[item.id]?.first_round ?? options.round,
      last_round: options.round,
      source_agent_id: agent.id,
      source_agent_name: agent.name,
      source_is_reviewer: reviewerLike
    };
    acceptedNew.push(agentLedger[item.id]);
    if (!isExisting) newCount += 1;
  }

  session.objectionLedger[agent.id] = agentLedger;
  syncLegacyUnresolvedFromLedger(session);
  response.objection_items = acceptedNew;
  response.rejected_objection_items = rejectedNew;
  response.resolved_ids = resolvedIds;
  return session.objectionLedger;
}

function hasBlockingItems(items = []) {
  return Array.isArray(items) && items.some((item) => item?.blocks_final);
}

export function unresolvedLedgerItems(session, options = {}) {
  const includeNonBlocking = options.includeNonBlocking !== false;
  return Object.values(session.objectionLedger || {})
    .flatMap((byId) => Object.values(byId))
    .filter((item) => item.status !== "resolved")
    .filter((item) => includeNonBlocking || item.blocks_final);
}

export function unresolvedBlockingItems(session) {
  return unresolvedLedgerItems(session, { includeNonBlocking: false });
}

function resolveLedgerItem(session, agent, id, options = {}) {
  for (const [sourceAgentId, byId] of Object.entries(session.objectionLedger || {})) {
    const item = byId[id];
    if (!item || item.status === "resolved") continue;
    if (!canResolveLedgerItem(agent, item, sourceAgentId, options)) continue;
    byId[id] = {
      ...item,
      status: "resolved",
      resolved_round: options.round,
      resolved_by: options.userOverride ? "user" : agent.id
    };
    return true;
  }
  return false;
}

function canResolveLedgerItem(agent, item, sourceAgentId, options = {}) {
  if (options.userOverride) return true;
  if (isReviewerLike(agent)) return true;
  return false;
}

function syncLegacyUnresolvedFromLedger(session) {
  session.unresolvedObjections ||= {};
  for (const [agentId, byId] of Object.entries(session.objectionLedger || {})) {
    session.unresolvedObjections[agentId] = Object.values(byId)
      .filter((item) => item.status !== "resolved")
      .map((item) => item.issue);
  }
}

function normalizeObjectionItem(item, index, options = {}) {
  if (typeof item === "string") {
    const issue = item.trim();
    if (!issue) return undefined;
    return applyIntensityPolicy({
      id: makeFallbackId(issue, index),
      issue,
      severity: "minor",
      blocks_final: false,
      in_scope: true,
      why: "Unstructured objection from model.",
      suggested_fix: ""
    }, options.reviewIntensity || DEFAULT_INTENSITY);
  }
  if (!item || typeof item !== "object") return undefined;
  const issue = stringOr(item.issue, item.problem, item.description).trim();
  if (!issue) return undefined;
  return applyIntensityPolicy({
    id: stringOr(item.id, makeFallbackId(issue, index)),
    issue,
    severity: normalizeSeverity(item.severity),
    blocks_final: Boolean(item.blocks_final),
    in_scope: item.in_scope !== false,
    why: stringOr(item.why, item.reason),
    suggested_fix: stringOr(item.suggested_fix, item.fix)
  }, options.reviewIntensity || DEFAULT_INTENSITY);
}

function applyIntensityPolicy(item, intensity) {
  const normalized = {
    ...item,
    id: sanitizeId(item.id || makeFallbackId(item.issue, 0)),
    severity: normalizeSeverity(item.severity),
    in_scope: item.in_scope !== false
  };
  const blockingAllowed = LIMITS_BY_INTENSITY[intensity]?.blocking || LIMITS_BY_INTENSITY[DEFAULT_INTENSITY].blocking;
  normalized.blocks_final = Boolean(normalized.blocks_final)
    && normalized.in_scope
    && blockingAllowed.has(normalized.severity);
  return normalized;
}

function findDuplicate(item, existingItems) {
  const normalizedIssue = normalizeText(item.issue);
  return existingItems.find((existing) => {
    if (existing.id === item.id) return true;
    const existingIssue = normalizeText(existing.issue);
    return existingIssue && normalizedIssue && (existingIssue === normalizedIssue || existingIssue.includes(normalizedIssue) || normalizedIssue.includes(existingIssue));
  });
}

function normalizeSeverity(value) {
  return ["blocker", "major", "minor", "nit"].includes(value) ? value : "minor";
}

function sanitizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "objection";
}

function makeFallbackId(issue, index) {
  const base = sanitizeId(issue).slice(0, 40) || "objection";
  return `${base}-${index + 1}`;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function stringOr(...values) {
  const found = values.find((value) => typeof value === "string" && value.trim());
  return found ? found.trim() : "";
}
