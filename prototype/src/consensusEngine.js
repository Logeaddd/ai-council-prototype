export function scoreConsensus(enabledAgents, session) {
  const votingAgents = consensusVotingAgents(enabledAgents);
  const nonVotingAgents = new Set(enabledAgents.filter((agent) => !votingAgents.includes(agent)).map((agent) => agent.id));
  const nonRedTeam = votingAgents.filter((agent) => !agent.mandatoryRedTeam);
  const denominator = sumWeights(nonRedTeam) || 1;
  let supportingWeight = 0;
  const latest = latestResponses(session);
  const supportingAgents = [];
  const dissentingAgents = [];

  for (const agent of enabledAgents) {
    const response = latest.get(agent.id);
    const unresolved = unresolvedForAgent(session, agent.id);
    if (nonVotingAgents.has(agent.id)) {
      if (unresolved.length || isUnavailableResponse(response)) dissentingAgents.push(agent.name);
      continue;
    }

    if (agent.mandatoryRedTeam) {
      if (unresolved.length || isUnavailableResponse(response)) dissentingAgents.push(agent.name);
      continue;
    }

    const supports = isSupportingResponse(response) && unresolved.length === 0;
    if (supports) {
      supportingWeight += agent.weight;
      supportingAgents.push(agent.name);
    } else {
      dissentingAgents.push(agent.name);
    }
  }

  return {
    score: Math.min(1, supportingWeight / denominator),
    supportingWeight,
    denominator,
    supportingAgents,
    dissentingAgents
  };
}

export function shouldStop(consensus, enabledAgents, session, settings, round) {
  if (round >= settings.maxRounds) return true;
  // Do not stop on consensus/all-skip before the configured minimum rounds.
  const minRounds = Math.max(1, Number(settings.minRounds) || 1);
  if (round < minRounds) return false;
  if (consensus.score >= settings.minConsensusWeight) return true;
  if (!settings.stopWhenAllSkip) return false;

  const latest = latestResponses(session);
  const nonRedTeam = consensusVotingAgents(enabledAgents).filter((agent) => !agent.mandatoryRedTeam);
  return nonRedTeam.every((agent) => isSupportingResponse(latest.get(agent.id)));
}

export function latestResponses(session) {
  const latest = new Map();
  for (const message of session.messages) latest.set(message.agentId, message.response);
  return latest;
}

export function updateUnresolvedObjections(session, agent, response) {
  if (isSupportingResponse(response)) {
    session.unresolvedObjections[agent.id] = [];
    return;
  }
  if (!isReviewerLikeAgent(agent) && !hasBlockingObjectionItems(response)) {
    session.unresolvedObjections[agent.id] = [];
    return;
  }
  session.unresolvedObjections[agent.id] = response.objections ?? [];
}

export function markAutoCompletedResponses(session, enabledAgents) {
  const autoCompletableIds = new Set(enabledAgents.filter((agent) => !isReviewerLikeAgent(agent)).map((agent) => agent.id));
  const priorDeliveries = new Set();
  const hasBlockingObjection = hasUnresolvedBlockingObjection(session);

  for (const message of session.messages) {
    if (!autoCompletableIds.has(message.agentId)) continue;
    const response = message.response;
    if (!response || response.status !== "speak") continue;
    if (unresolvedForAgent(session, message.agentId).length) continue;

    if (hasDeliverable(response)) {
      if (priorDeliveries.has(message.agentId) || !hasBlockingObjection) {
        response.status = "auto_completed";
        response.reason = response.reason || "Delivered a final artifact or revision with no unresolved blocking objection.";
      } else {
        priorDeliveries.add(message.agentId);
      }
    }
  }
}

export function isSupportingResponse(response) {
  return response?.status === "skip" || response?.status === "auto_completed";
}

export function isUnavailableResponse(response) {
  return response?.status === "error" || response?.status === "unavailable";
}

export function isConsensusParticipant(agent) {
  if (agent.consensusParticipant === true) return true;
  if (agent.consensusParticipant === false) return false;
  return !agent.judge;
}

function consensusVotingAgents(enabledAgents) {
  return enabledAgents.filter(isConsensusParticipant);
}

function hasDeliverable(response) {
  return Boolean(response.suggested_revision) || Boolean(response.artifacts?.length) || Boolean(response.file_operations?.length);
}

function hasUnresolvedBlockingObjection(session) {
  if (session.objectionLedger && Object.keys(session.objectionLedger).length) {
    return Object.values(session.objectionLedger)
      .flatMap((byId) => Object.values(byId))
      .some((item) => item.status !== "resolved" && item.blocks_final);
  }
  return Object.values(session.unresolvedObjections || {}).some((items) => Array.isArray(items) && items.length > 0);
}

function isReviewerLikeAgent(agent = {}) {
  return Boolean(agent.mandatoryRedTeam || agent.reviewer);
}

function hasBlockingObjectionItems(response = {}) {
  return Array.isArray(response.objection_items)
    && response.objection_items.some((item) => item?.blocks_final);
}

function sumWeights(agents) {
  return agents.reduce((sum, agent) => sum + agent.weight, 0);
}

function unresolvedForAgent(session, agentId) {
  const ledgerItems = Object.values(session.objectionLedger?.[agentId] || {})
    .filter((item) => item.status !== "resolved");
  if (session.objectionLedger?.[agentId]) return ledgerItems.map((item) => item.issue);
  return session.unresolvedObjections[agentId] ?? [];
}
