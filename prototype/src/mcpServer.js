#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { readAppSettings } from "./appSettings.js";
import { fetchPublicUrl, searchWeb } from "./webTools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, "..");
const SERVER_NAME = "ai-council-web-tools";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "web_search",
    description: "Search the web through the configured Brave Search key.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "number", minimum: 1, maximum: 8 },
        timeoutMs: { type: "number", minimum: 1000, maximum: 60000 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_url",
    description: "Read text from a public HTTPS page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 60000 },
        maxBytes: { type: "number", minimum: 1024, maximum: 163840 }
      },
      required: ["url"],
      additionalProperties: false
    }
  }
];

export async function handleMcpMessage(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(message?.id ?? null, -32600, "Invalid JSON-RPC request.");
  }
  if (message.id === undefined) return undefined;

  try {
    if (message.method === "initialize") {
      return response(message.id, {
        protocolVersion: String(message.params?.protocolVersion || PROTOCOL_VERSION),
        capabilities: { tools: {} },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      });
    }
    if (message.method === "ping") {
      return response(message.id, {});
    }
    if (message.method === "tools/list") {
      return response(message.id, { tools: TOOLS });
    }
    if (message.method === "tools/call") {
      return response(message.id, await callTool(message.params || {}, options));
    }
    return errorResponse(message.id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    return errorResponse(message.id, -32603, error.message || "Internal error.");
  }
}

async function callTool(params, options = {}) {
  const name = String(params.name || "").trim();
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (name === "web_search") {
    const result = await searchWeb(args.query, {
      count: args.count,
      timeoutMs: args.timeoutMs,
      env: options.env || process.env,
      appSettings: options.appSettings || readSafeAppSettings(options.baseDir || baseDir)
    });
    return toolTextResult(result, !result.ok);
  }
  if (name === "fetch_url") {
    try {
      const result = await fetchPublicUrl(args.url, {
        timeoutMs: args.timeoutMs,
        maxBytes: args.maxBytes
      });
      return toolTextResult(result, false);
    } catch (error) {
      return toolTextResult({
        ok: false,
        source: "real_error",
        error: error.message || "fetch_url failed"
      }, true);
    }
  }
  return toolTextResult({
    ok: false,
    source: "invalid_tool",
    error: `Unknown tool: ${name || "(empty)"}`
  }, true);
}

function toolTextResult(payload, isError) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError: Boolean(isError)
  };
}

function readSafeAppSettings(root) {
  try {
    return readAppSettings(root);
  } catch {
    return {};
  }
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const text = String(line || "").trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      writeMessage(errorResponse(null, -32700, "Parse error."));
      continue;
    }
    const reply = await handleMcpMessage(message);
    if (reply) writeMessage(reply);
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
