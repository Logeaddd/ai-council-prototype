import fs from "node:fs";
import path from "node:path";
import { estimateCost } from "./usageStats.js";
import { nowIso } from "./types.js";

export function assertHardCampaignBudgetGroup(group = {}) {
  const agents = enabledAgents(group);
  if (!agents.length) throw budgetError("missing_agents", "A real campaign needs at least one enabled agent.");
  for (const agent of agents) {
    if (agent.provider === "mock") throw budgetError("mock_provider_denied", "A real campaign cannot use mock providers.");
    if (!positive(agent.pricing?.inputPerMillion ?? agent.pricing?.input) || !positive(agent.pricing?.outputPerMillion ?? agent.pricing?.output)) {
      throw budgetError("missing_pricing", `Agent ${agent.id || agent.name} needs positive input and output pricing for a hard campaign cost cap.`);
    }
    if (!positive(agent.costGuardMaxInputTokens) || !positive(agent.costGuardMaxOutputTokens)) {
      throw budgetError("missing_cost_guard_bounds", `Agent ${agent.id || agent.name} needs positive costGuardMaxInputTokens and costGuardMaxOutputTokens for a hard campaign cost cap.`);
    }
  }
}

export function createPersistentCampaignBudgetGuard(options = {}) {
  const group = options.group || {};
  const maxCostUsd = positive(options.maxCostUsd);
  const maxModelCalls = integer(options.maxModelCalls);
  const ledgerPath = path.join(path.resolve(options.groupPath || "."), "shared", "logs", "harness-campaign-budget.json");
  if (!maxCostUsd || !maxModelCalls) throw budgetError("invalid_campaign_budget", "Hard campaign budgets require positive cost and model-call limits.");
  assertHardCampaignBudgetGroup(group);

  return {
    ledgerPath,
    onModelCall(record = {}) {
      const agent = enabledAgents(group).find((item) => item.id === record.agentId) || {};
      const reservation = maximumCallCost(agent);
      const ledger = readLedger(ledgerPath, maxCostUsd, maxModelCalls);
      if (ledger.modelCalls >= maxModelCalls) {
        abort(options.controller, budgetError("model_call_cap_exceeded", `Campaign model-call cap ${maxModelCalls} would be exceeded.`));
        return;
      }
      if (ledger.reservedCostUsd + reservation > maxCostUsd) {
        abort(options.controller, budgetError("cost_cap_exceeded", `Campaign cost cap would be exceeded by reserving $${reservation.toFixed(6)} for the next provider call.`));
        return;
      }
      ledger.modelCalls += 1;
      ledger.reservedCostUsd += reservation;
      ledger.calls.push({
        createdAt: nowIso(),
        sessionId: String(record.sessionId || ""),
        agentId: String(record.agentId || ""),
        phase: String(record.phase || ""),
        reservedCostUsd: reservation
      });
      writeLedger(ledgerPath, ledger);
    }
  };
}

export function readCampaignBudgetLedger(groupPath) {
  const ledgerPath = path.join(path.resolve(groupPath || "."), "shared", "logs", "harness-campaign-budget.json");
  try { return JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch { return undefined; }
}

function maximumCallCost(agent = {}) {
  return estimateCost({
    inputTokens: Number(agent.costGuardMaxInputTokens),
    outputTokens: Number(agent.costGuardMaxOutputTokens),
    pricing: agent.pricing
  }) || 0;
}

function enabledAgents(group) {
  return Array.isArray(group.agents) ? group.agents.filter((agent) => agent.enabled !== false) : [];
}

function readLedger(filePath, maxCostUsd, maxModelCalls) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Number.isFinite(Number(value.modelCalls)) && Number.isFinite(Number(value.reservedCostUsd))) return value;
  } catch {}
  return { schema: "ai-council.harness-campaign-budget.v1", maxCostUsd, maxModelCalls, modelCalls: 0, reservedCostUsd: 0, calls: [] };
}

function writeLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function abort(controller, error) {
  if (!controller?.signal?.aborted) controller?.abort(error);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function integer(value) {
  return Math.floor(positive(value));
}

function budgetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
