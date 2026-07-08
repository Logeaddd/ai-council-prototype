import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { listCapabilities } from "../src/capabilityRegistry.js";
import { assertSafePublicUrl, fetchPublicUrl, searchWeb } from "../src/webTools.js";
import { executeToolRequests } from "../src/toolRequests.js";

test("capability registry reports web search as unconfigured without a real key", () => {
  const capabilities = listCapabilities({ env: {} });
  const search = capabilities.find((item) => item.id === "web-search");
  const fetchUrl = capabilities.find((item) => item.id === "fetch-url");
  const apiRequest = capabilities.find((item) => item.id === "api-request");
  const extractArchive = capabilities.find((item) => item.id === "extract-archive");
  const executeCommand = capabilities.find((item) => item.id === "execute-command");
  const runCode = capabilities.find((item) => item.id === "run-code");
  const installPackage = capabilities.find((item) => item.id === "install-package");
  const runTests = capabilities.find((item) => item.id === "run-tests");
  const gitOperation = capabilities.find((item) => item.id === "git-operation");
  const browserControl = capabilities.find((item) => item.id === "browser-control");
  const databaseQuery = capabilities.find((item) => item.id === "database-query");
  const mcpWebTools = capabilities.find((item) => item.id === "mcp-web-tools");
  const mcpMarketplace = capabilities.find((item) => item.id === "mcp-marketplace");

  assert.equal(search.status, "needs_config");
  assert.equal(search.enabled, false);
  assert.match(search.requirement, /BRAVE_SEARCH_API_KEY/);
  assert.equal(fetchUrl.status, "ready");
  assert.equal(fetchUrl.enabled, true);
  assert.equal(apiRequest.status, "ready");
  assert.equal(apiRequest.enabled, true);
  assert.equal(extractArchive.status, "ready");
  assert.match(extractArchive.requirement, /full permission/);
  assert.equal(executeCommand.status, "ready");
  assert.equal(executeCommand.enabled, true);
  assert.match(executeCommand.requirement, /完全允许/);
  assert.equal(runCode.status, "ready");
  assert.equal(runCode.enabled, true);
  assert.match(runCode.requirement, /完全允许/);
  assert.equal(installPackage.status, "ready");
  assert.equal(installPackage.enabled, true);
  assert.match(installPackage.requirement, /完全允许/);
  assert.equal(runTests.status, "ready");
  assert.equal(runTests.enabled, true);
  assert.equal(gitOperation.status, "ready");
  assert.equal(gitOperation.enabled, true);
  assert.match(runTests.requirement, /完全允许/);
  assert.match(gitOperation.requirement, /完全允许/);
  assert.equal(browserControl.status, "ready");
  assert.equal(browserControl.enabled, true);
  assert.match(browserControl.requirement, /完全允许/);
  assert.equal(databaseQuery.status, "ready");
  assert.equal(databaseQuery.enabled, true);
  assert.equal(mcpWebTools.status, "ready");
  assert.equal(mcpWebTools.enabled, true);
  assert.equal(mcpWebTools.source, "local_stdio");
  assert.equal(mcpWebTools.command, "npm run mcp:web");
  assert.deepEqual(mcpWebTools.tools, ["web_search", "fetch_url"]);
  assert.match(mcpWebTools.requirement, /Brave Search key/);
  assert.equal(mcpMarketplace.status, "planned");
  assert.equal(mcpMarketplace.enabled, false);
  assert.match(databaseQuery.requirement, /工具授权/);
});

test("capability registry accepts a locally stored search key", () => {
  const capabilities = listCapabilities({
    env: {},
    appSettings: {
      capabilities: {
        webSearch: {
          apiKey: "local-search-secret"
        }
      }
    }
  });
  const search = capabilities.find((item) => item.id === "web-search");

  assert.equal(search.status, "ready");
  assert.equal(search.enabled, true);
  assert.equal(search.source, "configured_local");
  assert.equal(JSON.stringify(search).includes("local-search-secret"), false);
});

test("web search returns not_configured instead of fake results without key", async () => {
  const result = await searchWeb("ai council", { env: {} });

  assert.equal(result.ok, false);
  assert.equal(result.source, "not_configured");
  assert.deepEqual(result.results, []);
});

test("web search can use an explicit key without leaking it in the result", async () => {
  const originalFetch = globalThis.fetch;
  let receivedToken = "";
  globalThis.fetch = async (_url, options = {}) => {
    receivedToken = options.headers?.["X-Subscription-Token"] || "";
    return new Response(JSON.stringify({
      web: {
        results: [
          {
            title: "Real result",
            url: "https://example.com/real",
            description: "A real response fixture"
          }
        ]
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const result = await searchWeb("ai council", { env: {}, apiKey: "brave-live-secret" });

    assert.equal(receivedToken, "brave-live-secret");
    assert.equal(result.ok, true);
    assert.equal(result.source, "real_response");
    assert.equal(result.results[0].title, "Real result");
    assert.equal(JSON.stringify(result).includes("brave-live-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public URL guard rejects metadata and localhost addresses", async () => {
  await assert.rejects(() => assertSafePublicUrl("https://169.254.169.254/latest"), /Blocked unsafe URL/);
  await assert.rejects(() => assertSafePublicUrl("http://127.0.0.1:4317"), /Blocked unsafe URL/);
});

test("fetchPublicUrl reads real text with explicit unsafe allowance only for tests", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><title>Hello Page</title><body><h1>Hello</h1><p>Real content.</p></body></html>");
  });
  await listen(server);
  const address = server.address();
  try {
    const result = await fetchPublicUrl(`http://127.0.0.1:${address.port}/`, {
      allowUnsafePrivateNetwork: true,
      allowHttp: true,
      timeoutMs: 1000
    });
    assert.equal(result.ok, true);
    assert.equal(result.title, "Hello Page");
    assert.match(result.text, /Real content/);
  } finally {
    await close(server);
  }
});

test("tool requests require tool permission and report unconfigured search honestly", async () => {
  const textOnly = await executeToolRequests({
    permissionTier: "text",
    agent: { id: "a", name: "A" },
    round: 1,
    requests: [{ tool: "web_search", query: "news", reason: "Need current info" }],
    env: {}
  });
  const toolTier = await executeToolRequests({
    permissionTier: "tool",
    agent: { id: "a", name: "A" },
    round: 1,
    requests: [{ tool: "web_search", query: "news", reason: "Need current info" }],
    env: {}
  });

  assert.equal(textOnly.accepted.length, 0);
  assert.equal(textOnly.rejected[0].code, "permission_denied");
  assert.equal(toolTier.accepted.length, 1);
  assert.equal(toolTier.results[0].status, "not_configured");
  assert.equal(toolTier.results[0].result.source, "not_configured");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
