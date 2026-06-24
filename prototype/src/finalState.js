import { unresolvedBlockingItems, unresolvedLedgerItems } from "./objectionLedger.js";

export const FINAL_STATES = new Set([
  "ready_to_execute",
  "usable_with_risks",
  "needs_revision",
  "failed_to_converge"
]);

export function computeFinalState(session = {}, settings = {}, options = {}) {
  const blockingIssues = unresolvedBlockingItems(session).map(formatLedgerIssue);
  const unresolvedRisks = unresolvedNonBlockingRisks(session);
  const lastRound = Number(options.round ?? latestRound(session) ?? 0);
  const maxRounds = Number(settings.maxRounds || 0);
  const reachedMaxRounds = Boolean(maxRounds && lastRound >= maxRounds);

  if (blockingIssues.length) {
    return {
      final_state: reachedMaxRounds ? "failed_to_converge" : "needs_revision",
      blocking_issues: blockingIssues,
      unresolved_risks: unresolvedRisks
    };
  }

  return {
    final_state: unresolvedRisks.length ? "usable_with_risks" : "ready_to_execute",
    blocking_issues: [],
    unresolved_risks: unresolvedRisks
  };
}

function unresolvedNonBlockingRisks(session) {
  const ledgerAgentIds = new Set(Object.keys(session.objectionLedger || {}));
  const ledgerRisks = unresolvedLedgerItems(session)
    .filter((item) => !item.blocks_final)
    .map(formatLedgerIssue);
  const legacyRisks = Object.entries(session.unresolvedObjections || {})
    .filter(([agentId]) => !ledgerAgentIds.has(agentId))
    .flatMap(([agentId, objections]) => (objections || []).map((issue, index) => ({
      id: `legacy-${agentId}-${index + 1}`,
      issue,
      severity: "minor",
      blocks_final: false,
      in_scope: true,
      source_agent_id: agentId,
      source_agent_name: agentId,
      status: "open",
      legacy: true
    })));
  return [...ledgerRisks, ...legacyRisks].filter((item) => item.issue);
}

function formatLedgerIssue(item) {
  return {
    id: item.id,
    issue: item.issue,
    severity: item.severity,
    blocks_final: Boolean(item.blocks_final),
    in_scope: item.in_scope !== false,
    why: item.why || "",
    suggested_fix: item.suggested_fix || "",
    source_agent_id: item.source_agent_id,
    source_agent_name: item.source_agent_name,
    status: item.status || "open"
  };
}

function latestRound(session) {
  const consensusRound = session.consensusByRound?.at?.(-1)?.round;
  if (consensusRound) return consensusRound;
  return Math.max(0, ...(session.messages || []).map((message) => Number(message.round || 0)));
}
