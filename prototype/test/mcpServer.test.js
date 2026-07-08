import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage } from "../src/mcpServer.js";

const prototypeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes web_search and fetch_url tools", async () => {
  const init = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  const listed = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });

  assert.equal(init.result.serverInfo.name, "ai-council-web-tools");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["web_search", "fetch_url"]);
  assert.equal(listed.result.tools[0].inputSchema.required[0], "query");
  assert.equal(listed.result.tools[1].inputSchema.required[0], "url");
});

test("MCP web_search reports not_configured without a real key", async () => {
  const reply = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "web_search",
      arguments: { query: "AI Council" }
    }
  }, {
    env: {},
    appSettings: {}
  });

  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not_configured/);
  assert.match(reply.result.content[0].text, /Brave Search/);
});

test("MCP fetch_url keeps the existing public URL guard", async () => {
  const reply = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "fetch_url",
      arguments: { url: "http://127.0.0.1:4317" }
    }
  });

  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Blocked unsafe URL/);
});

test("MCP stdio server handles JSON-RPC lines", async () => {
  const child = spawn(process.execPath, [path.join("src", "mcpServer.js")], {
    cwd: prototypeRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();
  const exit = await waitForClose(child);

  assert.equal(exit, 0);
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  const replies = Buffer.concat(stdout).toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, "ai-council-web-tools");
  assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), ["web_search", "fetch_url"]);
});

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}
