import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { callConfiguredMcpTool, listConfiguredMcpTools } from "../src/mcpClient.js";
import { installMcpNpmServer, listMcpInstallCatalog, mcpInstallRoot, searchMcpNpmPackages, uninstallManagedMcpServer } from "../src/mcpInstall.js";
import { readMcpServerConfigs } from "../src/mcpConfig.js";
import { executeToolRequests } from "../src/toolRequests.js";

test("MCP install catalog reports presets without pretending they are installed", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-catalog-"));
  const catalog = listMcpInstallCatalog(baseDir);

  assert.equal(catalog.catalog.some((item) => item.id === "filesystem"), true);
  assert.equal(catalog.catalog.some((item) => item.id === "web-tools"), true);
  assert.equal(catalog.catalog.find((item) => item.id === "filesystem").installed, false);
  assert.equal(catalog.catalog.find((item) => item.id === "memory").serverConfigured, false);
});

test("built-in web MCP tools can be joined without npm install", async () => {
  const userDataBase = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-built-in-mcp-"));
  const installed = await installMcpNpmServer(userDataBase, {
    catalogId: "web-tools"
  });
  const listed = await listConfiguredMcpTools(userDataBase, {
    serverId: "web-tools"
  });
  const catalog = listMcpInstallCatalog(userDataBase);
  const server = readMcpServerConfigs(userDataBase).find((item) => item.id === "web-tools");

  assert.equal(installed.ok, true);
  assert.equal(installed.source, "built_in_mcp");
  assert.equal(server.source, "built_in");
  assert.deepEqual(listed.servers[0].tools.map((tool) => tool.name), ["web_search", "fetch_url"]);
  assert.equal(catalog.catalog.find((item) => item.id === "web-tools").installed, true);
  assert.match(installed.server.args[0], /mcpServer\.js/);
});

test("MCP npm search reads real registry payloads without fake installed state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /registry\.npmjs\.org\/-\/v1\/search/);
    return new Response(JSON.stringify({
      objects: [
        {
          package: {
            name: "@scope/mcp-search-tool",
            version: "1.2.3",
            description: "Search tool",
            keywords: ["mcp", "search"],
            date: "2026-07-10T00:00:00.000Z"
          },
          score: { final: 0.9 }
        }
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const result = await searchMcpNpmPackages("mcp search", { count: 3 });

    assert.equal(result.ok, true);
    assert.equal(result.source, "npm_registry_search");
    assert.equal(result.results[0].packageName, "@scope/mcp-search-tool");
    assert.equal(result.results[0].version, "1.2.3");
    assert.equal(result.results[0].installed, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP npm search reports registry failures honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("registry down", { status: 503 });
  try {
    const result = await searchMcpNpmPackages("mcp search");

    assert.equal(result.ok, false);
    assert.equal(result.source, "npm_registry_search");
    assert.equal(result.status, 503);
    assert.deepEqual(result.results, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mcp_search_npm tool requires full permission and returns registry results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    objects: [
      {
        package: {
          name: "agent-mcp-tool",
          version: "0.1.0",
          description: "Agent tool"
        },
        score: { final: 0.8 }
      }
    ]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-search-tool-group-"));
  try {
    const denied = await executeToolRequests({
      permissionTier: "tool",
      groupPath,
      agent: { id: "tool", name: "Tool" },
      round: 1,
      requests: [
        { tool: "mcp_search_npm", query: "agent mcp", reason: "Find MCP tools." }
      ]
    });
    const allowed = await executeToolRequests({
      permissionTier: "full",
      groupPath,
      agent: { id: "full", name: "Full" },
      round: 1,
      requests: [
        { tool: "mcp_search_npm", query: "agent mcp", reason: "Find MCP tools." }
      ]
    });

    assert.equal(denied.accepted.length, 0);
    assert.equal(denied.rejected[0].code, "permission_denied");
    assert.equal(allowed.results[0].status, "completed");
    assert.equal(allowed.results[0].result.results[0].packageName, "agent-mcp-tool");
    assert.equal(fs.existsSync(path.join(groupPath, "shared", "logs", "mcp.jsonl")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP npm installer installs a local package, registers config, and can call it", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-install-"));
  const packageDir = writeFakeMcpPackage(baseDir);

  const installed = await installMcpNpmServer(baseDir, {
    id: "fake-local",
    name: "Fake Local MCP",
    packageSpec: packageDir,
    binName: "fake-mcp",
    args: ["--flag"]
  });
  const configs = readMcpServerConfigs(baseDir);
  const called = await callConfiguredMcpTool(baseDir, {
    serverId: "fake-local",
    mcpToolName: "echo",
    arguments: { text: "MCP_INSTALL_FACT" }
  });

  assert.equal(installed.ok, true);
  assert.equal(installed.server.id, "fake-local");
  assert.equal(installed.install.packageName, "fake-mcp-package");
  assert.equal(fs.existsSync(path.join(mcpInstallRoot(baseDir), "fake-local", "install-record.json")), true);
  assert.equal(configs[0].source, "managed_npm");
  assert.equal(configs[0].install.packageName, "fake-mcp-package");
  assert.equal(called.ok, true);
  assert.match(called.content[0].text, /MCP_INSTALL_FACT/);
});

test("MCP npm installer reports packages without bin honestly", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-install-nobin-"));
  const packageDir = path.join(baseDir, "no-bin-package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "no-bin-package",
    version: "1.0.0"
  }), "utf8");

  const result = await installMcpNpmServer(baseDir, {
    id: "no-bin",
    packageSpec: packageDir
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "mcp_package_has_no_bin");
});

test("MCP uninstall removes managed install directory and config", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-uninstall-"));
  const packageDir = writeFakeMcpPackage(baseDir);
  await installMcpNpmServer(baseDir, {
    id: "remove-me",
    name: "Remove Me",
    packageSpec: packageDir,
    binName: "fake-mcp"
  });

  const removed = uninstallManagedMcpServer(baseDir, { serverId: "remove-me" });

  assert.equal(removed.ok, true);
  assert.equal(removed.removedInstallDir, true);
  assert.equal(removed.config.deleted, true);
  assert.equal(fs.existsSync(path.join(mcpInstallRoot(baseDir), "remove-me")), false);
  assert.deepEqual(readMcpServerConfigs(baseDir), []);
});

test("mcp_install_npm tool requires full permission and can install then call", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-install-tool-group-"));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-install-tool-base-"));
  const packageDir = writeFakeMcpPackage(baseDir);

  const denied = await executeToolRequests({
    baseDir,
    permissionTier: "tool",
    groupPath,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "mcp_install_npm", serverId: "tool-install", packageSpec: packageDir, binName: "fake-mcp", reason: "Try install." }
    ]
  });
  const allowed = await executeToolRequests({
    baseDir,
    permissionTier: "full",
    groupPath,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "mcp_install_npm", serverId: "tool-install", packageSpec: packageDir, binName: "fake-mcp", reason: "Install MCP." },
      { tool: "mcp_call", serverId: "tool-install", mcpToolName: "echo", arguments: { text: "MCP_INSTALL_TOOL_FACT" }, reason: "Call installed MCP." },
      { tool: "mcp_uninstall", serverId: "tool-install", reason: "Remove installed MCP." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.deepEqual(allowed.results.map((item) => item.status), ["completed", "completed", "completed"]);
  assert.match(allowed.results[1].result.content[0].text, /MCP_INSTALL_TOOL_FACT/);
  assert.equal(allowed.results[2].result.removedInstallDir, true);
  assert.equal(fs.existsSync(path.join(groupPath, "shared", "logs", "mcp.jsonl")), true);
});

function writeFakeMcpPackage(root) {
  const packageDir = path.join(root, `fake-mcp-package-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "fake-mcp-package",
    version: "1.0.0",
    type: "module",
    bin: {
      "fake-mcp": "server.mjs"
    }
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(packageDir, "server.mjs"), [
    "#!/usr/bin/env node",
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "for await (const line of rl) {",
    "  if (!line.trim()) continue;",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'notifications/initialized') continue;",
    "  if (message.method === 'initialize') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-installed', version: '1.0.0' } } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/call') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments || {}) }], isError: false } });",
    "    continue;",
    "  }",
    "  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });",
    "}",
    "function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    ""
  ].join("\n"), "utf8");
  return packageDir;
}
