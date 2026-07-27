import test from "node:test";
import assert from "node:assert/strict";
import { scoreConsensus, shouldStop, updateUnresolvedObjections } from "../src/consensusEngine.js";
import { applyObjectionLedger, normalizeObjectionItems } from "../src/objectionLedger.js";

const agents = [
  { id: "builder", name: "Builder", weight: 1 },
  { id: "critic", name: "Critic / Red Team", weight: 1, mandatoryRedTeam: true },
  { id: "judge", name: "Judge", weight: 1, judge: true }
];

test("does not treat first-round speak-without-objection as a skip consensus", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["false convergence"],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "speak", objections: [] } },
      { agentId: "critic", response: { status: "speak", objections: ["false convergence"] } },
      { agentId: "judge", response: { status: "speak", objections: [] } }
    ]
  };

  const consensus = scoreConsensus(agents, session);
  assert.equal(consensus.score, 0);
  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 3, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 1), false);
});

test("an unbounded round configuration does not turn an arbitrary round number into completion", () => {
  const session = { unresolvedObjections: {}, messages: [{ agentId: "builder", response: { status: "speak" } }] };
  const consensus = { score: 0 };

  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 0, minRounds: 1, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 30), false);
});

test("counts explicit non-red-team skips toward consensus", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "No objection" } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"] } },
      { agentId: "judge", response: { status: "skip", reason: "No objection" } }
    ]
  };

  const consensus = scoreConsensus(agents, session);
  assert.equal(consensus.score, 1);
  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 3, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 2), true);
});

test("unavailable members do not count as consensus support or all-skip", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "No objection" } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"] } },
      { agentId: "judge", response: { status: "unavailable", reason: "rate_limited", retryable: true } }
    ]
  };

  const consensus = scoreConsensus(agents, session);
  assert.equal(consensus.score, 1);
  assert.deepEqual(consensus.supportingAgents, ["Builder"]);
  assert.deepEqual(consensus.dissentingAgents, ["Critic / Red Team", "Judge"]);
  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 3, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 2), true);
});

test("judge is final synthesizer by default and does not dilute consensus denominator", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: ["summarize dissent"]
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "No objection" } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"] } },
      { agentId: "judge", response: { status: "speak", objections: ["summarize dissent"] } }
    ]
  };

  const consensus = scoreConsensus(agents, session);

  assert.equal(consensus.denominator, 1);
  assert.equal(consensus.score, 1);
  assert.deepEqual(consensus.supportingAgents, ["Builder"]);
  assert.deepEqual(consensus.dissentingAgents, ["Critic / Red Team", "Judge"]);
  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 10, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 2), true);
});

test("judge can explicitly participate in consensus voting", () => {
  const votingJudgeAgents = agents.map((agent) => agent.id === "judge" ? { ...agent, consensusParticipant: true } : agent);
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: ["still objecting"]
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "No objection" } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"] } },
      { agentId: "judge", response: { status: "speak", objections: ["still objecting"] } }
    ]
  };

  const consensus = scoreConsensus(votingJudgeAgents, session);

  assert.equal(consensus.denominator, 2);
  assert.equal(consensus.score, 0.5);
  assert.deepEqual(consensus.supportingAgents, ["Builder"]);
  assert.deepEqual(consensus.dissentingAgents, ["Critic / Red Team", "Judge"]);
  assert.equal(shouldStop(consensus, votingJudgeAgents, session, { maxRounds: 10, minConsensusWeight: 0.75, stopWhenAllSkip: true }, 2), false);
});

test("red team unavailable is preserved as dissent instead of skip support", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: [],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "No objection" } },
      { agentId: "critic", response: { status: "unavailable", reason: "agent_call_failed:critic:429", retryable: true } },
      { agentId: "judge", response: { status: "skip", reason: "No objection" } }
    ]
  };

  const consensus = scoreConsensus(agents, session);
  assert.equal(consensus.score, 1);
  assert.deepEqual(consensus.supportingAgents, ["Builder"]);
  assert.deepEqual(consensus.dissentingAgents, ["Critic / Red Team"]);
});
test("clears prior unresolved objections when an agent skips", () => {
  const session = {
    unresolvedObjections: {
      builder: ["old concern"]
    },
    messages: [
      { agentId: "builder", response: { status: "skip", reason: "Resolved by the latest revision." } },
      { agentId: "judge", response: { status: "skip", reason: "No objection." } }
    ]
  };

  updateUnresolvedObjections(session, agents[0], session.messages[0].response);
  const consensus = scoreConsensus(agents, session);

  assert.deepEqual(session.unresolvedObjections.builder, []);
  assert.equal(consensus.score, 1);
  assert.deepEqual(consensus.supportingAgents, ["Builder"]);
});

test("ordinary non-reviewer objections do not become unresolved blockers", () => {
  const session = {
    unresolvedObjections: {},
    messages: [
      {
        agentId: "builder",
        response: {
          status: "speak",
          argument: "I answer the question by raising and responding to an objection.",
          objections: ["A handled counterargument included in the answer."],
          objection_items: [
            {
              id: "handled-counterargument",
              issue: "A handled counterargument included in the answer.",
              severity: "minor",
              blocks_final: false,
              in_scope: true,
              why: "Part of the answer structure.",
              suggested_fix: "No follow-up needed."
            }
          ],
          suggested_revision: "Final answer with the counterargument handled."
        }
      }
    ]
  };

  updateUnresolvedObjections(session, agents[0], session.messages[0].response);
  const consensus = scoreConsensus(agents, session);

  assert.deepEqual(session.unresolvedObjections.builder, []);
  assert.equal(session.messages[0].response.status, "speak");
  assert.equal(consensus.score, 0);
});

test("explicit reviewer objections still become unresolved dissent", () => {
  const session = {
    unresolvedObjections: {},
    messages: [
      {
        agentId: "critic",
        response: {
          status: "speak",
          argument: "This is a real review concern.",
          objections: ["Real reviewer concern."]
        }
      }
    ]
  };

  updateUnresolvedObjections(session, agents[1], session.messages[0].response);
  const consensus = scoreConsensus(agents, session);

  assert.deepEqual(session.unresolvedObjections.critic, ["Real reviewer concern."]);
  assert.deepEqual(consensus.dissentingAgents, ["Builder", "Critic / Red Team"]);
});

test("repeated non-red-team deliverables stay real speak events until the model returns skip", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "speak", argument: "Code v1", objections: [], artifacts: [{ type: "code", content: "v1" }] } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"], artifacts: [{ type: "note", content: "risk" }] } },
      { agentId: "judge", response: { status: "skip", reason: "No objection." } },
      { agentId: "builder", response: { status: "speak", argument: "Code v2", objections: [], artifacts: [{ type: "code", content: "v2" }] } }
    ]
  };

  updateUnresolvedObjections(session, agents[0], session.messages.at(-1).response);
  const consensus = scoreConsensus(agents, session);

  assert.equal(session.messages.at(-1).response.status, "speak");
  assert.equal(consensus.score, 0);
  assert.deepEqual(consensus.supportingAgents, []);
  assert.equal(session.messages[1].response.status, "speak");
});

test("file operation proposals are not converted into skip support", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: ["preserve dissent"],
      judge: []
    },
    messages: [
      { agentId: "builder", response: { status: "speak", argument: "File op v1", objections: [], file_operations: [{ op: "write", path: "src/out.js", content: "v1" }] } },
      { agentId: "critic", response: { status: "speak", objections: ["preserve dissent"] } },
      { agentId: "builder", response: { status: "speak", argument: "File op v2", objections: [], file_operations: [{ op: "write", path: "src/out.js", content: "v2" }] } }
    ]
  };

  updateUnresolvedObjections(session, agents[0], session.messages.at(-1).response);
  const consensus = scoreConsensus(agents, session);

  assert.equal(session.messages.at(-1).response.status, "speak");
  assert.equal(consensus.score, 0);
  assert.deepEqual(consensus.supportingAgents, []);
});

test("current-round all-skip requires real skip responses in that round", () => {
  const session = {
    unresolvedObjections: {
      builder: [],
      critic: [],
      judge: []
    },
    messages: [
      { round: 1, agentId: "builder", response: { status: "speak", suggested_revision: "v1" } },
      { round: 1, agentId: "critic", response: { status: "skip", reason: "No objection." } },
      { round: 2, agentId: "critic", response: { status: "skip", reason: "No objection." } }
    ]
  };

  const consensus = scoreConsensus(agents, session, { round: 2 });

  assert.equal(consensus.score, 0);
  assert.equal(shouldStop(consensus, agents, session, { maxRounds: 5, minConsensusWeight: 1, stopWhenAllSkip: true }, 2), false);

  session.messages.push({ round: 2, agentId: "builder", response: { status: "skip", reason: "No new objection." } });
  const afterRealSkip = scoreConsensus(agents, session, { round: 2 });

  assert.equal(afterRealSkip.score, 1);
  assert.equal(shouldStop(afterRealSkip, agents, session, { maxRounds: 5, minConsensusWeight: 1, stopWhenAllSkip: true }, 2), true);
});

test("ledger blocker survives plain skip until reviewer resolves it by id", () => {
  const session = {
    unresolvedObjections: {},
    objectionLedger: {},
    messages: []
  };
  const red = agents[1];

  applyObjectionLedger(session, red, {
    status: "speak",
    objection_items: normalizeObjectionItems([
      {
        id: "risk-1",
        issue: "The artifact cannot run.",
        severity: "blocker",
        blocks_final: true,
        in_scope: true,
        why: "Executable output was requested.",
        suggested_fix: "Provide runnable code."
      }
    ], { reviewIntensity: 2 })
  }, { round: 1 });

  session.messages.push(
    { agentId: "builder", response: { status: "skip", reason: "No objection." } },
    { agentId: "critic", response: { status: "skip", reason: "No new objection." } }
  );

  let consensus = scoreConsensus(agents, session);
  assert.deepEqual(consensus.dissentingAgents, ["Critic / Red Team"]);

  applyObjectionLedger(session, red, {
    status: "skip",
    reason: "Resolved.",
    resolved_ids: ["risk-1"]
  }, { round: 2 });

  consensus = scoreConsensus(agents, session);
  assert.equal(consensus.dissentingAgents.includes("Critic / Red Team"), false);
});
