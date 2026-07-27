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
    return { ...parsed, tool_requests: [...parsed.tool_requests, ...nativeRequests] };
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
    task_delegations: [],
    delegation_handoff: undefined,
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
      resolved_ids: normalizeResolvedIds(parsed.resolved_ids),
      task_contract: normalizeTaskContract(parsed.task_contract),
      memory_candidates: normalizeStringArray(parsed.memory_candidates)
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
    task_contract: normalizeTaskContract(parsed.task_contract),
    task_delegations: normalizeTaskDelegations(parsed.task_delegations ?? parsed.delegations),
    delegation_handoff: normalizeDelegationHandoff(parsed.delegation_handoff ?? parsed.handoff),
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

export function hasValidFinalDecision(rawText) {
  const parsed = parseJsonLike(rawText);
  return Boolean(
    parsed
    && typeof parsed === "object"
    && typeof parsed.answer === "string"
    && parsed.answer.trim()
    && parsed.answer.trim().toLowerCase() !== "skip"
  );
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

function normalizeTaskContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mode = String(value.mode || "").trim().toLowerCase();
  if (mode !== "delivery" && mode !== "discussion") return undefined;
  return {
    mode,
    objective: optionalString(value.objective) || "",
    requires_workspace: Boolean(value.requires_workspace ?? value.requiresWorkspace),
    requires_verification: Boolean(value.requires_verification ?? value.requiresVerification),
    deliverables: normalizeStringArray(value.deliverables).slice(0, 12),
    completion_criteria: normalizeStringArray(value.completion_criteria ?? value.completionCriteria).slice(0, 12),
    next_action: optionalString(value.next_action ?? value.nextAction) || "",
    collaboration: normalizeCollaborationRequirement(value.collaboration, value)
  };
}

function normalizeCollaborationRequirement(value, contract = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowedTypes = new Set(["research", "implementation", "unblocker"]);
  const required = Boolean(source.required ?? contract.requires_collaboration ?? contract.requiresCollaboration);
  const minimum = Number.parseInt(String(source.minimum_delegations ?? source.minimumDelegations ?? 1), 10);
  const types = normalizeStringArray(source.types ?? source.delegation_types ?? source.delegationTypes)
    .map((item) => item.toLowerCase())
    .filter((item) => allowedTypes.has(item));
  return {
    required,
    before_first_mutation: required && source.before_first_mutation !== false && source.beforeFirstMutation !== false,
    minimum_delegations: required ? Math.max(1, Math.min(8, Number.isFinite(minimum) ? minimum : 1)) : 0,
    types: [...new Set(types)],
    reason: optionalString(source.reason ?? contract.collaboration_reason ?? contract.collaborationReason) || ""
  };
}

function normalizeTaskDelegations(value) {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set(["research", "implementation", "unblocker"]);
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const type = String(item.type || "").trim().toLowerCase();
      const assigneeId = optionalString(item.assignee_id ?? item.assigneeId);
      const task = optionalString(item.task ?? item.question);
      const expectedEvidence = normalizeStringArray(item.expected_evidence ?? item.expectedEvidence).slice(0, 8);
      const allowedTools = normalizeStringArray(item.allowed_tools ?? item.allowedTools)
        .map((tool) => tool.toLowerCase().replace(/-/g, "_"))
        .slice(0, 24);
      const allowedPaths = normalizeStringArray(item.allowed_paths ?? item.allowedPaths).slice(0, 16);
      const allowWorkspaceMutation = Boolean(item.allow_workspace_mutation ?? item.allowWorkspaceMutation);
      if (!allowedTypes.has(type) || !assigneeId || !task || !expectedEvidence.length) return undefined;
      if (allowWorkspaceMutation && !allowedPaths.length) return undefined;
      return {
        type,
        assignee_id: assigneeId,
        task,
        expected_evidence: expectedEvidence,
        allowed_tools: allowedTools,
        allowed_paths: allowedPaths,
        allow_workspace_mutation: allowWorkspaceMutation
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeDelegationHandoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const delegationId = optionalString(value.delegation_id ?? value.delegationId);
  const summary = optionalString(value.summary);
  const evidence = normalizeDelegationEvidence(value.evidence ?? value.handoff_evidence);
  if (!delegationId || !summary || !evidence.length) return undefined;
  return { delegation_id: delegationId, summary, evidence };
}

function normalizeDelegationEvidence(value) {
  const entries = [];
  collectDelegationEvidence(value, "", entries, 0);
  return entries
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function collectDelegationEvidence(value, label, entries, depth) {
  if (entries.length >= 24 || depth > 4 || value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const detail = String(value).trim();
    if (detail) entries.push(label ? `${label}: ${detail}` : detail);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const itemLabel = label ? `${label}[${index}]` : (item && typeof item === "object" ? `[${index}]` : "");
      collectDelegationEvidence(item, itemLabel, entries, depth + 1);
      if (entries.length >= 24) break;
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      const nextLabel = label ? `${label}.${key}` : key;
      collectDelegationEvidence(item, nextLabel, entries, depth + 1);
      if (entries.length >= 24) break;
    }
  }
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
