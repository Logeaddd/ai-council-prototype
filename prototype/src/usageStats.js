import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./tokenLimits.js";
import { nowIso } from "./types.js";

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
