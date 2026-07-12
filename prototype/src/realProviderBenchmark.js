import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runCouncil } from "./discussionEngine.js";
import { estimateMessagesTokens, estimateTokens } from "./tokenLimits.js";
import { estimateCost } from "./usageStats.js";
import { nowIso } from "./types.js";

export async function runRealProviderBenchmark(options = {}) {
  const group = structuredClone(options.group || {});
  const task = normalizeTask(options.task);
  const maxCostUsd = positiveNumber(options.maxCostUsd, "maxCostUsd");
  const maxModelCalls = positiveInteger(options.maxModelCalls, "maxModelCalls", 1, 200);
  assertRealPricedGroup(group);
  const workspaceTemplate = existingDirectory(options.workspaceTemplate, "workspaceTemplate");
  const outputRoot = path.resolve(options.outputDir || path.join(process.cwd(), "eval", "real-provider"));
  fs.mkdirSync(outputRoot, { recursive: true });
  const runDir = path.join(outputRoot, `${safeId(task.id)}-${Date.now()}`);
  const workspacePath = path.join(runDir, "workspace");
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(workspaceTemplate, workspacePath, { recursive: true, errorOnExist: false, force: true });
  if (!fs.existsSync(path.join(workspacePath, "group.json"))) {
    throw benchmarkError("missing_workspace_group", "The isolated workspace template must contain group.json.");
  }

  group.settings = { ...(group.settings || {}), maxModelCalls };
  const controller = new AbortController();
  const records = [];
  let capReason = "";
  const startedAt = nowIso();
  const started = performance.now();
  let result;
  let runError;

  try {
    result = await runCouncil(task.prompt, group, runDir, {
      groupPath: workspacePath,
      signal: controller.signal,
      onModelCall(record) {
        const agent = group.agents.find((item) => item.id === record.agentId);
        const spent = records.reduce((sum, item) => sum + recordedCallCost(item, group), 0);
        const projected = projectedCallCost(record, agent);
        if (records.length >= maxModelCalls) {
          capReason = "model_call_cap_exceeded";
          controller.abort(benchmarkError(capReason, `Model call cap ${maxModelCalls} would be exceeded.`));
          return;
        }
        if (spent + projected > maxCostUsd) {
          capReason = "cost_cap_exceeded";
          controller.abort(benchmarkError(capReason, `Projected cost ${formatUsd(spent + projected)} exceeds cap ${formatUsd(maxCostUsd)}.`));
          return;
        }
        records.push(record);
      }
    });
  } catch (error) {
    runError = error;
  }

  const session = result?.session;
  const totalCostUsd = records.reduce((sum, item) => sum + recordedCallCost(item, group), 0);
  const report = {
    schema: "ai-council.real-provider-benchmark.v1",
    task,
    startedAt,
    completedAt: nowIso(),
    elapsedMs: Math.round(performance.now() - started),
    status: capReason || (runError ? "failed" : benchmarkPassed(session) ? "passed" : "failed"),
    error: runError ? String(runError.message || runError).slice(0, 1000) : "",
    caps: { maxCostUsd, maxModelCalls },
    accounting: {
      modelCalls: records.length,
      inputTokens: records.reduce((sum, item) => sum + callTokens(item).input, 0),
      outputTokens: records.reduce((sum, item) => sum + callTokens(item).output, 0),
      tokenSource: records.every((item) => item.usage) ? "provider_usage" : records.some((item) => item.usage) ? "mixed" : "estimated",
      costUsd: totalCostUsd,
      costSource: records.every((item) => item.usage) ? "provider_usage_with_configured_pricing" : "estimated_with_configured_pricing"
    },
    execution: {
      sessionId: session?.id || "",
      finalState: session?.finalDecision?.final_state || "",
      executionPhase: session?.executionState?.phase || "",
      guardStopReason: session?.guardStopReason || "",
      toolRequests: session?.toolRequests?.length || 0,
      toolResults: session?.toolExecutionResults?.length || 0,
      fileResults: session?.fileOperationExecutionResults?.length || 0,
      workspaceMutations: countWorkspaceMutations(session),
      artifactVerification: session?.finalDecision?.requested_artifact_verification || null
    },
    calls: records.map((record) => summarizeCall(record, group)),
    workspacePath
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  return { runDir, workspacePath, report, result };
}

function normalizeTask(value = {}) {
  const prompt = String(value.prompt || "").trim();
  if (!prompt) throw benchmarkError("missing_task_prompt", "Real benchmark task requires a prompt.");
  return { id: safeId(value.id || "task"), title: String(value.title || value.id || "Benchmark task"), prompt };
}

function assertRealPricedGroup(group) {
  const enabled = Array.isArray(group.agents) ? group.agents.filter((agent) => agent.enabled !== false) : [];
  if (!enabled.length) throw benchmarkError("missing_agents", "Real benchmark requires enabled agents.");
  for (const agent of enabled) {
    if (agent.provider === "mock") throw benchmarkError("mock_provider_denied", "Real benchmark cannot use mock providers.");
    if (!price(agent.pricing?.inputPerMillion ?? agent.pricing?.input) || !price(agent.pricing?.outputPerMillion ?? agent.pricing?.output)) {
      throw benchmarkError("missing_pricing", `Agent ${agent.id || agent.name} needs positive input and output pricing for a hard cost cap.`);
    }
  }
}

function projectedCallCost(record, agent = {}) {
  return estimateCost({
    inputTokens: estimateMessagesTokens(record.inputMessages || []),
    outputTokens: Number(agent.maxTokens ?? agent.max_tokens ?? 4096),
    pricing: agent.pricing
  }) || 0;
}

function recordedCallCost(record, group) {
  const agent = group.agents.find((item) => item.id === record.agentId) || {};
  const tokens = callTokens(record);
  return estimateCost({ inputTokens: tokens.input, outputTokens: tokens.output, pricing: agent.pricing }) || 0;
}

function callTokens(record = {}) {
  return {
    input: Number(record.usage?.input_tokens ?? estimateMessagesTokens(record.inputMessages || [])),
    output: Number(record.usage?.output_tokens ?? estimateTokens(record.rawText || ""))
  };
}

function summarizeCall(record, group) {
  const agent = group.agents.find((item) => item.id === record.agentId) || {};
  const tokens = callTokens(record);
  return {
    phase: record.phase || "",
    round: record.round,
    agentId: record.agentId || "",
    provider: record.provider || "",
    model: record.model || "",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    tokenSource: record.usage ? "provider_usage" : "estimated",
    costUsd: estimateCost({ inputTokens: tokens.input, outputTokens: tokens.output, pricing: agent.pricing }) || 0,
    error: record.error || "",
    outputBytes: Buffer.byteLength(record.rawText || "", "utf8")
  };
}

function benchmarkPassed(session) {
  if (!session || session.guardStopReason) return false;
  if (session.executionState?.active && session.executionState.phase !== "complete") return false;
  if (session.finalDecision?.final_state === "needs_revision") return false;
  const artifact = session.finalDecision?.requested_artifact_verification;
  return !artifact || artifact.status === "not_requested" || artifact.status === "verified";
}

function countWorkspaceMutations(session = {}) {
  return [...(session.toolExecutionResults || []), ...(session.fileOperationExecutionResults || [])]
    .reduce((sum, item) => sum + Number(item.result?.workspaceChanges?.totalChanges || item.workspaceChanges?.totalChanges || 0), 0);
}

function existingDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!value || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw benchmarkError(`missing_${label}`, `${label} must be an existing directory.`);
  }
  return resolved;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw benchmarkError(`invalid_${label}`, `${label} must be a positive number.`);
  return number;
}

function positiveInteger(value, label, min, max) {
  const number = Math.floor(positiveNumber(value, label));
  if (number < min || number > max) throw benchmarkError(`invalid_${label}`, `${label} must be between ${min} and ${max}.`);
  return number;
}

function price(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function safeId(value) {
  return String(value || "task").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "task";
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function benchmarkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
