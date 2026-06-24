import test from "node:test";
import assert from "node:assert/strict";
import { applyObjectionLedger, isReviewerLike, normalizeObjectionItems, reviewIntensityRules, unresolvedBlockingItems } from "../src/objectionLedger.js";

test("review intensity enforces scope gate and blocking severity", () => {
  const items = normalizeObjectionItems([
    {
      id: "distributed-audit",
      issue: "Hello world does not include distributed audit logging.",
      severity: "blocker",
      blocks_final: true,
      in_scope: false,
      why: "Out of scope.",
      suggested_fix: "Do not block."
    },
    {
      id: "syntax",
      issue: "Hello world code has a syntax error.",
      severity: "blocker",
      blocks_final: true,
      in_scope: true,
      why: "It cannot run.",
      suggested_fix: "Fix the syntax."
    }
  ], { reviewIntensity: 1 });

  assert.equal(items[0].blocks_final, false);
  assert.equal(items[1].blocks_final, true);
});

test("missing objection schema fields get conservative defaults", () => {
  const [item] = normalizeObjectionItems([
    {
      issue: "Missing edge case."
    }
  ], { reviewIntensity: 2 });

  assert.match(item.id, /missing-edge-case/);
  assert.equal(item.severity, "minor");
  assert.equal(item.in_scope, true);
  assert.equal(item.blocks_final, false);
});

test("review intensity maps to per-round new objection limits", () => {
  assert.equal(reviewIntensityRules({ reviewIntensity: 1 }).maxNewObjectionsPerRound, 2);
  assert.equal(reviewIntensityRules({ reviewIntensity: 2 }).maxNewObjectionsPerRound, 5);
  assert.equal(reviewIntensityRules({ reviewIntensity: 3 }).maxNewObjectionsPerRound, 8);
});

test("ledger rejects duplicate new ids and closes only via resolved_ids", () => {
  const session = { unresolvedObjections: {}, objectionLedger: {} };
  const agent = { id: "reviewer", name: "Reviewer", reviewer: true, reviewIntensity: 2 };

  applyObjectionLedger(session, agent, {
    status: "speak",
    objection_items: normalizeObjectionItems([
      {
        id: "risk-1",
        issue: "Budget reserve can leak on failed rollback.",
        severity: "major",
        blocks_final: true,
        in_scope: true,
        why: "The user asked for reliable budget control.",
        suggested_fix: "Add timeout release."
      }
    ], { reviewIntensity: 2 })
  }, { round: 1 });

  applyObjectionLedger(session, agent, {
    status: "speak",
    objection_items: normalizeObjectionItems([
      {
        id: "risk-1-copy",
        issue: "Budget reserve can leak on failed rollback.",
        severity: "major",
        blocks_final: true,
        in_scope: true,
        why: "Same issue.",
        suggested_fix: "Same fix."
      }
    ], { reviewIntensity: 2 })
  }, { round: 2 });

  assert.equal(Object.keys(session.objectionLedger.reviewer).length, 1);
  assert.equal(unresolvedBlockingItems(session).length, 1);

  applyObjectionLedger(session, agent, {
    status: "skip",
    resolved_ids: ["risk-1"],
    objection_items: []
  }, { round: 3 });

  assert.equal(unresolvedBlockingItems(session).length, 0);
});

test("only reviewer-like members or user override can close ledger blockers", () => {
  const session = { unresolvedObjections: {}, objectionLedger: {} };
  const red = { id: "red", name: "Red Team", mandatoryRedTeam: true, reviewIntensity: 2 };
  const builder = { id: "builder", name: "Builder" };
  const namedReviewerWithoutToggle = { id: "named-reviewer", name: "Reviewer" };
  const explicitReviewer = { id: "reviewer", name: "Reviewer", reviewer: true };

  applyObjectionLedger(session, red, {
    status: "speak",
    objection_items: normalizeObjectionItems([
      {
        id: "risk-1",
        issue: "The implementation does not run.",
        severity: "blocker",
        blocks_final: true,
        in_scope: true,
        why: "The user asked for executable code.",
        suggested_fix: "Run a smoke test."
      }
    ], { reviewIntensity: 2 })
  }, { round: 1 });

  applyObjectionLedger(session, builder, {
    status: "skip",
    resolved_ids: ["risk-1"],
    objection_items: []
  }, { round: 2 });

  assert.equal(unresolvedBlockingItems(session).length, 1);

  applyObjectionLedger(session, namedReviewerWithoutToggle, {
    status: "skip",
    resolved_ids: ["risk-1"],
    objection_items: []
  }, { round: 3 });

  assert.equal(unresolvedBlockingItems(session).length, 1);

  applyObjectionLedger(session, explicitReviewer, {
    status: "skip",
    resolved_ids: ["risk-1"],
    objection_items: []
  }, { round: 4 });

  assert.equal(unresolvedBlockingItems(session).length, 0);
});
test("reviewer-like detection requires an explicit reviewer flag", () => {
  assert.equal(isReviewerLike({ id: "seat_02", name: "Reviewer" }), false);
  assert.equal(isReviewerLike({ id: "seat_03", role: "Critic" }), false);
  assert.equal(isReviewerLike({ id: "seat_04", role: "Student", reviewer: true }), true);
  assert.equal(isReviewerLike({ id: "seat_05", role: "Red Team", mandatoryRedTeam: true }), true);
});
test("per-round new objection limit applies only to new ids", () => {
  const session = { unresolvedObjections: {}, objectionLedger: {} };
  const agent = { id: "reviewer", name: "Reviewer", reviewer: true, reviewIntensity: 1 };
  const many = [1, 2, 3].map((index) => ({
    id: `risk-${index}`,
    issue: `Blocking issue ${index}`,
    severity: "blocker",
    blocks_final: true,
    in_scope: true,
    why: "Blocks the user goal.",
    suggested_fix: "Fix it."
  }));

  applyObjectionLedger(session, agent, {
    status: "speak",
    objection_items: normalizeObjectionItems(many, { reviewIntensity: 1 })
  }, { round: 1 });

  assert.equal(Object.keys(session.objectionLedger.reviewer).length, 2);
  assert.equal(unresolvedBlockingItems(session).length, 2);
});
