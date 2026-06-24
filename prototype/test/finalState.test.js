import test from "node:test";
import assert from "node:assert/strict";
import { computeFinalState } from "../src/finalState.js";

test("final state is ready when no blocker or risk remains", () => {
  const state = computeFinalState({ objectionLedger: {}, messages: [{ round: 1 }] }, { maxRounds: 3 });
  assert.equal(state.final_state, "ready_to_execute");
  assert.deepEqual(state.blocking_issues, []);
});

test("final state is usable with risks when only non-blocking risks remain", () => {
  const state = computeFinalState({
    objectionLedger: {
      red: {
        "risk-1": {
          id: "risk-1",
          issue: "Consider adding metrics.",
          severity: "minor",
          blocks_final: false,
          in_scope: true,
          status: "open",
          source_agent_id: "red",
          source_agent_name: "Red Team"
        }
      }
    },
    messages: [{ round: 2 }]
  }, { maxRounds: 5 });

  assert.equal(state.final_state, "usable_with_risks");
  assert.equal(state.unresolved_risks.length, 1);
});

test("final state needs revision when an unresolved blocker remains before max rounds", () => {
  const state = computeFinalState({
    objectionLedger: {
      red: {
        "blocker-1": {
          id: "blocker-1",
          issue: "Code does not run.",
          severity: "blocker",
          blocks_final: true,
          in_scope: true,
          status: "open",
          source_agent_id: "red",
          source_agent_name: "Red Team"
        }
      }
    },
    messages: [{ round: 2 }]
  }, { maxRounds: 5 });

  assert.equal(state.final_state, "needs_revision");
  assert.equal(state.blocking_issues[0].id, "blocker-1");
});

test("final state fails to converge when max rounds are reached with blockers", () => {
  const state = computeFinalState({
    objectionLedger: {
      red: {
        "blocker-1": {
          id: "blocker-1",
          issue: "Missing required output.",
          severity: "major",
          blocks_final: true,
          in_scope: true,
          status: "open",
          source_agent_id: "red",
          source_agent_name: "Red Team"
        }
      }
    },
    consensusByRound: [{ round: 4 }]
  }, { maxRounds: 4 });

  assert.equal(state.final_state, "failed_to_converge");
});
