import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readMcpServerConfigs } from "./mcpConfig.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

export async function listConfiguredMcpTools(baseDir, request = {}, options = {}) {
  const selection = selectMcpServers(baseDir, request.serverId || request.mcpServerId);
  if (!selection.ok) return selection;

  const servers = [];
  for (const server of selection.servers) {
    servers.push(await listOneServerTools(baseDir, server, options));
  }
  const ok = servers.some((item) => item.ok);
  return {
    ok,
    source: "configured_mcp_stdio",
    code: ok ? undefined : "mcp_list_tools_failed",
    error: ok ? "" : "No configured MCP server returned a tool list.",
    servers
  };
}

export async function callConfiguredMcpTool(baseDir, request = {}, options = {}) {
  const toolName = String(request.mcpToolName || request.toolName || request.mcpTool || request.name || "").trim();
  if (!toolName) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "missing_mcp_tool_name",
      error: "mcp_call requires mcpToolName."
    };
  }
  const selection = await selectMcpServerForTool(baseDir, request.serverId || request.mcpServerId, toolName, options);
  if (!selection.ok) return selection;
  return callOneServerTool(baseDir, selection.server, {
    toolName,
    arguments: normalizeArguments(request.toolArguments || request.arguments || request.input)
  }, options);
}

export async function listConfiguredMcpResources(baseDir, request = {}, options = {}) {
  const selection = selectMcpServers(baseDir, request.serverId || request.mcpServerId);
  if (!selection.ok) return selection;

  const servers = [];
  for (const server of selection.servers) {
    servers.push(await listOneServerResources(baseDir, server, request, options));
  }
  const ok = servers.some((item) => item.ok);
  return {
    ok,
    source: "configured_mcp_stdio",
    code: ok ? undefined : "mcp_list_resources_failed",
    error: ok ? "" : "No configured MCP server returned a resource list.",
    servers
  };
}

export async function readConfiguredMcpResource(baseDir, request = {}, options = {}) {
  const uri = String(request.uri || request.resourceUri || request.resource_uri || "").trim();
  if (!uri) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "missing_mcp_resource_uri",
      error: "mcp_read_resource requires uri."
    };
  }
  const selection = await selectMcpServerForResource(baseDir, request.serverId || request.mcpServerId, uri, options);
  if (!selection.ok) return selection;
  return readOneServerResource(baseDir, selection.server, {
    uri
  }, options);
}

export async function listConfiguredMcpPrompts(baseDir, request = {}, options = {}) {
  const selection = selectMcpServers(baseDir, request.serverId || request.mcpServerId);
  if (!selection.ok) return selection;

  const servers = [];
  for (const server of selection.servers) {
    servers.push(await listOneServerPrompts(baseDir, server, request, options));
  }
  const ok = servers.some((item) => item.ok);
  return {
    ok,
    source: "configured_mcp_stdio",
    code: ok ? undefined : "mcp_list_prompts_failed",
    error: ok ? "" : "No configured MCP server returned a prompt list.",
    servers
  };
}

export async function getConfiguredMcpPrompt(baseDir, request = {}, options = {}) {
  const promptName = String(request.promptName || request.prompt_name || request.name || "").trim();
  if (!promptName) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "missing_mcp_prompt_name",
      error: "mcp_get_prompt requires promptName."
    };
  }
  const selection = await selectMcpServerForPrompt(baseDir, request.serverId || request.mcpServerId, promptName, options);
  if (!selection.ok) return selection;
  return getOneServerPrompt(baseDir, selection.server, {
    promptName,
    arguments: normalizeArguments(request.promptArguments || request.prompt_arguments || request.arguments || request.input)
  }, options);
}

async function listOneServerTools(baseDir, server, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const listed = await client.request("tools/list", {});
      return {
        ok: true,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        tools: Array.isArray(listed?.tools) ? listed.tools : []
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error);
  }
}

async function callOneServerTool(baseDir, server, request, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const toolResult = await client.request("tools/call", {
        name: request.toolName,
        arguments: request.arguments
      });
      return {
        ok: !toolResult?.isError,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        toolName: request.toolName,
        isError: Boolean(toolResult?.isError),
        content: Array.isArray(toolResult?.content) ? toolResult.content : [],
        rawResult: toolResult
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error, { toolName: request.toolName });
  }
}

async function listOneServerResources(baseDir, server, request, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const listed = await client.request("resources/list", cursorParams(request.cursor));
      return {
        ok: true,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        resources: Array.isArray(listed?.resources) ? listed.resources : [],
        nextCursor: listed?.nextCursor || ""
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error);
  }
}

async function readOneServerResource(baseDir, server, request, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const resourceResult = await client.request("resources/read", {
        uri: request.uri
      });
      return {
        ok: true,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        uri: request.uri,
        contents: Array.isArray(resourceResult?.contents) ? resourceResult.contents : [],
        rawResult: resourceResult
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error, { uri: request.uri });
  }
}

async function listOneServerPrompts(baseDir, server, request, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const listed = await client.request("prompts/list", cursorParams(request.cursor));
      return {
        ok: true,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        prompts: Array.isArray(listed?.prompts) ? listed.prompts : [],
        nextCursor: listed?.nextCursor || ""
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error);
  }
}

async function getOneServerPrompt(baseDir, server, request, options) {
  try {
    return await runMcpSession(baseDir, server, async (client) => {
      const promptResult = await client.request("prompts/get", {
        name: request.promptName,
        arguments: request.arguments
      });
      return {
        ok: true,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        promptName: request.promptName,
        description: promptResult?.description || "",
        messages: Array.isArray(promptResult?.messages) ? promptResult.messages : [],
        rawResult: promptResult
      };
    }, options);
  } catch (error) {
    return mcpFailure(server, error, { promptName: request.promptName });
  }
}

function mcpFailure(server, error, extra = {}) {
  return {
    ok: false,
    source: "configured_mcp_stdio",
    serverId: server.id,
    serverName: server.name,
    code: error.code || "mcp_client_error",
    error: error.message || "MCP client failed.",
    ...extra
  };
}

function runMcpSession(baseDir, server, operation, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs || options.mcpTimeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = clampNumber(options.maxOutputBytes || options.maxMcpOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, DEFAULT_MAX_OUTPUT_BYTES);
  const startedAtMs = Date.now();
  const cwd = resolveServerCwd(baseDir, server.cwd);
  const stderr = outputBuffer(maxOutputBytes);
  const stdout = outputBuffer(maxOutputBytes);
  const env = { ...process.env, ...(server.env || {}) };

  return new Promise((resolve) => {
    let nextId = 1;
    let settled = false;
    let stdoutText = "";
    const pending = new Map();
    const child = spawn(server.command, server.args || [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      fail("mcp_timeout", `MCP server ${server.id} exceeded ${timeoutMs}ms.`);
    }, timeoutMs);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) {
        waiter.reject(toolError("mcp_session_closed", "MCP session closed before a response arrived."));
      }
      pending.clear();
      cleanupChild(child);
      resolve(withRuntime(payload));
    };

    const fail = (code, message, extra = {}) => {
      finish({
        ok: false,
        source: "configured_mcp_stdio",
        serverId: server.id,
        serverName: server.name,
        code,
        error: message,
        ...extra
      });
    };

    const withRuntime = (payload) => ({
      ...payload,
      serverId: payload.serverId || server.id,
      serverName: payload.serverName || server.name,
      command: redactSecrets(server.command),
      args: (server.args || []).map(redactSecrets),
      cwd: path.relative(baseDir, cwd).replaceAll("\\", "/") || ".",
      durationMs: Date.now() - startedAtMs,
      stderr: redactSecrets(stderr.text(), server.env),
      stdout: redactSecrets(stdout.text(), server.env),
      stderrTruncated: stderr.truncated,
      stdoutTruncated: stdout.truncated
    });

    const client = {
      request(method, params) {
        const id = nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
          writeJsonLine(child, { jsonrpc: "2.0", id, method, params });
        });
      },
      notify(method, params) {
        writeJsonLine(child, { jsonrpc: "2.0", method, params });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout.add(chunk);
      stdoutText += chunk.toString("utf8");
      let parsed;
      try {
        parsed = parseJsonRpcMessages(stdoutText);
      } catch (error) {
        fail(error.code || "mcp_invalid_response", error.message || "MCP server wrote invalid JSON-RPC output.");
        return;
      }
      stdoutText = parsed.rest;
      for (const message of parsed.messages) handleMessage(message);
    });
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => {
      fail("mcp_spawn_failed", error.message || "Failed to start MCP server.");
    });
    child.on("close", (exitCode, signal) => {
      if (!settled && pending.size) {
        fail("mcp_process_exit", `MCP server exited before responding. exit=${exitCode ?? "null"} signal=${signal || ""}`, { exitCode, signal: signal || "" });
      }
    });

    (async () => {
      try {
        await client.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "ai-council", version: "0.2.0" }
        });
        client.notify("notifications/initialized", {});
        finish(await operation(client));
      } catch (error) {
        fail(error.code || "mcp_client_error", error.message || "MCP client failed.", error.extra || {});
      }
    })();

    function handleMessage(message) {
      if (!message || message.id === undefined || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        const error = toolError("mcp_error", message.error.message || "MCP server returned an error.");
        error.extra = { mcpError: message.error };
        waiter.reject(error);
        return;
      }
      waiter.resolve(message.result);
    }
  });
}

function selectMcpServer(baseDir, id) {
  const servers = enabledMcpServers(baseDir);
  if (!servers.length) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "mcp_server_not_configured",
      error: "No enabled MCP server is configured."
    };
  }
  const target = String(id || "").trim();
  if (!target && servers.length === 1) return { ok: true, server: servers[0] };
  if (!target) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "missing_mcp_server_id",
      error: "mcp_call requires serverId when more than one configured MCP server is enabled."
    };
  }
  const server = servers.find((item) => item.id === target || item.name === target);
  if (!server) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "mcp_server_not_found",
      error: `No enabled MCP server matches ${target}.`
    };
  }
  return { ok: true, server };
}

async function selectMcpServerForTool(baseDir, id, toolName, options) {
  return selectMcpServerForListedItem(baseDir, id, toolName, options, {
    valueKey: "toolName",
    valueLabel: "tool",
    lookupFailedCode: "mcp_tool_lookup_failed",
    notFoundCode: "mcp_tool_not_found",
    ambiguousCode: "ambiguous_mcp_tool",
    list: (server) => listOneServerTools(baseDir, server, options),
    getItems: (result) => result.tools,
    matches: (item, value) => item?.name === value
  });
}

async function selectMcpServerForResource(baseDir, id, uri, options) {
  return selectMcpServerForListedItem(baseDir, id, uri, options, {
    valueKey: "uri",
    valueLabel: "resource",
    lookupFailedCode: "mcp_resource_lookup_failed",
    notFoundCode: "mcp_resource_not_found",
    ambiguousCode: "ambiguous_mcp_resource",
    list: (server) => listOneServerResources(baseDir, server, {}, options),
    getItems: (result) => result.resources,
    matches: (item, value) => item?.uri === value
  });
}

async function selectMcpServerForPrompt(baseDir, id, promptName, options) {
  return selectMcpServerForListedItem(baseDir, id, promptName, options, {
    valueKey: "promptName",
    valueLabel: "prompt",
    lookupFailedCode: "mcp_prompt_lookup_failed",
    notFoundCode: "mcp_prompt_not_found",
    ambiguousCode: "ambiguous_mcp_prompt",
    list: (server) => listOneServerPrompts(baseDir, server, {}, options),
    getItems: (result) => result.prompts,
    matches: (item, value) => item?.name === value
  });
}

async function selectMcpServerForListedItem(baseDir, id, value, options, config) {
  const target = String(id || "").trim();
  if (target) return selectMcpServer(baseDir, target);

  const servers = enabledMcpServers(baseDir);
  if (!servers.length) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "mcp_server_not_configured",
      error: "No enabled MCP server is configured."
    };
  }
  if (servers.length === 1) return { ok: true, server: servers[0] };

  const inspected = [];
  for (const server of servers) {
    inspected.push({
      server,
      result: await config.list(server)
    });
  }

  const failed = inspected.filter((item) => !item.result.ok);
  if (failed.length) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: config.lookupFailedCode,
      error: `Could not inspect ${config.valueLabel}s for ${failed.length} enabled MCP server(s); provide serverId.`,
      [config.valueKey]: value,
      servers: inspected.map((item) => item.result)
    };
  }

  const matches = inspected.filter((item) =>
    Array.isArray(config.getItems(item.result)) && config.getItems(item.result).some((listed) => config.matches(listed, value))
  );
  if (matches.length === 1) return { ok: true, server: matches[0].server };
  if (!matches.length) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: config.notFoundCode,
      error: `No enabled MCP server exposes ${config.valueLabel} ${value}.`,
      [config.valueKey]: value,
      servers: inspected.map((item) => item.result)
    };
  }
  return {
    ok: false,
    source: "configured_mcp_stdio",
    code: config.ambiguousCode,
    error: `More than one enabled MCP server exposes ${config.valueLabel} ${value}; provide serverId.`,
    [config.valueKey]: value,
    matchingServers: matches.map((item) => ({ id: item.server.id, name: item.server.name })),
    servers: inspected.map((item) => item.result)
  };
}

function selectMcpServers(baseDir, id) {
  const target = String(id || "").trim();
  const servers = enabledMcpServers(baseDir);
  if (!servers.length) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "mcp_server_not_configured",
      error: "No enabled MCP server is configured.",
      servers: []
    };
  }
  if (!target) return { ok: true, servers };
  const server = servers.find((item) => item.id === target || item.name === target);
  if (!server) {
    return {
      ok: false,
      source: "configured_mcp_stdio",
      code: "mcp_server_not_found",
      error: `No enabled MCP server matches ${target}.`,
      servers: []
    };
  }
  return { ok: true, servers: [server] };
}

function enabledMcpServers(baseDir) {
  return readMcpServerConfigs(baseDir).filter((server) => server.enabled !== false && server.transport === "stdio");
}

function parseJsonRpcMessages(input) {
  let rest = input;
  const messages = [];
  while (rest.length) {
    const headerMatch = rest.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (headerMatch) {
      const headerBytes = headerMatch[0].length;
      const length = Number(headerMatch[1]);
      if (rest.length < headerBytes + length) break;
      const body = rest.slice(headerBytes, headerBytes + length);
      messages.push(parseMessage(body));
      rest = rest.slice(headerBytes + length);
      continue;
    }
    const newline = rest.search(/\r?\n/);
    if (newline < 0) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(rest[newline] === "\r" ? newline + 2 : newline + 1);
    if (!line) continue;
    messages.push(parseMessage(line));
  }
  return { messages, rest };
}

function parseMessage(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw toolError("mcp_invalid_response", "MCP server wrote invalid JSON-RPC output.");
  }
}

function writeJsonLine(child, message) {
  if (!child.stdin.writable) throw toolError("mcp_stdin_closed", "MCP server stdin is closed.");
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function cleanupChild(child) {
  try {
    child.stdin.end();
  } catch {}
  if (!child.pid || child.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    child.kill("SIGTERM");
  } catch {}
}

function resolveServerCwd(baseDir, cwd) {
  const raw = String(cwd || "").trim();
  const target = raw ? (path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw)) : path.resolve(baseDir);
  if (!fs.existsSync(target)) throw toolError("mcp_cwd_not_found", "MCP server cwd does not exist.");
  if (!fs.statSync(target).isDirectory()) throw toolError("mcp_cwd_not_directory", "MCP server cwd is not a directory.");
  return target;
}

function normalizeArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function cursorParams(value) {
  const cursor = String(value || "").trim();
  return cursor ? { cursor } : {};
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function outputBuffer(maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    add(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      const currentBytes = chunks.reduce((sum, item) => sum + item.length, 0);
      const remaining = maxBytes - currentBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      if (buffer.length > remaining || totalBytes > maxBytes) truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

function redactSecrets(value, env = {}) {
  let text = String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]");
  for (const secret of Object.values(env || {})) {
    const raw = String(secret || "");
    if (raw.length >= 6) text = text.replaceAll(raw, "[redacted]");
  }
  return text;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
