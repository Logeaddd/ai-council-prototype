import { ROUND_STATUSES } from "./types.js";
import { normalizeObjectionItems, normalizeResolvedIds } from "./objectionLedger.js";
import { normalizeToolRequests } from "./toolRequests.js";
import { normalizeDeliverableClaims } from "./deliverableVerification.js";
import { normalizeNativeToolCalls } from "./nativeToolProtocol.js";

export function parseRoundModelResult(rawText, nativeToolCalls = []) {
  const nativeRequests = normalizeNativeToolCalls(nativeToolCalls);
  const parsed = parseRoundResponse(rawText);
  if (!nativeRequests.length) return parsed;
  if (parsed.status === "speak") {
    return { ...parsed, tool_requests: [...parsed.tool_requests, ...nativeRequests].slice(0, 8) };
  }
  return {
    status: "speak",
    position: "execution",
    argument: String(rawText || "").trim() || "Using a real tool now.",
    objections: [],
    objection_items: [],
    resolved_ids: [],
    suggested_revision: undefined,
    artifacts: [],
    file_operations: [],
    tool_requests: nativeRequests,
    confidence: undefined,
    memory_candidates: []
  };
}

export function parseRoundResponse(rawText) {
  const parsed = parseJsonLike(rawText);
  if (!parsed || typeof parsed !== "object") return invalidJsonResponse(rawText);

  if (!ROUND_STATUSES.has(parsed.status)) return invalidJsonResponse(rawText);
  if (parsed.status === "skip") {
    return {
      status: "skip",
      reason: String(parsed.reason || "No new objection."),
      resolved_ids: normalizeResolvedIds(parsed.resolved_ids)
    };
  }
  if (parsed.status === "error" || parsed.status === "unavailable") {
    return {
      status: parsed.status,
      reason: String(parsed.reason || "Agent unavailable."),
      retryable: Boolean(parsed.retryable)
    };
  }

  return {
    status: "speak",
    position: optionalString(parsed.position),
    argument: optionalString(parsed.argument) || rawText,
    objections: normalizeStringArray(parsed.objections),
    objection_items: normalizeObjectionItems(parsed.objection_items),
    resolved_ids: normalizeResolvedIds(parsed.resolved_ids),
    suggested_revision: optionalString(parsed.suggested_revision),
    artifacts: normalizeArtifacts(parsed.artifacts),
    file_operations: normalizeFileOperations(parsed.file_operations),
    tool_requests: normalizeToolRequests(parsed.tool_requests),
    confidence: normalizeConfidence(parsed.confidence),
    memory_candidates: normalizeStringArray(parsed.memory_candidates)
  };
}

export function parseFinalDecision(rawText, fallback) {
  const parsed = parseJsonLike(rawText);
  if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
    return {
      answer: normalizeFinalAnswer(parsed.answer, fallback.answer),
      consensus_score: numberOr(parsed.consensus_score, fallback.consensus_score),
      supporting_agents: normalizeStringArray(parsed.supporting_agents),
      dissenting_agents: normalizeStringArray(parsed.dissenting_agents),
      minority_report: optionalString(parsed.minority_report) || fallback.minority_report,
      risks: normalizeStringArray(parsed.risks),
      next_actions: normalizeStringArray(parsed.next_actions),
      final_state: optionalString(parsed.final_state) || fallback.final_state,
      blocking_issues: normalizeIssueArray(parsed.blocking_issues),
      unresolved_risks: normalizeIssueArray(parsed.unresolved_risks),
      selected_file_operation_ids: Array.isArray(parsed.selected_file_operation_ids)
        ? normalizeStringArray(parsed.selected_file_operation_ids)
        : undefined,
      deliverables: Array.isArray(parsed.deliverables)
        ? normalizeDeliverableClaims(parsed.deliverables)
        : undefined,
      memory_candidates: normalizeStringArray(parsed.memory_candidates)
    };
  }
  return {
    ...fallback,
    answer: rawText.trim() || fallback.answer
  };
}

function parseJsonLike(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {}
  }

  return null;
}

function invalidJsonResponse(rawText) {
  const preview = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  return {
    status: "unavailable",
    reason: preview
      ? `invalid_json_response: ${preview}`
      : "invalid_json_response",
    retryable: true
  };
}

function normalizeFinalAnswer(value, fallback) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "skip") return fallback;
  return text;
}

function optionalString(value) {
  return typeof value === "string" ? value : undefined;
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      type: optionalString(item.type) || "text",
      title: optionalString(item.title),
      content: optionalString(item.content) || ""
    }))
    .filter((item) => item.content.trim())
    .slice(0, 10);
}

function normalizeFileOperations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item }))
    .slice(0, 20);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function normalizeIssueArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: optionalString(item.id) || "",
      issue: optionalString(item.issue) || "",
      severity: optionalString(item.severity) || "minor",
      blocks_final: Boolean(item.blocks_final),
      in_scope: item.in_scope !== false,
      why: optionalString(item.why) || "",
      suggested_fix: optionalString(item.suggested_fix) || "",
      source_agent_id: optionalString(item.source_agent_id) || "",
      source_agent_name: optionalString(item.source_agent_name) || "",
      status: optionalString(item.status) || "open"
    }))
    .filter((item) => item.issue);
}

function normalizeConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function numberOr(value, fallback) {
  return typeof value === "number" && !Number.isNaN(value) ? value : fallback;
}
