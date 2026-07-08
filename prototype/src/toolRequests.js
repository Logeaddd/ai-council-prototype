import { makeId, nowIso } from "./types.js";
import { fetchPublicUrl, searchWeb } from "./webTools.js";
import { executeFileTool } from "./fileTools.js";
import { loadSessionContextArchiveItem, searchSessionContextArchive } from "./storage.js";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_TOOLS = new Set([
  "fetch_url",
  "web_search",
  "list_directory",
  "read_file",
  "search_files",
  "grep_content",
  "search_context",
  "load_context"
]);
const FILE_TOOLS = new Set(["list_directory", "read_file", "search_files", "grep_content"]);
const CONTEXT_TOOLS = new Set(["search_context", "load_context"]);

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
      const rejection = reject(base, "invalid_tool", "Tool must be one of web_search, fetch_url, list_directory, read_file, search_files, grep_content, search_context, load_context.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    if (permissionTier === "text") {
      const rejection = reject(base, "permission_denied", "Seat has text-only permission and cannot use tools.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }

    accepted.push(base);
    const start = Date.now();
    events.push(toolEvent("tool_start", base, { status: "running" }));
    const result = await executeOne(base, options);
    results.push(result);
    const eventType = result.status === "completed" ? "tool_success" : "tool_failure";
    events.push(toolEvent(eventType, base, {
      status: result.status,
      code: result.code,
      error: result.error,
      durationMs: Date.now() - start,
      resultSummary: summarizeToolResult(result)
    }));
    appendToolAuditLog(options.groupPath, "completed", result);
  }

  return { accepted, rejected, results, events };
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
      const results = searchSessionContextArchive(options.groupPath, query, {
        limit: request.count || 5
      });
      return resultRecord(request, {
        status: "completed",
        result: {
          ok: true,
          source: "local_context_archive",
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
      const result = loadSessionContextArchiveItem(options.groupPath, {
        ...request,
        round: request.archiveRound
      }, {
        maxBytes: request.maxBytes || options.maxArchiveLoadBytes
      });
      return resultRecord(request, { status: "completed", result });
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
      status: result.ok ? "completed" : "not_configured",
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
    pattern: stringField(item.pattern),
    root: stringField(item.root),
    sessionId: stringField(item.sessionId || item.session_id),
    archiveRound: item.round === undefined ? undefined : Number(item.round),
    reason: stringField(item.reason),
    count: normalizeCount(item.count, tool),
    maxBytes: normalizeMaxBytes(item.maxBytes || item.max_bytes),
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
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    archiveRound: request.archiveRound,
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
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    archiveRound: request.archiveRound,
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

function normalizeCount(value, tool) {
  const count = Number(value);
  if (!Number.isFinite(count)) return FILE_TOOLS.has(tool) ? undefined : 5;
  const max = FILE_TOOLS.has(tool) ? 300 : CONTEXT_TOOLS.has(tool) ? 20 : 8;
  return Math.max(1, Math.min(max, Math.floor(count)));
}

function normalizeMaxBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return undefined;
  return Math.max(1024, Math.min(512 * 1024, Math.floor(bytes)));
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
    pattern: request.pattern,
    root: request.root,
    sessionId: request.sessionId,
    archiveRound: request.archiveRound,
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
      round: item.round,
      source_agent_id: item.source_agent_id,
      source_agent_name: item.source_agent_name,
      path: item.path,
      sessionId: item.sessionId,
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
