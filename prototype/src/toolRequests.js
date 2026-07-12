import { makeId, nowIso } from "./types.js";
import { fetchPublicUrl, searchWeb } from "./webTools.js";
import { executeFileTool } from "./fileTools.js";
import { extractArchiveTool } from "./archiveTools.js";
import { executeCommandTool } from "./commandTools.js";
import { processControlTool } from "./processTools.js";
import { runCodeTool } from "./codeRunTools.js";
import { installPackageTool } from "./packageTools.js";
import { runTestsTool } from "./testRunTools.js";
import { apiRequestTool } from "./apiTools.js";
import { gitOperationTool } from "./gitTools.js";
import { browserControlTool } from "./browserTools.js";
import { databaseQueryTool } from "./databaseTools.js";
import {
  callConfiguredMcpTool,
  getConfiguredMcpPrompt,
  listConfiguredMcpPrompts,
  listConfiguredMcpResources,
  listConfiguredMcpTools,
  readConfiguredMcpResource
} from "./mcpClient.js";
import { installMcpNpmServer, searchMcpNpmPackages, uninstallManagedMcpServer } from "./mcpInstall.js";
import {
  disableSkillForGroup,
  enableSkillForGroup,
  installBuiltInSkillPack,
  installRemoteSkillPack,
  installSkillMarkdown,
  listEnabledSkillMetadata,
  listSkillPacksForGroup,
  readSkillPackChunk,
  removeSkillPack,
  searchSkillCandidates
} from "./skillPacks.js";
import { loadLiveSessionContext, loadSessionContextArchiveItem, searchLiveSessionContext, searchSessionContextArchive } from "./storage.js";
import { disabledCapabilityForRequest } from "./capabilityPolicy.js";
import fs from "node:fs";
import path from "node:path";
import { hasMaterialWorkspaceChange, isObservationRequest, observationValueForConsumer } from "./observationCache.js";
import { executeWorkspaceEdit } from "./workspaceEditTools.js";

const ALLOWED_TOOLS = new Set([
  "fetch_url",
  "web_search",
  "list_directory",
  "read_file",
  "search_files",
  "grep_content",
  "search_context",
  "load_context",
  "extract_archive",
  "workspace_edit",
  "execute_command",
  "process_control",
  "run_code",
  "install_package",
  "run_tests",
  "api_request",
  "git_operation",
  "browser_control",
  "database_query",
  "mcp_list_tools",
  "mcp_call",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
  "mcp_search_npm",
  "mcp_install_npm",
  "mcp_uninstall",
  "skill_read",
  "skill_list",
  "skill_search",
  "skill_install",
  "skill_enable",
  "skill_disable",
  "skill_remove"
]);
const FILE_TOOLS = new Set(["list_directory", "read_file", "search_files", "grep_content"]);
const CONTEXT_TOOLS = new Set(["search_context", "load_context"]);
const ARCHIVE_TOOLS = new Set(["extract_archive"]);
const WORKSPACE_EDIT_TOOLS = new Set(["workspace_edit"]);
const COMMAND_TOOLS = new Set(["execute_command"]);
const PROCESS_TOOLS = new Set(["process_control"]);
const CODE_TOOLS = new Set(["run_code"]);
const PACKAGE_TOOLS = new Set(["install_package"]);
const TEST_TOOLS = new Set(["run_tests"]);
const API_TOOLS = new Set(["api_request"]);
const GIT_TOOLS = new Set(["git_operation"]);
const BROWSER_TOOLS = new Set(["browser_control"]);
const DATABASE_TOOLS = new Set(["database_query"]);
const MCP_TOOLS = new Set(["mcp_list_tools", "mcp_call", "mcp_list_resources", "mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt", "mcp_search_npm", "mcp_install_npm", "mcp_uninstall"]);
const SKILL_TOOLS = new Set(["skill_read", "skill_list", "skill_search", "skill_install", "skill_enable", "skill_disable", "skill_remove"]);
const FULL_PERMISSION_TOOLS = new Set(["extract_archive", "workspace_edit", "execute_command", "process_control", "run_code", "install_package", "run_tests", "git_operation", "browser_control", "mcp_list_tools", "mcp_call", "mcp_list_resources", "mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt", "mcp_search_npm", "mcp_install_npm", "mcp_uninstall", "skill_list", "skill_search", "skill_install", "skill_enable", "skill_disable", "skill_remove"]);

export function normalizeToolRequests(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item, index) => normalizeToolRequest(item, index))
    .slice(0, 8);
}

export async function executeToolRequests(options = {}) {
  const requests = Array.isArray(options.requests) ? options.requests : [];
  if (!requests.length) return { accepted: [], rejected: [], results: [], events: [] };

  const accepted = [];
  const rejected = [];
  const results = [];
  const events = [];
  const permissionTier = options.permissionTier || "text";

  for (const request of requests) {
    const normalized = normalizeToolRequest(request, request.sourceIndex || 0);
    const base = {
      ...normalized,
      round: options.round,
      source_agent_id: options.agent?.id || "",
      source_agent_name: options.agent?.name || ""
    };

    if (!ALLOWED_TOOLS.has(normalized.tool)) {
      const rejection = reject(base, "invalid_tool", "Unknown tool. Use one of the tool values listed in the software protocol, including skill_read and the skill management tools.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
      appendGitAuditLog(options.groupPath, "rejected", rejection);
      appendBrowserAuditLog(options.groupPath, "rejected", rejection);
      appendDatabaseAuditLog(options.groupPath, "rejected", rejection);
      appendMcpAuditLog(options.groupPath, "rejected", rejection);
      appendProcessAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    if (permissionTier === "text" && !CONTEXT_TOOLS.has(normalized.tool)) {
      const rejection = reject(base, "permission_denied", "Seat has text-only permission and cannot use tools.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
      appendGitAuditLog(options.groupPath, "rejected", rejection);
      appendBrowserAuditLog(options.groupPath, "rejected", rejection);
      appendDatabaseAuditLog(options.groupPath, "rejected", rejection);
      appendMcpAuditLog(options.groupPath, "rejected", rejection);
      appendProcessAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    if (FULL_PERMISSION_TOOLS.has(normalized.tool) && permissionTier !== "full") {
      const rejection = reject(base, "permission_denied", `${normalized.tool} requires full permission.`);
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
      appendGitAuditLog(options.groupPath, "rejected", rejection);
      appendBrowserAuditLog(options.groupPath, "rejected", rejection);
      appendDatabaseAuditLog(options.groupPath, "rejected", rejection);
      appendMcpAuditLog(options.groupPath, "rejected", rejection);
      appendProcessAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    const disabledCapability = disabledCapabilityForRequest(normalized, options.appSettings);
    if (disabledCapability) {
      const rejection = reject(base, "capability_disabled", `${disabledCapability.label} is disabled in global settings.`);
      rejection.capabilityId = disabledCapability.id;
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error, capabilityId: disabledCapability.id }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
      appendGitAuditLog(options.groupPath, "rejected", rejection);
      appendBrowserAuditLog(options.groupPath, "rejected", rejection);
      appendDatabaseAuditLog(options.groupPath, "rejected", rejection);
      appendMcpAuditLog(options.groupPath, "rejected", rejection);
      appendProcessAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    const cachedObservation = options.observationCache?.get(base);
    if (cachedObservation) {
      accepted.push(safeRequestForStorage(base));
      const cachedResult = resultRecord(base, {
        status: "completed",
        result: observationValueForConsumer(base, cachedObservation.value),
        cacheHit: true,
        sourceObservationId: cachedObservation.sourceId,
        sourceObservationAgentId: cachedObservation.sourceAgentId,
        sourceObservationAgentName: cachedObservation.sourceAgentName,
        workspaceRevision: cachedObservation.workspaceRevision,
        observedAt: cachedObservation.observedAt
      });
      results.push(cachedResult);
      events.push(toolEvent("tool_success", base, {
        status: "completed",
        durationMs: 0,
        cacheHit: true,
        sourceObservationId: cachedObservation.sourceId,
        resultSummary: summarizeToolResult(cachedResult)
      }));
      appendToolAuditLog(options.groupPath, "completed", cachedResult);
      continue;
    }
    if (!options.observationCache && isRepeatedObservation(normalized, [...(options.previousResults || []), ...results])) {
      const rejection = reject(base, "repeated_observation_limit", "This exact file or context observation already completed twice without enough new progress. Use the recorded result, inspect a different target, or perform a material action before reading it again.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    if (isRepeatedFailedCommand(normalized, [...(options.previousResults || []), ...results])) {
      const rejection = reject(base, "repeated_failed_command", "This exact command already failed in the current tool loop. Inspect the recorded failure and choose a materially different action instead of repeating it.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    const exhaustedStrategy = exhaustedFailureStrategy(normalized, [...(options.previousResults || []), ...results]);
    if (exhaustedStrategy) {
      const rejection = reject(base, "failed_strategy_budget_exhausted", `The ${exhaustedStrategy} strategy already failed 3 times in the current tool loop. Inspect existing runtimes, files, artifacts, and prior errors before trying that strategy again in a later round.`);
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }

    accepted.push(safeRequestForStorage(base));
    const start = Date.now();
    events.push(toolEvent("tool_start", base, { status: "running" }));
    const result = await executeOne(base, options);
    results.push(result);
    if (result.status === "completed" && isObservationRequest(base)) {
      options.observationCache?.set(base, result.result, result);
    }
    if (hasMaterialWorkspaceChange(result)) {
      options.observationCache?.invalidate(`tool:${base.tool}`);
    }
    const eventType = result.status === "completed" ? "tool_success" : "tool_failure";
    events.push(toolEvent(eventType, base, {
      status: result.status,
      code: result.code,
      error: result.error,
      durationMs: Date.now() - start,
      resultSummary: summarizeToolResult(result)
    }));
    appendToolAuditLog(options.groupPath, "completed", result);
    appendCommandAuditLog(options.groupPath, "completed", result);
    appendCodeRunAuditLog(options.groupPath, "completed", result);
    appendPackageAuditLog(options.groupPath, "completed", result);
    appendTestAuditLog(options.groupPath, "completed", result);
    appendApiAuditLog(options.groupPath, "completed", result);
    appendGitAuditLog(options.groupPath, "completed", result);
    appendBrowserAuditLog(options.groupPath, "completed", result);
    appendDatabaseAuditLog(options.groupPath, "completed", result);
    appendMcpAuditLog(options.groupPath, "completed", result);
    appendProcessAuditLog(options.groupPath, "completed", result);
  }

  return { accepted, rejected, results, events };
}

function isRepeatedObservation(request, previousResults = []) {
  const signature = observationSignature(request);
  if (!signature) return false;
  let matches = 0;
  for (const item of Array.isArray(previousResults) ? previousResults : []) {
    if (item?.status !== "completed") continue;
    if (observationSignature(item) !== signature) continue;
    matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

function observationSignature(request = {}) {
  const tool = String(request.tool || "");
  if (tool === "read_file" || tool === "list_directory") {
    return `${tool}:${normalizeObservationValue(request.path || ".")}`;
  }
  if (tool === "search_files") {
    return `${tool}:${normalizeObservationValue(request.path || request.root || ".")}:${normalizeObservationValue(request.query)}`;
  }
  if (tool === "grep_content") {
    return `${tool}:${normalizeObservationValue(request.path || request.root || ".")}:${normalizeObservationValue(request.pattern || request.query)}`;
  }
  if (tool === "search_context") {
    return `${tool}:${normalizeObservationValue(request.query)}`;
  }
  if (tool === "load_context") {
    return `${tool}:${normalizeObservationValue(request.sessionId)}:${normalizeObservationValue(request.archiveRound)}`;
  }
  return "";
}

function normalizeObservationValue(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
}

function isRepeatedFailedCommand(request, previousResults = []) {
  if (request.tool !== "execute_command") return false;
  const signature = commandSignature(request.command);
  if (!signature) return false;
  return (Array.isArray(previousResults) ? previousResults : []).some((item) => (
    item?.tool === "execute_command"
    && item?.status === "failed"
    && commandSignature(item.command || item.result?.command) === signature
  ));
}

function commandSignature(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function exhaustedFailureStrategy(request, previousResults = []) {
  const family = failureStrategyFamily(request);
  if (!family) return "";
  const failures = (Array.isArray(previousResults) ? previousResults : [])
    .filter((item) => item?.status === "failed" && failureStrategyFamily(item) === family)
    .length;
  return failures >= 3 ? family : "";
}

function failureStrategyFamily(item = {}) {
  if (item.tool === "install_package") return "package installation";
  if (item.tool !== "execute_command") return "";
  const command = String(item.command || item.result?.command || "").toLowerCase();
  if (/curl|wget|invoke-webrequest|start-bitstransfer|https?:\/\//.test(command)) return "download";
  if (/\b(?:npm|pnpm|yarn|pip|cargo|gem|go)\s+(?:install|add|get)\b/.test(command)) return "package installation";
  return "";
}

async function executeOne(request, options) {
  try {
    if (FILE_TOOLS.has(request.tool)) {
      const result = executeFileTool(request, {
        groupPath: options.groupPath,
        importedProjectRoots: options.importedProjectRoots,
        maxReadBytes: options.maxReadBytes,
        maxListEntries: options.maxListEntries,
        maxSearchResults: options.maxSearchResults,
        maxGrepResults: options.maxGrepResults,
        maxScanFiles: options.maxScanFiles
      });
      return resultRecord(request, { status: "completed", result });
    }
    if (WORKSPACE_EDIT_TOOLS.has(request.tool)) {
      const result = executeWorkspaceEdit(request, { groupPath: options.groupPath });
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "fetch_url") {
      const result = await fetchPublicUrl(request.url, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork)
      });
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "search_context") {
      if (!options.groupPath) {
        return resultRecord(request, {
          status: "failed",
          code: "group_context_unavailable",
          error: "Local context search requires a group workspace."
        });
      }
      const query = request.query || request.reason;
      const archiveResults = searchSessionContextArchive(options.groupPath, query, {
        limit: request.count || 5,
        excludeSessionId: options.currentSession?.id
      });
      const liveResults = searchLiveSessionContext(options.currentSession, query, {
        limit: request.count || 5,
        agent: options.agent,
        transcriptVisibility: options.transcriptVisibility
      });
      const results = [...liveResults, ...archiveResults]
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, Math.max(1, Math.min(20, Number(request.count || 5))));
      return resultRecord(request, {
        status: "completed",
        result: {
          ok: true,
          source: liveResults.length ? "group_history_with_live_session" : "local_context_archive",
          query,
          results
        }
      });
    }
    if (request.tool === "load_context") {
      if (!options.groupPath) {
        return resultRecord(request, {
          status: "failed",
          code: "group_context_unavailable",
          error: "Local context load requires a group workspace."
        });
      }
      if (!request.sessionId) {
        return resultRecord(request, {
          status: "failed",
          code: "missing_session_id",
          error: "load_context requires sessionId."
        });
      }
      const result = request.sessionId === options.currentSession?.id
        ? loadLiveSessionContext(options.currentSession, {
          ...request,
          round: request.archiveRound
        }, {
          maxBytes: request.maxBytes || options.maxArchiveLoadBytes,
          agent: options.agent,
          transcriptVisibility: options.transcriptVisibility
        })
        : loadSessionContextArchiveItem(options.groupPath, {
          ...request,
          round: request.archiveRound
        }, {
          maxBytes: request.maxBytes || options.maxArchiveLoadBytes
        });
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "skill_read") {
      if (!options.groupPath) {
        return resultRecord(request, { status: "failed", code: "group_context_unavailable", error: "skill_read requires a group workspace." });
      }
      const skillId = request.skillId;
      const enabled = listEnabledSkillMetadata(options.baseDir, options.groupPath);
      if (!enabled.skills.some((item) => item.id === skillId)) {
        return resultRecord(request, { status: "failed", code: "skill_not_enabled", error: `Skill pack ${skillId || "(missing)"} is not enabled for this group.` });
      }
      const result = readSkillPackChunk(options.baseDir, skillId, { offset: request.offset, maxBytes: request.maxBytes });
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "skill_list") {
      if (!options.groupPath) return resultRecord(request, { status: "failed", code: "group_context_unavailable", error: "skill_list requires a group workspace." });
      return resultRecord(request, { status: "completed", result: { ok: true, source: "local_skill_store", ...listSkillPacksForGroup(options.baseDir, options.groupPath) } });
    }
    if (request.tool === "skill_search") {
      const result = await searchSkillCandidates(request.query || request.reason, { timeoutMs: request.timeoutMs || options.timeoutMs, signal: options.signal });
      return resultRecord(request, { status: result.ok ? "completed" : "failed", code: result.code, error: result.error, result });
    }
    if (request.tool === "skill_install") {
      let result;
      if (request.skillMarkdown) {
        result = installSkillMarkdown(options.baseDir, request.skillMarkdown, { id: request.skillId, overwrite: request.overwrite, source: "agent_direct_markdown" });
      } else if (request.skillUrl) {
        result = await installRemoteSkillPack(options.baseDir, { url: request.skillUrl, skillId: request.skillId, overwrite: request.overwrite, timeoutMs: request.timeoutMs }, { signal: options.signal });
      } else {
        result = await installBuiltInSkillPack(options.baseDir, request.skillId || request.catalogId, { overwrite: request.overwrite, signal: options.signal });
      }
      return resultRecord(request, { status: result.ok ? "completed" : "failed", code: result.code, error: result.error, result });
    }
    if (request.tool === "skill_enable") {
      const result = enableSkillForGroup(options.baseDir, options.groupPath, request.skillId);
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "skill_disable") {
      const result = disableSkillForGroup(options.baseDir, options.groupPath, request.skillId);
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "skill_remove") {
      if (options.groupPath) disableSkillForGroup(options.baseDir, options.groupPath, request.skillId);
      const result = removeSkillPack(options.baseDir, request.skillId);
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "extract_archive") {
      const result = extractArchiveTool(request, {
        groupPath: options.groupPath,
        maxArchiveEntries: options.maxArchiveEntries,
        maxArchiveFileBytes: options.maxArchiveFileBytes,
        maxArchiveTotalBytes: options.maxArchiveTotalBytes
      });
      return resultRecord(request, { status: "completed", result });
    }
    if (request.tool === "execute_command") {
      const result = await executeCommandTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        commandTimeoutMs: options.commandTimeoutMs,
        maxCommandOutputBytes: options.maxCommandOutputBytes,
        maxWorkspaceSnapshotEntries: options.maxWorkspaceSnapshotEntries,
        maxWorkspaceChanges: options.maxWorkspaceChanges,
        managedToolRoots: options.managedToolRoots,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "process_control") {
      const result = await processControlTool(request, { groupPath: options.groupPath });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "run_code") {
      const result = await runCodeTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        codeRunTimeoutMs: options.codeRunTimeoutMs,
        maxCodeOutputBytes: options.maxCodeOutputBytes,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "install_package") {
      const result = await installPackageTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        packageInstallTimeoutMs: options.packageInstallTimeoutMs,
        maxPackageOutputBytes: options.maxPackageOutputBytes,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "run_tests") {
      const result = await runTestsTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        testTimeoutMs: options.testTimeoutMs,
        maxTestOutputBytes: options.maxTestOutputBytes,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "api_request") {
      const result = await apiRequestTool(request, {
        timeoutMs: options.timeoutMs,
        apiRequestTimeoutMs: options.apiRequestTimeoutMs,
        maxApiResponseBytes: options.maxApiResponseBytes,
        allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork),
        allowHttp: Boolean(options.allowHttp),
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "git_operation") {
      const result = await gitOperationTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        gitTimeoutMs: options.gitTimeoutMs,
        maxGitOutputBytes: options.maxGitOutputBytes,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "browser_control") {
      const result = await browserControlTool(request, {
        groupPath: options.groupPath,
        timeoutMs: options.timeoutMs,
        browserTimeoutMs: options.browserTimeoutMs,
        maxBrowserOutputBytes: options.maxBrowserOutputBytes,
        signal: options.signal
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "database_query") {
      const result = await databaseQueryTool(request, {
        groupPath: options.groupPath,
        permissionTier: options.permissionTier || "text",
        maxDatabaseRows: options.maxDatabaseRows
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_list_tools") {
      const result = await listConfiguredMcpTools(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_call") {
      const result = await callConfiguredMcpTool(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_list_resources") {
      const result = await listConfiguredMcpResources(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_read_resource") {
      const result = await readConfiguredMcpResource(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_list_prompts") {
      const result = await listConfiguredMcpPrompts(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_get_prompt") {
      const result = await getConfiguredMcpPrompt(options.baseDir || options.appBaseDir || process.cwd(), request, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        mcpTimeoutMs: options.mcpTimeoutMs,
        maxMcpOutputBytes: options.maxMcpOutputBytes
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_search_npm") {
      const result = await searchMcpNpmPackages(request.query || request.packageSpec || request.reason, {
        count: request.count,
        timeoutMs: request.timeoutMs || options.timeoutMs
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_install_npm") {
      const result = await installMcpNpmServer(options.baseDir || options.appBaseDir || process.cwd(), {
        ...request,
        id: request.serverId || request.catalogId || request.packageSpec,
        args: request.mcpArgs?.length ? request.mcpArgs : undefined
      }, {
        timeoutMs: request.timeoutMs || options.timeoutMs,
        groupPath: options.groupPath
      });
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    if (request.tool === "mcp_uninstall") {
      const result = uninstallManagedMcpServer(options.baseDir || options.appBaseDir || process.cwd(), request);
      return resultRecord(request, {
        status: result.ok ? "completed" : "failed",
        code: result.code,
        error: result.error,
        result
      });
    }
    const result = await searchWeb(request.query, {
      timeoutMs: options.timeoutMs,
      count: request.count,
      signal: options.signal,
      env: options.env,
      appSettings: options.appSettings,
      searchApiKey: options.searchApiKey
    });
    return resultRecord(request, {
      status: result.ok ? "completed" : "failed",
      result
    });
  } catch (error) {
    return resultRecord(request, {
      status: "failed",
      code: error.code || "tool_failed",
      error: error.message || "tool request failed"
    });
  }
}

function normalizeToolRequest(item, index) {
  const tool = String(item.tool || item.name || item.type || "").trim().toLowerCase().replace(/-/g, "_");
  return {
    id: String(item.id || makeId("tool")).trim(),
    tool,
    query: stringField(item.query),
    url: stringField(item.url),
    path: stringField(item.path),
    destination: stringField(item.destination || item.destinationPath || item.outputPath || item.dest),
    command: stringField(item.command || item.cmd || item.shellCommand || item.shell_command),
    code: contentField(item.code ?? item.content ?? item.source),
    language: stringField(item.language || item.lang),
    packageName: stringField(item.packageName || item.package || item.package_name || item.name),
    manager: stringField(item.manager || item.packageManager || item.package_manager || item.ecosystem),
    runner: stringField(item.runner || item.framework || item.testRunner || item.test_runner),
    cwd: stringField(item.cwd || item.workingDirectory || item.working_directory),
    shell: stringField(item.shell),
    pattern: stringField(item.pattern),
    root: stringField(item.root),
    sessionId: stringField(item.sessionId || item.session_id),
    method: stringField(item.method),
    action: stringField(item.action || item.operation),
    oldText: contentField(item.oldText ?? item.old_text ?? item.before),
    newText: typeof (item.newText ?? item.new_text ?? item.after) === "string" ? (item.newText ?? item.new_text ?? item.after) : "",
    replaceAll: Boolean(item.replaceAll || item.replace_all),
    processId: stringField(item.processId || item.process_id || item.backgroundProcessId || item.background_process_id),
    stream: stringField(item.stream),
    offset: normalizeOptionalNumber(item.offset),
    branch: stringField(item.branch),
    remote: stringField(item.remote),
    message: stringField(item.message || item.commitMessage || item.commit_message),
    paths: arrayOfStrings(item.paths || item.files),
    selector: stringField(item.selector),
    inputText: stringField(item.inputText || item.input_text || item.text || item.value),
    expression: stringField(item.expression || item.script || item.js),
    steps: arrayOfObjects(item.steps),
    viewport: objectField(item.viewport),
    waitMs: normalizeOptionalNumber(item.waitMs || item.wait_ms),
    databasePath: stringField(item.databasePath || item.database_path || item.dbPath || item.db_path),
    sql: stringField(item.sql),
    params: arrayOfPrimitive(item.params),
    serverId: stringField(item.serverId || item.server_id || item.mcpServerId || item.mcp_server_id),
    catalogId: stringField(item.catalogId || item.catalog_id),
    packageSpec: stringField(item.packageSpec || item.package_spec || item.packageName || item.package_name),
    binName: stringField(item.binName || item.bin_name),
    mcpArgs: arrayOfStrings(item.args || item.mcpArgs || item.mcp_args),
    mcpToolName: stringField(item.mcpToolName || item.mcp_tool_name || item.mcpTool || item.mcp_tool || item.toolName || item.tool_name),
    toolArguments: objectField(item.arguments || item.toolArguments || item.tool_arguments || item.input),
    resourceUri: stringField(item.uri || item.resourceUri || item.resource_uri),
    promptName: stringField(item.promptName || item.prompt_name || item.prompt || item.name),
    promptArguments: objectField(item.promptArguments || item.prompt_arguments || item.arguments || item.input),
    skillId: stringField(item.skillId || item.skill_id || item.catalogId || item.catalog_id),
    skillUrl: stringField(item.skillUrl || item.skill_url || item.url),
    skillMarkdown: stringField(item.skillMarkdown || item.skill_markdown || item.markdown),
    mode: stringField(item.mode),
    maxRows: normalizeOptionalNumber(item.maxRows || item.max_rows),
    headers: objectField(item.headers),
    body: item.body,
    json: item.json,
    archiveRound: item.round === undefined ? undefined : Number(item.round),
    overwrite: Boolean(item.overwrite),
    background: Boolean(item.background),
    force: Boolean(item.force),
    screenshot: Boolean(item.screenshot),
    create: Boolean(item.create),
    reason: stringField(item.reason),
    count: normalizeCount(item.count, tool),
    maxBytes: normalizeMaxBytes(item.maxBytes || item.max_bytes),
    timeoutMs: normalizeTimeoutMs(item.timeoutMs || item.timeout_ms),
    maxOutputBytes: normalizeMaxBytes(item.maxOutputBytes || item.max_output_bytes),
    sourceIndex: index
  };
}

function reject(request, code, reason) {
  return {
    id: request.id,
    tool: request.tool,
    query: request.query,
    url: request.url,
    path: request.path,
    destination: request.destination,
    command: safeCommandForStorage(request.command),
    code: summarizeCodeForStorage(request.code),
    language: request.language,
    packageName: safePackageForStorage(request.packageName),
    manager: request.manager,
    runner: request.runner,
    cwd: request.cwd,
    shell: request.shell,
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    method: request.method,
    action: request.action,
    oldText: request.oldText ? summarizeBodyForStorage(request.oldText) : undefined,
    newText: request.newText ? summarizeBodyForStorage(request.newText) : undefined,
    replaceAll: request.replaceAll,
    processId: request.processId,
    stream: request.stream,
    offset: request.offset,
    branch: request.branch,
    remote: request.remote,
    message: request.message,
    paths: request.paths,
    selector: request.selector,
    inputText: request.inputText,
    expression: request.expression,
    steps: request.steps,
    viewport: request.viewport,
    waitMs: request.waitMs,
    databasePath: request.databasePath,
    sql: request.sql ? summarizeBodyForStorage(request.sql) : undefined,
    params: request.params,
    serverId: request.serverId,
    catalogId: request.catalogId,
    packageSpec: safePackageForStorage(request.packageSpec),
    binName: request.binName,
    mcpArgs: request.mcpArgs,
    mcpToolName: request.mcpToolName,
    toolArguments: request.toolArguments ? summarizeBodyForStorage(request.toolArguments) : undefined,
    resourceUri: request.resourceUri,
    promptName: request.promptName,
    promptArguments: request.promptArguments ? summarizeBodyForStorage(request.promptArguments) : undefined,
    skillId: request.skillId,
    skillUrl: safeSkillUrlForStorage(request.skillUrl),
    skillMarkdown: request.skillMarkdown ? summarizeBodyForStorage(request.skillMarkdown) : undefined,
    capabilityId: request.capabilityId,
    mode: request.mode,
    maxRows: request.maxRows,
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
    force: request.force,
    screenshot: request.screenshot,
    create: request.create,
    timeoutMs: request.timeoutMs,
    reason: request.reason,
    round: request.round,
    source_agent_id: request.source_agent_id,
    source_agent_name: request.source_agent_name,
    code,
    status: "rejected",
    error: reason,
    createdAt: nowIso()
  };
}

function resultRecord(request, extra) {
  return {
    id: request.id,
    tool: request.tool,
    query: request.query,
    url: request.url,
    path: request.path,
    destination: request.destination,
    command: safeCommandForStorage(request.command),
    code: summarizeCodeForStorage(request.code),
    language: request.language,
    packageName: safePackageForStorage(request.packageName),
    manager: request.manager,
    runner: request.runner,
    cwd: request.cwd,
    shell: request.shell,
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    method: request.method,
    action: request.action,
    oldText: request.oldText ? summarizeBodyForStorage(request.oldText) : undefined,
    newText: request.newText ? summarizeBodyForStorage(request.newText) : undefined,
    replaceAll: request.replaceAll,
    processId: request.processId,
    stream: request.stream,
    offset: request.offset,
    branch: request.branch,
    remote: request.remote,
    message: request.message,
    paths: request.paths,
    selector: request.selector,
    inputText: request.inputText,
    expression: request.expression,
    steps: request.steps,
    viewport: request.viewport,
    waitMs: request.waitMs,
    databasePath: request.databasePath,
    sql: request.sql ? summarizeBodyForStorage(request.sql) : undefined,
    params: request.params,
    serverId: request.serverId,
    catalogId: request.catalogId,
    packageSpec: safePackageForStorage(request.packageSpec),
    binName: request.binName,
    mcpArgs: request.mcpArgs,
    mcpToolName: request.mcpToolName,
    toolArguments: request.toolArguments ? summarizeBodyForStorage(request.toolArguments) : undefined,
    resourceUri: request.resourceUri,
    promptName: request.promptName,
    promptArguments: request.promptArguments ? summarizeBodyForStorage(request.promptArguments) : undefined,
    skillId: request.skillId,
    skillUrl: safeSkillUrlForStorage(request.skillUrl),
    skillMarkdown: request.skillMarkdown ? summarizeBodyForStorage(request.skillMarkdown) : undefined,
    capabilityId: request.capabilityId,
    mode: request.mode,
    maxRows: request.maxRows,
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
    force: request.force,
    screenshot: request.screenshot,
    create: request.create,
    timeoutMs: request.timeoutMs,
    reason: request.reason,
    round: request.round,
    source_agent_id: request.source_agent_id,
    source_agent_name: request.source_agent_name,
    createdAt: nowIso(),
    ...extra
  };
}

function stringField(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function contentField(value) {
  return typeof value === "string" ? value : "";
}

function normalizeCount(value, tool) {
  const count = Number(value);
  if (!Number.isFinite(count)) return FILE_TOOLS.has(tool) || ARCHIVE_TOOLS.has(tool) || PROCESS_TOOLS.has(tool) || CODE_TOOLS.has(tool) || PACKAGE_TOOLS.has(tool) || TEST_TOOLS.has(tool) || API_TOOLS.has(tool) || GIT_TOOLS.has(tool) || BROWSER_TOOLS.has(tool) || DATABASE_TOOLS.has(tool) ? undefined : 5;
  if (PROCESS_TOOLS.has(tool)) return Math.max(1, Math.min(100, Math.floor(count)));
  if (ARCHIVE_TOOLS.has(tool)) return Math.max(1, Math.min(1000, Math.floor(count)));
  const max = FILE_TOOLS.has(tool) ? 300 : CONTEXT_TOOLS.has(tool) ? 20 : 8;
  return Math.max(1, Math.min(max, Math.floor(count)));
}

function normalizeMaxBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return undefined;
  return Math.max(1024, Math.min(512 * 1024, Math.floor(bytes)));
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs)) return undefined;
  return Math.max(1000, Math.min(60 * 60 * 1000, Math.floor(timeoutMs)));
}

function toolEvent(type, request, extra = {}) {
  return {
    type,
    id: request.id,
    tool: request.tool,
    round: request.round,
    agentId: request.source_agent_id,
    agentName: request.source_agent_name,
    query: request.query,
    url: safeUrlForEvent(request.url),
    path: request.path,
    destination: request.destination,
    command: safeCommandForStorage(request.command),
    code: summarizeCodeForStorage(request.code),
    language: request.language,
    packageName: safePackageForStorage(request.packageName),
    manager: request.manager,
    runner: request.runner,
    cwd: request.cwd,
    shell: request.shell,
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    method: request.method,
    action: request.action,
    processId: request.processId,
    stream: request.stream,
    offset: request.offset,
    branch: request.branch,
    remote: request.remote,
    message: request.message,
    paths: request.paths,
    selector: request.selector,
    inputText: request.inputText,
    expression: request.expression,
    steps: request.steps,
    viewport: request.viewport,
    waitMs: request.waitMs,
    databasePath: request.databasePath,
    sql: request.sql ? summarizeBodyForStorage(request.sql) : undefined,
    params: request.params,
    serverId: request.serverId,
    catalogId: request.catalogId,
    packageSpec: safePackageForStorage(request.packageSpec),
    binName: request.binName,
    mcpArgs: request.mcpArgs,
    mcpToolName: request.mcpToolName,
    toolArguments: request.toolArguments ? summarizeBodyForStorage(request.toolArguments) : undefined,
    resourceUri: request.resourceUri,
    promptName: request.promptName,
    promptArguments: request.promptArguments ? summarizeBodyForStorage(request.promptArguments) : undefined,
    skillId: request.skillId,
    skillUrl: safeSkillUrlForStorage(request.skillUrl),
    skillMarkdown: request.skillMarkdown ? summarizeBodyForStorage(request.skillMarkdown) : undefined,
    capabilityId: request.capabilityId,
    mode: request.mode,
    maxRows: request.maxRows,
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
    force: request.force,
    screenshot: request.screenshot,
    create: request.create,
    timeoutMs: request.timeoutMs,
    createdAt: nowIso(),
    ...extra
  };
}

function summarizeToolResult(record = {}) {
  const result = record.result || {};
  if (record.status !== "completed") return { status: record.status, error: record.error || "" };
  if (record.tool === "read_file") {
    return { path: record.path, bytes: result.bytes, truncated: result.truncated };
  }
  if (record.tool === "list_directory") {
    return { path: record.path || ".", entries: result.entries?.length || 0, truncated: result.truncated };
  }
  if (record.tool === "search_files" || record.tool === "grep_content") {
    return { query: record.query || record.pattern, results: result.results?.length || 0, truncated: result.truncated };
  }
  if (record.tool === "web_search") {
    return { query: record.query, source: result.source, results: result.results?.length || 0 };
  }
  if (record.tool === "search_context") {
    return { query: record.query, source: result.source, results: result.results?.length || 0 };
  }
  if (record.tool === "load_context") {
    return {
      sessionId: record.sessionId,
      round: record.archiveRound,
      sourceType: result.sourceType,
      truncated: result.truncated
    };
  }
  if (record.tool === "skill_read") {
    return {
      skillId: result.skill?.id || record.skillId || "",
      sha256: result.skill?.sha256 || "",
      offset: result.skill?.instructionOffset || 0,
      nextOffset: result.skill?.nextOffset || 0,
      bytes: result.skill?.instructionsBytes || 0,
      totalBytes: result.skill?.totalInstructionsBytes || 0,
      truncated: Boolean(result.skill?.truncated)
    };
  }
  if (record.tool === "skill_list") {
    return { skills: result.skills?.length || 0, enabledMissing: result.enabledMissing?.length || 0 };
  }
  if (record.tool === "skill_search") {
    return { query: result.query || record.query || "", source: result.source, results: result.results?.length || 0 };
  }
  if (["skill_install", "skill_enable", "skill_disable", "skill_remove"].includes(record.tool)) {
    return {
      skillId: result.skill?.id || result.id || record.skillId || "",
      enabled: result.enabled,
      deleted: result.deleted,
      sha256: result.skill?.sha256 || ""
    };
  }
  if (record.tool === "extract_archive") {
    return {
      archivePath: result.archivePath,
      destinationPath: result.destinationPath,
      extracted: result.extracted?.length || 0,
      skipped: result.skipped?.length || 0,
      totalBytes: result.totalBytes || 0
    };
  }
  if (record.tool === "workspace_edit") {
    const changes = result.workspaceChanges || {};
    return {
      action: record.action,
      path: record.path,
      destination: record.destination,
      bytesWritten: result.bytesWritten || 0,
      replacements: result.replacements || 0,
      workspaceChanges: {
        created: changes.created?.length || 0,
        modified: changes.modified?.length || 0,
        deleted: changes.deleted?.length || 0,
        total: changes.totalChanges || 0
      }
    };
  }
  if (record.tool === "execute_command") {
    const workspaceChanges = record.result?.workspaceChanges || {};
    return {
      command: record.command,
      cwd: record.result?.cwd || record.cwd || ".",
      shell: record.result?.shell || record.shell || "system",
      background: Boolean(record.result?.background || record.background),
      processId: record.result?.processId || "",
      exitCode: record.result?.exitCode,
      timedOut: Boolean(record.result?.timedOut),
      stdoutBytes: record.result?.stdout?.length || 0,
      stderrBytes: record.result?.stderr?.length || 0,
      workspaceChanges: {
        status: workspaceChanges.status || "unavailable",
        complete: Boolean(workspaceChanges.complete),
        created: workspaceChanges.created?.length || 0,
        modified: workspaceChanges.modified?.length || 0,
        deleted: workspaceChanges.deleted?.length || 0,
        observedArtifacts: workspaceChanges.observedArtifacts?.length || 0,
        observedArtifactsComplete: Boolean(workspaceChanges.observedArtifactsComplete),
        observedArtifactsOmitted: workspaceChanges.observedArtifactsOmitted || 0,
        total: workspaceChanges.totalChanges || 0,
        omitted: workspaceChanges.omittedChanges || 0,
        beforeScanMs: workspaceChanges.before?.durationMs || 0,
        afterScanMs: workspaceChanges.after?.durationMs || 0
      }
    };
  }
  if (record.tool === "process_control") {
    return {
      action: result.action || record.action || "",
      processId: result.processId || result.process?.processId || record.processId || "",
      status: result.process?.status || result.status || "",
      processes: result.processes?.length || 0,
      stream: result.stream || record.stream || "",
      bytesRead: result.bytesRead || 0,
      nextOffset: result.nextOffset,
      truncated: Boolean(result.truncated),
      exitCode: result.process?.exitCode
    };
  }
  if (record.tool === "run_code") {
    return {
      language: result.language,
      codePath: result.codePath,
      codeBytes: result.codeBytes,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      stdoutBytes: result.stdout?.length || 0,
      stderrBytes: result.stderr?.length || 0
    };
  }
  if (record.tool === "install_package") {
    return {
      manager: result.manager,
      packageName: result.packageName,
      environmentPath: result.environmentPath,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      stdoutBytes: result.stdout?.length || 0,
      stderrBytes: result.stderr?.length || 0
    };
  }
  if (record.tool === "run_tests") {
    return {
      runner: result.runner,
      command: result.command,
      cwd: result.cwd,
      passed: Boolean(result.passed),
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      stdoutBytes: result.stdout?.length || 0,
      stderrBytes: result.stderr?.length || 0
    };
  }
  if (record.tool === "api_request") {
    return {
      method: result.method,
      url: result.url,
      status: result.status,
      ok: Boolean(result.ok),
      bytes: result.bytes || 0,
      truncated: Boolean(result.truncated)
    };
  }
  if (record.tool === "git_operation") {
    return {
      action: result.action,
      cwd: result.cwd,
      branch: result.branch,
      remote: result.remote,
      commitHash: result.commitHash,
      dirty: result.dirty?.length || 0,
      steps: result.steps?.length || 0,
      stdoutBytes: result.stdout?.length || 0,
      stderrBytes: result.stderr?.length || 0
    };
  }
  if (record.tool === "browser_control") {
    return {
      url: result.url,
      title: result.title,
      steps: result.steps?.length || 0,
      screenshots: result.screenshots?.length || 0,
      textBytes: result.text?.length || 0,
      timedOut: Boolean(result.timedOut)
    };
  }
  if (record.tool === "database_query") {
    return {
      engine: result.engine,
      mode: result.mode,
      databasePath: result.databasePath,
      readOnly: Boolean(result.readOnly),
      rowCount: result.rowCount || 0,
      changes: result.changes || 0,
      truncated: Boolean(result.truncated)
    };
  }
  if (record.tool === "mcp_list_tools") {
    return {
      serverId: record.serverId || "",
      servers: result.servers?.length || 0,
      okServers: result.servers?.filter((item) => item.ok).length || 0
    };
  }
  if (record.tool === "mcp_call") {
    return {
      serverId: result.serverId || record.serverId || "",
      toolName: result.toolName || record.mcpToolName || "",
      isError: Boolean(result.isError),
      contentItems: result.content?.length || 0,
      durationMs: result.durationMs
    };
  }
  if (record.tool === "mcp_list_resources") {
    return {
      serverId: record.serverId || "",
      servers: result.servers?.length || 0,
      resources: result.servers?.reduce((sum, item) => sum + (item.resources?.length || 0), 0) || 0
    };
  }
  if (record.tool === "mcp_read_resource") {
    return {
      serverId: result.serverId || record.serverId || "",
      uri: result.uri || record.resourceUri || "",
      contentItems: result.contents?.length || 0,
      durationMs: result.durationMs
    };
  }
  if (record.tool === "mcp_list_prompts") {
    return {
      serverId: record.serverId || "",
      servers: result.servers?.length || 0,
      prompts: result.servers?.reduce((sum, item) => sum + (item.prompts?.length || 0), 0) || 0
    };
  }
  if (record.tool === "mcp_get_prompt") {
    return {
      serverId: result.serverId || record.serverId || "",
      promptName: result.promptName || record.promptName || "",
      messages: result.messages?.length || 0,
      durationMs: result.durationMs
    };
  }
  if (record.tool === "mcp_search_npm") {
    return {
      query: result.query || record.query || "",
      source: result.source,
      results: result.results?.length || 0,
      firstPackage: result.results?.[0]?.packageName || ""
    };
  }
  if (record.tool === "mcp_install_npm") {
    return {
      serverId: result.id || record.serverId || "",
      packageName: result.install?.packageName || record.packageSpec || "",
      packageVersion: result.install?.packageVersion || "",
      binName: result.install?.binName || record.binName || "",
      durationMs: result.install?.durationMs || result.durationMs
    };
  }
  if (record.tool === "mcp_uninstall") {
    return {
      serverId: result.id || record.serverId || "",
      removedInstallDir: Boolean(result.removedInstallDir),
      deletedConfig: Boolean(result.config?.deleted)
    };
  }
  if (record.tool === "fetch_url") {
    return { url: safeUrlForEvent(record.url), title: result.title || "", bytes: result.bytes };
  }
  return { status: record.status };
}

function appendToolAuditLog(groupPath, action, item) {
  if (!groupPath) return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "tools.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      capabilityId: item.capabilityId,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      path: item.path,
      destination: item.destination,
      command: safeCommandForStorage(item.command),
      code: summarizeCodeForStorage(item.code),
      language: item.language,
      packageName: safePackageForStorage(item.packageName),
      manager: item.manager,
      runner: item.runner,
      cwd: item.cwd,
      shell: item.shell,
      background: item.background,
      timeoutMs: item.timeoutMs,
      action: item.action,
      processId: item.processId,
      stream: item.stream,
      offset: item.offset,
      branch: item.branch,
      remote: item.remote,
      message: item.message,
      paths: item.paths,
      force: item.force,
      selector: item.selector,
      inputTextBytes: item.inputText ? Buffer.byteLength(item.inputText, "utf8") : 0,
      expressionBytes: item.expression ? Buffer.byteLength(item.expression, "utf8") : 0,
      steps: item.steps?.length || 0,
      screenshot: item.screenshot,
      databasePath: item.databasePath,
      sqlBytes: item.sql ? Buffer.byteLength(item.sql, "utf8") : 0,
      paramsCount: item.params?.length || 0,
      serverId: item.serverId,
      catalogId: item.catalogId,
      packageSpec: safePackageForStorage(item.packageSpec),
      binName: item.binName,
      mcpArgs: item.mcpArgs,
      mcpToolName: item.mcpToolName,
      toolArguments: item.toolArguments,
      resourceUri: item.resourceUri,
      promptName: item.promptName,
      promptArguments: item.promptArguments,
      mode: item.mode,
      maxRows: item.maxRows,
      create: item.create,
      sessionId: item.sessionId,
      method: item.method,
      headers: safeHeadersForStorage(item.headers),
      archiveRound: item.archiveRound,
      query: item.query,
      url: safeUrlForEvent(item.url),
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Tool audit is best-effort; never hide the actual tool result because logging failed.
  }
  appendSkillToolAuditLog(groupPath, action, item);
}

function appendSkillToolAuditLog(groupPath, action, item) {
  if (!groupPath || !SKILL_TOOLS.has(item.tool)) return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "skills.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      capabilityId: item.capabilityId,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      skillId: item.result?.skill?.id || item.result?.id || item.skillId,
      skillUrl: safeSkillUrlForStorage(item.skillUrl),
      query: item.query,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    })}\n`, "utf8");
  } catch {
    // Skill audit is best-effort; tool result remains authoritative.
  }
}

function appendCommandAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "execute_command") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "commands.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      command: safeCommandForStorage(item.command),
      cwd: item.result?.cwd || item.cwd || ".",
      shell: item.result?.shell || item.shell || "system",
      background: Boolean(item.result?.background || item.background),
      timeoutMs: item.timeoutMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Command audit is best-effort; never hide the actual command result because logging failed.
  }
}

function appendProcessAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "process_control") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "processes.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      processAction: item.result?.action || item.action,
      processId: item.result?.processId || item.result?.process?.processId || item.processId,
      processStatus: item.result?.process?.status || item.result?.status,
      stream: item.result?.stream || item.stream,
      offset: item.result?.offset ?? item.offset,
      nextOffset: item.result?.nextOffset,
      bytesRead: item.result?.bytesRead,
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Process audit is best-effort; never hide the actual process result because logging failed.
  }
}

function appendCodeRunAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "run_code") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "code-runs.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      language: item.result?.language || item.language,
      codePath: item.result?.codePath,
      codeBytes: item.result?.codeBytes,
      codeSha256: item.result?.codeSha256,
      exitCode: item.result?.exitCode,
      timedOut: Boolean(item.result?.timedOut),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Code-run audit is best-effort; never hide the actual code result because logging failed.
  }
}

function appendPackageAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "install_package") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "packages.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      manager: item.result?.manager || item.manager,
      packageName: item.result?.packageName || safePackageForStorage(item.packageName),
      environmentPath: item.result?.environmentPath,
      exitCode: item.result?.exitCode,
      timedOut: Boolean(item.result?.timedOut),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Package audit is best-effort; never hide the actual install result because logging failed.
  }
}

function appendTestAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "run_tests") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "tests.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      runner: item.result?.runner || item.runner,
      command: safeCommandForStorage(item.result?.command || item.command),
      cwd: item.result?.cwd || item.cwd || ".",
      passed: Boolean(item.result?.passed),
      exitCode: item.result?.exitCode,
      timedOut: Boolean(item.result?.timedOut),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Test audit is best-effort; never hide the actual test result because logging failed.
  }
}

function appendApiAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "api_request") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "api-requests.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      method: item.result?.method || item.method,
      url: item.result?.url || safeUrlForEvent(item.url),
      httpStatus: item.result?.status,
      ok: Boolean(item.result?.ok),
      bytes: item.result?.bytes,
      truncated: Boolean(item.result?.truncated),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // API audit is best-effort; never hide the actual API result because logging failed.
  }
}

function appendGitAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "git_operation") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "git.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      gitAction: item.result?.action || item.action,
      cwd: item.result?.cwd || item.cwd || ".",
      branch: item.result?.branch || item.branch,
      remote: item.result?.remote || item.remote,
      commitHash: item.result?.commitHash,
      paths: item.result?.paths || item.paths || [],
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Git audit is best-effort; never hide the actual git result because logging failed.
  }
}

function appendBrowserAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "browser_control") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "browser.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      url: item.result?.url || safeUrlForEvent(item.url),
      title: item.result?.title,
      steps: item.result?.steps?.map((step) => ({
        action: step.action,
        selector: step.selector,
        screenshotPath: step.screenshotPath,
        durationMs: step.durationMs
      })) || [],
      screenshots: item.result?.screenshots || [],
      timedOut: Boolean(item.result?.timedOut),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Browser audit is best-effort; never hide the actual browser result because logging failed.
  }
}

function appendDatabaseAuditLog(groupPath, action, item) {
  if (!groupPath || item.tool !== "database_query") return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "database.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      databasePath: item.result?.databasePath || item.databasePath || item.path,
      mode: item.result?.mode || item.mode,
      readOnly: Boolean(item.result?.readOnly),
      rowCount: item.result?.rowCount,
      changes: item.result?.changes,
      truncated: Boolean(item.result?.truncated),
      sqlBytes: item.sql?.bytes || (item.sql ? Buffer.byteLength(String(item.sql), "utf8") : 0),
      paramsCount: item.params?.length || 0,
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Database audit is best-effort; never hide the actual database result because logging failed.
  }
}

function appendMcpAuditLog(groupPath, action, item) {
  if (!groupPath || !MCP_TOOLS.has(item.tool)) return;
  try {
    const filePath = path.join(groupPath, "shared", "logs", "mcp.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      action,
      id: item.id,
      tool: item.tool,
      status: item.status,
      code: item.code,
      error: item.error,
      capabilityId: item.capabilityId,
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      serverId: item.result?.serverId || item.serverId,
      serverName: item.result?.serverName,
      query: item.query,
      catalogId: item.catalogId,
      packageSpec: safePackageForStorage(item.result?.install?.packageSpec || item.packageSpec),
      binName: item.result?.install?.binName || item.binName,
      mcpArgs: item.mcpArgs,
      mcpToolName: item.result?.toolName || item.mcpToolName,
      toolArguments: item.toolArguments,
      resourceUri: item.result?.uri || item.resourceUri,
      promptName: item.result?.promptName || item.promptName,
      promptArguments: item.promptArguments,
      isError: Boolean(item.result?.isError),
      durationMs: item.result?.durationMs,
      resultSummary: summarizeToolResult(item),
      createdAt: nowIso()
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // MCP audit is best-effort; never hide the actual MCP result because logging failed.
  }
}

function safeRequestForStorage(request) {
  return {
    ...request,
    command: safeCommandForStorage(request.command),
    code: summarizeCodeForStorage(request.code),
    packageName: safePackageForStorage(request.packageName),
    runner: request.runner,
    action: request.action,
    processId: request.processId,
    stream: request.stream,
    offset: request.offset,
    branch: request.branch,
    remote: request.remote,
    message: request.message,
    paths: request.paths,
    selector: request.selector,
    inputText: request.inputText ? {
      bytes: Buffer.byteLength(request.inputText, "utf8"),
      preview: request.inputText.slice(0, 80)
    } : "",
    expression: request.expression ? {
      bytes: Buffer.byteLength(request.expression, "utf8"),
      preview: request.expression.slice(0, 80)
    } : "",
    steps: request.steps?.map((step) => ({
      action: step.action || step.type || step.name,
      selector: step.selector,
      textBytes: step.text || step.value || step.inputText ? Buffer.byteLength(String(step.text || step.value || step.inputText || ""), "utf8") : 0,
      expressionBytes: step.expression || step.script || step.js ? Buffer.byteLength(String(step.expression || step.script || step.js || ""), "utf8") : 0,
      screenshot: step.action === "screenshot"
    })) || [],
    viewport: request.viewport,
    waitMs: request.waitMs,
    databasePath: request.databasePath,
    sql: request.sql ? summarizeBodyForStorage(request.sql) : undefined,
    params: request.params,
    serverId: request.serverId,
    catalogId: request.catalogId,
    packageSpec: safePackageForStorage(request.packageSpec),
    binName: request.binName,
    mcpArgs: request.mcpArgs,
    mcpToolName: request.mcpToolName,
    toolArguments: request.toolArguments ? summarizeBodyForStorage(request.toolArguments) : undefined,
    resourceUri: request.resourceUri,
    promptName: request.promptName,
    promptArguments: request.promptArguments ? summarizeBodyForStorage(request.promptArguments) : undefined,
    skillId: request.skillId,
    skillUrl: safeSkillUrlForStorage(request.skillUrl),
    skillMarkdown: request.skillMarkdown ? summarizeBodyForStorage(request.skillMarkdown) : undefined,
    mode: request.mode,
    maxRows: request.maxRows,
    headers: safeHeadersForStorage(request.headers),
    body: request.body ? summarizeBodyForStorage(request.body) : undefined,
    json: request.json ? summarizeBodyForStorage(request.json) : undefined,
    url: request.url,
    force: request.force,
    screenshot: request.screenshot,
    create: request.create
  };
}

function safeUrlForEvent(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeSkillUrlForStorage(value) {
  const safe = safeUrlForEvent(value);
  if (!safe) return "";
  const url = new URL(safe);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeCommandForStorage(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]");
}

function summarizeCodeForStorage(value) {
  const code = String(value || "");
  if (!code) return "";
  return {
    bytes: Buffer.byteLength(code, "utf8"),
    preview: code.slice(0, 120)
  };
}

function safePackageForStorage(value) {
  return String(value || "")
    .replace(/(\/\/[^/:]+:)[^@/]+(@)/g, "$1[redacted]$2")
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]");
}

function objectField(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function arrayOfObjects(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function arrayOfPrimitive(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item === null) return null;
    if (["string", "number", "boolean"].includes(typeof item)) return item;
    return String(item);
  });
}

function normalizeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function safeHeadersForStorage(value) {
  const headers = objectField(value);
  const result = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    result[key] = /authorization|api[-_]?key|token|secret|cookie/i.test(key)
      ? "[redacted]"
      : String(rawValue ?? "").slice(0, 500);
  }
  return result;
}

function summarizeBodyForStorage(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(text || "", "utf8"),
    preview: String(text || "").slice(0, 120)
  };
}
