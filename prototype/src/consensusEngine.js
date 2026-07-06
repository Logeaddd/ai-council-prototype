export function scoreConsensus(enabledAgents, session, options = {}) {
  const votingAgents = consensusVotingAgents(enabledAgents);
  const nonVotingAgents = new Set(enabledAgents.filter((agent) => !votingAgents.includes(agent)).map((agent) => agent.id));
  const nonRedTeam = votingAgents.filter((agent) => !agent.mandatoryRedTeam);
  const denominator = sumWeights(nonRedTeam) || 1;
  let supportingWeight = 0;
  const latest = options.round ? responsesForRound(session, options.round) : latestResponses(session);
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

  const latest = responsesForRound(session, round);
  const nonRedTeam = consensusVotingAgents(enabledAgents).filter((agent) => !agent.mandatoryRedTeam);
  return nonRedTeam.every((agent) => isSupportingResponse(latest.get(agent.id)));
}

export function latestResponses(session) {
  const latest = new Map();
  for (const message of session.messages) latest.set(message.agentId, message.response);
  return latest;
}

export function responsesForRound(session, round) {
  const current = new Map();
  const hasRoundMetadata = session.messages.some((message) => message.round != null);
  for (const message of session.messages) {
    if (message.round === round) current.set(message.agentId, message.response);
  }
  return hasRoundMetadata ? current : latestResponses(session);
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

export function isSupportingResponse(response) {
  return response?.status === "skip";
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
