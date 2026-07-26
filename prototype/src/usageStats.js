import fs from "node:fs";
import path from "node:path";
import { estimateMessagesTokens, estimateTokens } from "./tokenLimits.js";
import { nowIso } from "./types.js";

const PROVIDER_USAGE_SCHEMA = "ai-council.provider-usage.v1";

export function appendSessionUsage(groupPath, session, group = undefined) {
  if (!groupPath || !session) return undefined;
  const root = path.resolve(groupPath);
  const usage = summarizeSessionUsage(session);
  const record = {
    sessionId: session.id,
    createdAt: nowIso(),
    groupId: session.groupId,
    totals: usage.totals,
    members: usage.members
  };

  appendJsonl(groupUsagePath(root), record);
  for (const member of usage.members) {
    const seat = findSeat(group, member);
    const filePath = memberUsagePath(root, seat);
    if (filePath) appendJsonl(filePath, {
      sessionId: session.id,
      createdAt: record.createdAt,
      ...member
    });
  }
  return record;
}

export function readGroupUsage(groupPath) {
  return readJsonlIfExists(groupUsagePath(path.resolve(groupPath)));
}

export function readMemberUsage(groupPath, seat) {
  const filePath = memberUsagePath(path.resolve(groupPath), seat);
  return filePath ? readJsonlIfExists(filePath) : [];
}

export function readUsageSnapshot(groupPath, group = undefined) {
  const groupRecords = readGroupUsage(groupPath);
  const members = (group?.seats || []).map((seat) => {
    const records = readMemberUsage(groupPath, seat);
    return {
      seatId: seat.seatId,
      displayName: seat.displayName,
      privateFolder: seat.privateFolder,
      totals: sumMemberRecords(records),
      recent: records.slice(-10)
    };
  });
  return {
    groupPath: path.resolve(groupPath),
    totals: sumGroupRecords(groupRecords),
    recent: groupRecords.slice(-10),
    members
  };
}

// Provider reports are deliberately separate from the human-facing transcript:
// the record contains counts and model identity, never prompt/output text or
// credentials. It is both a durable audit trail and the input to estimation
// calibration for later calls to the same provider/model.
export function appendProviderUsageSample(groupPath, record = {}, usage = undefined) {
  if (!groupPath) return undefined;
  const actual = normalizeProviderUsage(usage);
  if (!actual) return undefined;

  const estimatedInputTokens = positiveNumber(record.contextReceipt?.call?.estimatedInputTokens)
    ?? estimateMessagesTokens(record.inputMessages || [], {
      calibrationMultiplier: record.contextReceipt?.inputEstimateMultiplier
    });
  const estimatedOutputTokens = estimateTokens(record.rawText || "", {
    calibrationMultiplier: record.contextReceipt?.outputEstimateMultiplier
  });
  const payload = {
    schema: PROVIDER_USAGE_SCHEMA,
    createdAt: nowIso(),
    sessionId: String(record.sessionId || ""),
    phase: String(record.phase || ""),
    round: finiteInteger(record.round),
    toolIteration: finiteInteger(record.toolIteration),
    agentId: String(record.agentId || ""),
    provider: String(record.provider || ""),
    model: String(record.model || ""),
    estimated: {
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens
    },
    actual,
    multiplier: {
      input: observedMultiplier(actual.input_tokens, estimatedInputTokens),
      output: observedMultiplier(actual.output_tokens, estimatedOutputTokens)
    }
  };
  appendJsonl(providerUsagePath(path.resolve(groupPath)), payload);
  return payload;
}

export function readProviderUsageCalibration(groupPath, identity = {}) {
  if (!groupPath) return unavailableCalibration(identity);
  const provider = String(identity.provider || "");
  const model = String(identity.model || "");
  const records = readJsonlIfExists(providerUsagePath(path.resolve(groupPath)))
    .filter((record) => record?.schema === PROVIDER_USAGE_SCHEMA)
    .filter((record) => record.provider === provider && record.model === model);
  const inputSamples = records
    .map((record) => positiveNumber(record?.multiplier?.input))
    .filter((value) => value !== undefined);
  const outputSamples = records
    .map((record) => positiveNumber(record?.multiplier?.output))
    .filter((value) => value !== undefined);
  if (!inputSamples.length) return unavailableCalibration({ provider, model });

  return {
    status: "observed",
    provider,
    model,
    sampleCount: inputSamples.length,
    freshestAt: records.map((record) => String(record.createdAt || "")).sort().at(-1) || "",
    // The maximum observed ratio is intentionally conservative. It does not
    // claim a context-window size; it only compensates for under-estimation.
    inputEstimateMultiplier: Math.max(1, ...inputSamples),
    outputEstimateMultiplier: outputSamples.length ? Math.max(1, ...outputSamples) : 1
  };
}

export function summarizeSessionUsage(session) {
  const byAgent = new Map();
  for (const message of session.messages || []) {
    const current = byAgent.get(message.agentId) || emptyMemberUsage(message);
    const status = message.response?.status || "unknown";
    current.calls += 1;
    current.estimatedInputTokens += Number(message.contextStatus?.totalTokens || 0);
    current.estimatedOutputTokens += estimateResponseTokens(message);
    current.lastStatus = status;
    if (status === "unavailable" || status === "error" || message.error) current.unavailableCount += 1;
    if (message.contextStatus?.coreOverflow) current.coreOverflowCount += 1;
    byAgent.set(message.agentId, current);
  }

  const members = [...byAgent.values()];
  const totals = members.reduce((sum, member) => ({
    calls: sum.calls + member.calls,
    estimatedInputTokens: sum.estimatedInputTokens + member.estimatedInputTokens,
    estimatedOutputTokens: sum.estimatedOutputTokens + member.estimatedOutputTokens,
    unavailableCount: sum.unavailableCount + member.unavailableCount,
    coreOverflowCount: sum.coreOverflowCount + member.coreOverflowCount
  }), {
    calls: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unavailableCount: 0,
    coreOverflowCount: 0
  });

  return { totals, members };
}

export function estimateCost({ inputTokens = 0, outputTokens = 0, pricing = {} } = {}) {
  const inputPerMillion = positiveNumber(pricing.inputPerMillion ?? pricing.inputPerMTok ?? pricing.input);
  const outputPerMillion = positiveNumber(pricing.outputPerMillion ?? pricing.outputPerMTok ?? pricing.output);
  if (!inputPerMillion && !outputPerMillion) return undefined;
  return (Number(inputTokens || 0) / 1_000_000 * (inputPerMillion || 0))
    + (Number(outputTokens || 0) / 1_000_000 * (outputPerMillion || 0));
}

export function estimateMemberAccruedCost(groupPath, seat, pricing = {}) {
  const records = readMemberUsage(groupPath, seat);
  return records.reduce((sum, record) => {
    return sum + (estimateCost({
      inputTokens: record.estimatedInputTokens,
      outputTokens: record.estimatedOutputTokens,
      pricing
    }) || 0);
  }, 0);
}

function emptyMemberUsage(message) {
  return {
    agentId: message.agentId,
    agentName: message.agentName,
    calls: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unavailableCount: 0,
    coreOverflowCount: 0,
    lastStatus: "unknown"
  };
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeProviderUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = nonNegativeNumber(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = nonNegativeNumber(value.output_tokens ?? value.completion_tokens);
  const totalTokens = nonNegativeNumber(value.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  };
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function finiteInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : undefined;
}

function observedMultiplier(actual, estimated) {
  const actualTokens = positiveNumber(actual);
  const estimatedTokens = positiveNumber(estimated);
  return actualTokens !== undefined && estimatedTokens !== undefined
    ? actualTokens / estimatedTokens
    : undefined;
}

function unavailableCalibration(identity = {}) {
  return {
    status: "unavailable",
    provider: String(identity.provider || ""),
    model: String(identity.model || ""),
    sampleCount: 0,
    freshestAt: "",
    inputEstimateMultiplier: 1,
    outputEstimateMultiplier: 1
  };
}

function estimateResponseTokens(message) {
  const response = message.response || {};
  const text = [
    response.argument,
    response.position,
    response.reason,
    response.suggested_revision,
    ...(response.objections || []),
    ...(response.artifacts || []).map((artifact) => artifact.content)
  ].filter(Boolean).join("\n");
  return estimateTokens(text);
}

function findSeat(group, member) {
  if (!group?.seats) return undefined;
  return group.seats.find((seat) => {
    return seat.seatId === member.agentId
      || seat.displayName === member.agentName
      || seat.currentModel === member.agentName
      || seat.role === member.agentName;
  });
}

function memberUsagePath(root, seat) {
  if (!seat?.privateFolder) return undefined;
  return path.join(root, seat.privateFolder, "private_memory", "usage.jsonl");
}

function groupUsagePath(root) {
  return path.join(root, "shared", "usage", "usage.jsonl");
}

function providerUsagePath(root) {
  return path.join(root, "shared", "usage", "provider-usage.jsonl");
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function readJsonlIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sumGroupRecords(records) {
  return records.reduce((sum, record) => addTotals(sum, record.totals || {}), emptyTotals());
}

function sumMemberRecords(records) {
  return records.reduce((sum, record) => addTotals(sum, record), emptyTotals());
}

function addTotals(sum, value) {
  return {
    calls: sum.calls + Number(value.calls || 0),
    estimatedInputTokens: sum.estimatedInputTokens + Number(value.estimatedInputTokens || 0),
    estimatedOutputTokens: sum.estimatedOutputTokens + Number(value.estimatedOutputTokens || 0),
    unavailableCount: sum.unavailableCount + Number(value.unavailableCount || 0),
    coreOverflowCount: sum.coreOverflowCount + Number(value.coreOverflowCount || 0)
  };
}

function emptyTotals() {
  return {
    calls: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    unavailableCount: 0,
    coreOverflowCount: 0
  };
}
