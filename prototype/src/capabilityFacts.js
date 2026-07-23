import fs from "node:fs";
import path from "node:path";
import { writeTextFileAtomically } from "./atomicFile.js";
import { nowIso } from "./types.js";

export const CAPABILITY_FACTS_SCHEMA = "ai-council.capability-facts.v1";

const CORE_CAPABILITY_BY_TOOL = new Map([
  ["web_search", "web-search"],
  ["fetch_url", "fetch-url"],
  ["api_request", "api-request"],
  ["list_directory", "workspace-files"],
  ["read_file", "workspace-files"],
  ["search_files", "workspace-files"],
  ["grep_content", "workspace-files"],
  ["workspace_edit", "workspace-files"],
  ["extract_archive", "extract-archive"],
  ["create_archive", "create-archive"],
  ["execute_command", "execute-command"],
  ["process_control", "background-processes"],
  ["run_code", "run-code"],
  ["install_package", "install-package"],
  ["provision_tool", "provision-tool"],
  ["run_tests", "run-tests"],
  ["git_operation", "git-operation"],
  ["browser_control", "browser-control"],
  ["database_query", "database-query"],
  ["skill_read", "skill-packs"],
  ["skill_list", "skill-packs"],
  ["skill_search", "skill-packs"],
  ["skill_install", "skill-packs"],
  ["skill_enable", "skill-packs"],
  ["skill_disable", "skill-packs"],
  ["skill_remove", "skill-packs"],
  ["mcp_search_npm", "mcp-marketplace"],
  ["mcp_install_npm", "mcp-marketplace"],
  ["mcp_uninstall", "mcp-marketplace"],
  ["mcp_list_tools", "mcp-web-tools"],
  ["mcp_call", "mcp-web-tools"],
  ["mcp_list_resources", "mcp-web-tools"],
  ["mcp_read_resource", "mcp-web-tools"],
  ["mcp_list_prompts", "mcp-web-tools"],
  ["mcp_get_prompt", "mcp-web-tools"]
]);

const ASSET_TOOLS = new Set(["skill_install", "skill_enable", "skill_disable", "skill_remove", "skill_read", "mcp_install_npm", "mcp_uninstall", "mcp_list_tools", "mcp_call", "install_package", "provision_tool", "process_control"]);
const NON_OPERATIONAL_FAILURE_CODES = new Set(["permission_denied", "capability_disabled", "skill_not_enabled", "skill_not_found", "missing_workspace", "invalid_tool"]);

export function readCapabilityFacts(groupPath) {
  if (!groupPath) return emptyFacts();
  const filePath = capabilityFactsPath(groupPath);
  if (!fs.existsSync(filePath)) return emptyFacts();
  try {
    return normalizeFacts(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyFacts();
  }
}

export function listCapabilityFacts(groupPath) {
  return readCapabilityFacts(groupPath).facts;
}

export function recordCapabilityToolResults(options = {}) {
  if (!options.groupPath) return emptyFacts();
  const current = readCapabilityFacts(options.groupPath);
  const acceptedById = new Map((Array.isArray(options.accepted) ? options.accepted : []).map((item) => [String(item?.id || ""), item]));
  const next = new Map(current.facts.map((item) => [item.id, item]));
  for (const result of [...(Array.isArray(options.results) ? options.results : []), ...(Array.isArray(options.rejected) ? options.rejected : [])]) {
    const request = acceptedById.get(String(result?.id || "")) || result;
    for (const observation of observationsFor(request, result, options)) {
      const previous = next.get(observation.id);
      next.set(observation.id, mergeFact(previous, observation));
    }
  }
  const facts = normalizeFacts({ ...current, updatedAt: nowIso(), facts: [...next.values()] });
  writeFacts(options.groupPath, facts);
  return facts;
}

export function mergeCapabilityFacts(capabilities = [], facts = []) {
  const byCoreId = new Map((Array.isArray(facts) ? facts : []).filter((item) => item.scope === "core").map((item) => [item.capabilityId, item]));
  return (Array.isArray(capabilities) ? capabilities : []).map((capability) => {
    const fact = byCoreId.get(capability.id);
    if (!fact) return capability;
    const operational = fact.status === "ready";
    const degraded = fact.status === "degraded";
    const health = {
      ...(capability.health || {}),
      externalVerified: Boolean(capability.health?.externalVerified || operational && isExternalCapability(capability.id)),
      checkedAt: fact.lastObservedAt || capability.health?.checkedAt,
      detail: lifecycleDetail(capability.health?.detail, fact)
    };
    return {
      ...capability,
      status: degraded ? "degraded" : operational ? "ready" : capability.status,
      health,
      lifecycle: publicFact(fact)
    };
  });
}

export function capabilityFactsPath(groupPath) {
  return path.join(path.resolve(groupPath), "shared", "capabilities", "facts.json");
}

function observationsFor(request = {}, result = {}, options = {}) {
  const tool = String(result?.tool || request?.tool || "").trim();
  const coreId = CORE_CAPABILITY_BY_TOOL.get(tool);
  if (!coreId) return [];
  const success = String(result?.status || "") === "completed" && result?.result?.ok !== false;
  const code = String(result?.code || result?.result?.code || "");
  const coreStatus = success ? "ready" : NON_OPERATIONAL_FAILURE_CODES.has(code) ? "observed" : "degraded";
  const common = {
    tool,
    source: sourceFor(result),
    agentId: String(options.agent?.id || result?.source_agent_id || request?.source_agent_id || ""),
    taskRunId: String(options.taskRunId || options.taskRun?.id || ""),
    requestId: String(result?.id || request?.id || ""),
    lastError: success ? "" : String(result?.error || result?.result?.error || code || "tool_failed"),
    status: coreStatus
  };
  const observations = [{ id: `core:${coreId}`, capabilityId: coreId, scope: "core", ...common }];
  if (ASSET_TOOLS.has(tool)) {
    const asset = assetFor(tool, request, result);
    if (asset) observations.push({
      id: `${asset.kind}:${asset.id}`,
      capabilityId: coreId,
      scope: "asset",
      assetKind: asset.kind,
      assetId: asset.id,
      status: assetStatus(tool, success, result),
      ...common
    });
  }
  return observations;
}

function assetFor(tool, request = {}, result = {}) {
  const payload = result?.result || {};
  if (tool.startsWith("skill_")) {
    const id = String(payload.skill?.id || payload.id || request.skillId || "").trim();
    return id ? { kind: "skill", id } : null;
  }
  if (tool.startsWith("mcp_")) {
    const id = String(payload.id || payload.serverId || request.serverId || request.catalogId || request.packageSpec || "").trim();
    return id ? { kind: "mcp", id } : null;
  }
  if (tool === "install_package") {
    const id = [payload.manager || request.manager, payload.packageName || request.packageName || request.package].filter(Boolean).join(":");
    return id ? { kind: "package", id } : null;
  }
  if (tool === "provision_tool") {
    const id = String(payload.command || payload.name || request.commandName || request.name || request.toolName || "").trim();
    return id ? { kind: "runtime", id } : null;
  }
  if (tool === "process_control") {
    const id = String(payload.processId || payload.process?.processId || request.processId || "").trim();
    return id ? { kind: "process", id } : null;
  }
  return null;
}

function assetStatus(tool, success, result) {
  if (!success) return "degraded";
  if (tool === "skill_install" || tool === "mcp_install_npm") return "installed";
  if (tool === "skill_disable" || tool === "skill_remove" || tool === "mcp_uninstall") return "disabled";
  if (tool === "process_control") return String(result?.result?.process?.status || result?.result?.status || "ready").toLowerCase();
  return "ready";
}

function mergeFact(previous, observation) {
  const observedAt = nowIso();
  const success = observation.status === "ready" || observation.status === "installed" || observation.status === "observed";
  return {
    id: observation.id,
    capabilityId: observation.capabilityId,
    scope: observation.scope,
    assetKind: observation.assetKind || "",
    assetId: observation.assetId || "",
    status: observation.status,
    source: observation.source,
    firstObservedAt: previous?.firstObservedAt || observedAt,
    lastObservedAt: observedAt,
    lastSucceededAt: success ? observedAt : String(previous?.lastSucceededAt || ""),
    lastError: String(observation.lastError || "").slice(0, 1600),
    lastTool: observation.tool,
    lastAgentId: observation.agentId,
    lastTaskRunId: observation.taskRunId,
    lastRequestId: observation.requestId,
    useCount: Math.max(0, Number(previous?.useCount || 0)) + 1
  };
}

function normalizeFacts(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const byId = new Map();
  for (const item of Array.isArray(source.facts) ? source.facts : []) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    byId.set(id, {
      id,
      capabilityId: String(item.capabilityId || ""),
      scope: item.scope === "asset" ? "asset" : "core",
      assetKind: String(item.assetKind || ""),
      assetId: String(item.assetId || ""),
      status: String(item.status || "observed"),
      source: String(item.source || ""),
      firstObservedAt: String(item.firstObservedAt || ""),
      lastObservedAt: String(item.lastObservedAt || ""),
      lastSucceededAt: String(item.lastSucceededAt || ""),
      lastError: String(item.lastError || "").slice(0, 1600),
      lastTool: String(item.lastTool || ""),
      lastAgentId: String(item.lastAgentId || ""),
      lastTaskRunId: String(item.lastTaskRunId || ""),
      lastRequestId: String(item.lastRequestId || ""),
      useCount: Math.max(0, Number(item.useCount || 0))
    });
  }
  return { schema: CAPABILITY_FACTS_SCHEMA, updatedAt: String(source.updatedAt || ""), facts: [...byId.values()].slice(-500) };
}

function emptyFacts() {
  return { schema: CAPABILITY_FACTS_SCHEMA, updatedAt: "", facts: [] };
}

function writeFacts(groupPath, facts) {
  const filePath = capabilityFactsPath(groupPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeTextFileAtomically(filePath, JSON.stringify(normalizeFacts(facts), null, 2));
}

function sourceFor(result = {}) {
  return String(result?.result?.source || result?.source || "local_agent_tool").slice(0, 160);
}

function isExternalCapability(id) {
  return ["web-search", "fetch-url", "api-request", "mcp-web-tools", "mcp-marketplace"].includes(id);
}

function lifecycleDetail(fallback, fact) {
  const detail = `actual ${fact.status} via ${fact.lastTool || "tool"}${fact.lastSucceededAt ? ` at ${fact.lastSucceededAt}` : ""}`;
  return fact.lastError ? `${detail}; last error: ${fact.lastError}` : detail || fallback || "";
}

function publicFact(fact) {
  return {
    status: fact.status,
    source: fact.source,
    lastObservedAt: fact.lastObservedAt,
    lastSucceededAt: fact.lastSucceededAt,
    lastError: fact.lastError,
    lastTool: fact.lastTool,
    useCount: fact.useCount
  };
}
