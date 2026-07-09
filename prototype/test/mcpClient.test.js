import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  callConfiguredMcpTool,
  getConfiguredMcpPrompt,
  listConfiguredMcpPrompts,
  listConfiguredMcpResources,
  listConfiguredMcpTools,
  readConfiguredMcpResource
} from "../src/mcpClient.js";
import { upsertMcpServerConfig } from "../src/mcpConfig.js";
import { executeToolRequests } from "../src/toolRequests.js";

test("external MCP client starts configured stdio servers and lists tools", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-client-list-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake",
    name: "Fake MCP",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir,
    env: { MCP_SECRET: "secret-mcp-value" }
  });

  const result = await listConfiguredMcpTools(baseDir, { serverId: "fake" });

  assert.equal(result.ok, true);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].ok, true);
  assert.deepEqual(result.servers[0].tools.map((tool) => tool.name), ["echo"]);
  assert.equal(result.servers[0].stderr.includes("secret-mcp-value"), false);
  assert.match(result.servers[0].stderr, /\[redacted\]/);
});

test("external MCP client calls configured tools and returns real content", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-client-call-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake-call",
    name: "Fake MCP Call",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir
  });

  const result = await callConfiguredMcpTool(baseDir, {
    serverId: "fake-call",
    mcpToolName: "echo",
    arguments: { text: "MCP_CALL_FACT" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.serverId, "fake-call");
  assert.equal(result.toolName, "echo");
  assert.match(result.content[0].text, /MCP_CALL_FACT/);
});

test("external MCP client lists and reads configured resources", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-client-resources-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake-resource",
    name: "Fake Resource MCP",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir
  });

  const listed = await listConfiguredMcpResources(baseDir, { serverId: "fake-resource" });
  const read = await readConfiguredMcpResource(baseDir, {
    serverId: "fake-resource",
    uri: "memo://facts"
  });

  assert.equal(listed.ok, true);
  assert.equal(listed.servers[0].resources[0].uri, "memo://facts");
  assert.equal(read.ok, true);
  assert.equal(read.uri, "memo://facts");
  assert.match(read.contents[0].text, /MCP_RESOURCE_FACT/);
});

test("external MCP client lists and gets configured prompts", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-client-prompts-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake-prompt",
    name: "Fake Prompt MCP",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir
  });

  const listed = await listConfiguredMcpPrompts(baseDir, { serverId: "fake-prompt" });
  const prompt = await getConfiguredMcpPrompt(baseDir, {
    serverId: "fake-prompt",
    promptName: "brief",
    arguments: { topic: "MCP_PROMPT_FACT" }
  });

  assert.equal(listed.ok, true);
  assert.equal(listed.servers[0].prompts[0].name, "brief");
  assert.equal(prompt.ok, true);
  assert.equal(prompt.promptName, "brief");
  assert.match(prompt.messages[0].content.text, /MCP_PROMPT_FACT/);
});

test("external MCP client reports missing and disabled servers honestly", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-client-missing-"));
  upsertMcpServerConfig(baseDir, {
    id: "disabled",
    name: "Disabled MCP",
    enabled: false,
    command: process.execPath,
    args: ["missing.js"],
    cwd: baseDir
  });

  const listed = await listConfiguredMcpTools(baseDir);
  const called = await callConfiguredMcpTool(baseDir, {
    serverId: "disabled",
    mcpToolName: "echo"
  });

  assert.equal(listed.ok, false);
  assert.equal(listed.code, "mcp_server_not_configured");
  assert.equal(called.ok, false);
  assert.equal(called.code, "mcp_server_not_configured");
});

test("mcp_call tool requires full permission and writes an audit log", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-tool-"));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-tool-base-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake-tool",
    name: "Fake MCP Tool",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir
  });

  const denied = await executeToolRequests({
    baseDir,
    permissionTier: "tool",
    groupPath,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "mcp_call", serverId: "fake-tool", mcpToolName: "echo", arguments: { text: "DENIED" }, reason: "Try MCP." }
    ]
  });
  const allowed = await executeToolRequests({
    baseDir,
    permissionTier: "full",
    groupPath,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "mcp_call", serverId: "fake-tool", mcpToolName: "echo", arguments: { text: "MCP_TOOL_FACT" }, reason: "Call MCP." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.match(allowed.results[0].result.content[0].text, /MCP_TOOL_FACT/);
  assert.equal(fs.existsSync(path.join(groupPath, "shared", "logs", "mcp.jsonl")), true);
});

test("MCP resource and prompt tool requests require full permission", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-resource-tool-"));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-resource-tool-base-"));
  const serverScript = writeFakeMcpServer(baseDir);
  upsertMcpServerConfig(baseDir, {
    id: "fake-extra",
    name: "Fake Extra MCP",
    command: process.execPath,
    args: [serverScript],
    cwd: baseDir
  });

  const denied = await executeToolRequests({
    baseDir,
    permissionTier: "tool",
    groupPath,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "mcp_read_resource", serverId: "fake-extra", uri: "memo://facts", reason: "Try resource." }
    ]
  });
  const allowed = await executeToolRequests({
    baseDir,
    permissionTier: "full",
    groupPath,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "mcp_read_resource", serverId: "fake-extra", uri: "memo://facts", reason: "Read resource." },
      { tool: "mcp_get_prompt", serverId: "fake-extra", promptName: "brief", arguments: { topic: "TOOL_PROMPT_FACT" }, reason: "Get prompt." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.results.length, 2);
  assert.deepEqual(allowed.results.map((item) => item.status), ["completed", "completed"]);
  assert.match(allowed.results[0].result.contents[0].text, /MCP_RESOURCE_FACT/);
  assert.match(allowed.results[1].result.messages[0].content.text, /TOOL_PROMPT_FACT/);
  assert.equal(fs.existsSync(path.join(groupPath, "shared", "logs", "mcp.jsonl")), true);
});

function writeFakeMcpServer(dir) {
  const filePath = path.join(dir, "fake-mcp-server.mjs");
  fs.writeFileSync(filePath, [
    "import readline from 'node:readline';",
    "if (process.env.MCP_SECRET) process.stderr.write(`secret=${process.env.MCP_SECRET}\\n`);",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "for await (const line of rl) {",
    "  if (!line.trim()) continue;",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'notifications/initialized') continue;",
    "  if (message.method === 'initialize') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo arguments', inputSchema: { type: 'object' } }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/call') {",
    "    const payload = { name: message.params?.name, arguments: message.params?.arguments || {} };",
    "    write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: message.params?.name !== 'echo' } });",
    "    continue;",
    "  }",
    "  if (message.method === 'resources/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'memo://facts', name: 'Facts', mimeType: 'text/plain' }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'resources/read') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: message.params?.uri, mimeType: 'text/plain', text: 'MCP_RESOURCE_FACT from ' + message.params?.uri }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'prompts/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { prompts: [{ name: 'brief', description: 'Write a brief', arguments: [{ name: 'topic' }] }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'prompts/get') {",
    "    const topic = message.params?.arguments?.topic || 'none';",
    "    write({ jsonrpc: '2.0', id: message.id, result: { description: 'Brief prompt', messages: [{ role: 'user', content: { type: 'text', text: 'Prompt topic: ' + topic } }] } });",
    "    continue;",
    "  }",
    "  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });",
    "}",
    "function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    ""
  ].join("\n"), "utf8");
  return filePath;
}
