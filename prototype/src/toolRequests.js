import { makeId, nowIso } from "./types.js";
import { fetchPublicUrl, searchWeb } from "./webTools.js";
import { executeFileTool } from "./fileTools.js";
import { extractArchiveTool } from "./archiveTools.js";
import { executeCommandTool } from "./commandTools.js";
import { runCodeTool } from "./codeRunTools.js";
import { installPackageTool } from "./packageTools.js";
import { runTestsTool } from "./testRunTools.js";
import { apiRequestTool } from "./apiTools.js";
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
  "load_context",
  "extract_archive",
  "execute_command",
  "run_code",
  "install_package",
  "run_tests",
  "api_request"
]);
const FILE_TOOLS = new Set(["list_directory", "read_file", "search_files", "grep_content"]);
const CONTEXT_TOOLS = new Set(["search_context", "load_context"]);
const ARCHIVE_TOOLS = new Set(["extract_archive"]);
const COMMAND_TOOLS = new Set(["execute_command"]);
const CODE_TOOLS = new Set(["run_code"]);
const PACKAGE_TOOLS = new Set(["install_package"]);
const TEST_TOOLS = new Set(["run_tests"]);
const API_TOOLS = new Set(["api_request"]);
const FULL_PERMISSION_TOOLS = new Set(["extract_archive", "execute_command", "run_code", "install_package", "run_tests"]);

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
      const rejection = reject(base, "invalid_tool", "Tool must be one of web_search, fetch_url, list_directory, read_file, search_files, grep_content, search_context, load_context, extract_archive, execute_command, run_code, install_package, run_tests, api_request.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
      continue;
    }
    if (permissionTier === "text") {
      const rejection = reject(base, "permission_denied", "Seat has text-only permission and cannot use tools.");
      rejected.push(rejection);
      events.push(toolEvent("tool_failure", base, { status: "rejected", code: rejection.code, error: rejection.error }));
      appendToolAuditLog(options.groupPath, "rejected", rejection);
      appendCommandAuditLog(options.groupPath, "rejected", rejection);
      appendCodeRunAuditLog(options.groupPath, "rejected", rejection);
      appendPackageAuditLog(options.groupPath, "rejected", rejection);
      appendTestAuditLog(options.groupPath, "rejected", rejection);
      appendApiAuditLog(options.groupPath, "rejected", rejection);
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
      continue;
    }

    accepted.push(safeRequestForStorage(base));
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
    appendCommandAuditLog(options.groupPath, "completed", result);
    appendCodeRunAuditLog(options.groupPath, "completed", result);
    appendPackageAuditLog(options.groupPath, "completed", result);
    appendTestAuditLog(options.groupPath, "completed", result);
    appendApiAuditLog(options.groupPath, "completed", result);
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
        signal: options.signal
      });
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
    destination: stringField(item.destination || item.destinationPath || item.outputPath || item.dest),
    command: stringField(item.command || item.cmd || item.shellCommand || item.shell_command),
    code: stringField(item.code || item.content || item.source),
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
    headers: objectField(item.headers),
    body: item.body,
    json: item.json,
    archiveRound: item.round === undefined ? undefined : Number(item.round),
    overwrite: Boolean(item.overwrite),
    background: Boolean(item.background),
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
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
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
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
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

function normalizeCount(value, tool) {
  const count = Number(value);
  if (!Number.isFinite(count)) return FILE_TOOLS.has(tool) || ARCHIVE_TOOLS.has(tool) || CODE_TOOLS.has(tool) || PACKAGE_TOOLS.has(tool) || TEST_TOOLS.has(tool) || API_TOOLS.has(tool) ? undefined : 5;
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
    headers: safeHeadersForStorage(request.headers),
    archiveRound: request.archiveRound,
    overwrite: request.overwrite,
    background: request.background,
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
  if (record.tool === "extract_archive") {
    return {
      archivePath: result.archivePath,
      destinationPath: result.destinationPath,
      extracted: result.extracted?.length || 0,
      skipped: result.skipped?.length || 0,
      totalBytes: result.totalBytes || 0
    };
  }
  if (record.tool === "execute_command") {
    return {
      command: record.command,
      cwd: record.result?.cwd || record.cwd || ".",
      shell: record.result?.shell || record.shell || "system",
      background: Boolean(record.result?.background || record.background),
      exitCode: record.result?.exitCode,
      timedOut: Boolean(record.result?.timedOut),
      stdoutBytes: record.result?.stdout?.length || 0,
      stderrBytes: record.result?.stderr?.length || 0
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

function safeRequestForStorage(request) {
  return {
    ...request,
    command: safeCommandForStorage(request.command),
    code: summarizeCodeForStorage(request.code),
    packageName: safePackageForStorage(request.packageName),
    runner: request.runner,
    headers: safeHeadersForStorage(request.headers),
    body: request.body ? summarizeBodyForStorage(request.body) : undefined,
    json: request.json ? summarizeBodyForStorage(request.json) : undefined,
    url: request.url
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
