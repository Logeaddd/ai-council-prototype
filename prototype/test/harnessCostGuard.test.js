import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { assertHardCampaignBudgetGroup, createPersistentCampaignBudgetGuard, readCampaignBudgetLedger } from "../src/harnessCostGuard.js";

function group() {
  return {
    agents: [{
      id: "worker",
      name: "Worker",
      provider: "openai-compatible",
      enabled: true,
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      costGuardMaxInputTokens: 1_000_000,
      costGuardMaxOutputTokens: 1_000_000
    }]
  };
}

test("hard campaign budget rejects missing maximum-call pricing bounds", () => {
  const invalid = group();
  delete invalid.agents[0].costGuardMaxOutputTokens;
  assert.throws(() => assertHardCampaignBudgetGroup(invalid), (error) => error.code === "missing_cost_guard_bounds");
});

test("persistent campaign budget reserves the worst-case next call before sending it", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-budget-"));
  const controller = new AbortController();
  try {
    const guard = createPersistentCampaignBudgetGuard({ group: group(), groupPath, controller, maxCostUsd: 3, maxModelCalls: 4 });
    guard.onModelCall({ sessionId: "one", agentId: "worker", phase: "round" });
    assert.equal(controller.signal.aborted, false);
    assert.equal(readCampaignBudgetLedger(groupPath).modelCalls, 1);
    assert.equal(readCampaignBudgetLedger(groupPath).reservedCostUsd, 2);

    guard.onModelCall({ sessionId: "two", agentId: "worker", phase: "round" });
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason.code, "cost_cap_exceeded");
    assert.equal(readCampaignBudgetLedger(groupPath).modelCalls, 1, "a rejected next call is never recorded as authorized");
  } finally {
    fs.rmSync(groupPath, { recursive: true, force: true });
  }
});
