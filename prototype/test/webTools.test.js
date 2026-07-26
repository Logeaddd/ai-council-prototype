import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { listCapabilities } from "../src/capabilityRegistry.js";
import { assertSafePublicUrl, fetchPublicUrl, searchWeb } from "../src/webTools.js";
import { executeToolRequests } from "../src/toolRequests.js";

const VERIFIED_RUNTIME = {
  webRuntime: true,
  filesystem: true,
  archiveRuntime: true,
  shell: true,
  shellDetail: "verified shell",
  backgroundRuntime: true,
  codeRuntime: true,
  codeRuntimeDetail: "verified node",
  packageRuntime: true,
  packageRuntimeDetail: "verified npm",
  provisionRuntime: true,
  provisionRuntimeDetail: "verified installer",
  testRuntime: true,
  testRuntimeDetail: "verified test runtime",
  git: true,
  gitDetail: "verified git",
  browser: true,
  browserDetail: "verified browser",
  database: true,
  databaseDetail: "verified sqlite",
  memoryRuntime: true,
  skillRuntime: true,
  mcpRuntime: true,
  mcpRuntimeDetail: "verified MCP runtime",
  mcpMarketplaceRuntime: true,
  mcpMarketplaceDetail: "verified npm"
};

test("capability registry distinguishes local verification from external-service verification", () => {
  const capabilities = listCapabilities({ env: {}, runtimeFacts: VERIFIED_RUNTIME });
  const search = capabilities.find((item) => item.id === "web-search");
  const fetchUrl = capabilities.find((item) => item.id === "fetch-url");
  const apiRequest = capabilities.find((item) => item.id === "api-request");
  const extractArchive = capabilities.find((item) => item.id === "extract-archive");
  const executeCommand = capabilities.find((item) => item.id === "execute-command");
  const runCode = capabilities.find((item) => item.id === "run-code");
  const installPackage = capabilities.find((item) => item.id === "install-package");
  const provisionTool = capabilities.find((item) => item.id === "provision-tool");
  const runTests = capabilities.find((item) => item.id === "run-tests");
  const gitOperation = capabilities.find((item) => item.id === "git-operation");
  const browserControl = capabilities.find((item) => item.id === "browser-control");
  const databaseQuery = capabilities.find((item) => item.id === "database-query");
  const mcpWebTools = capabilities.find((item) => item.id === "mcp-web-tools");
  const mcpMarketplace = capabilities.find((item) => item.id === "mcp-marketplace");

  assert.equal(search.status, "unverified");
  assert.equal(search.enabled, true);
  assert.equal(search.provider, "Bing Web");
  assert.equal(search.source, "built_in_html");
  assert.equal(fetchUrl.status, "unverified");
  assert.equal(fetchUrl.enabled, true);
  assert.equal(apiRequest.status, "unverified");
  assert.equal(apiRequest.enabled, true);
  assert.equal(extractArchive.status, "ready");
  assert.match(extractArchive.requirement, /完全权限/);
  assert.equal(executeCommand.status, "ready");
  assert.equal(executeCommand.enabled, true);
  assert.match(executeCommand.requirement, /完全权限/);
  assert.equal(runCode.status, "ready");
  assert.equal(runCode.enabled, true);
  assert.match(runCode.requirement, /完全权限/);
  assert.equal(installPackage.status, "ready");
  assert.equal(installPackage.enabled, true);
  assert.match(installPackage.requirement, /完全权限/);
  assert.equal(provisionTool.status, "ready");
  assert.equal(runTests.status, "ready");
  assert.equal(runTests.enabled, true);
  assert.equal(gitOperation.status, "ready");
  assert.equal(gitOperation.enabled, true);
  assert.match(runTests.requirement, /完全权限/);
  assert.match(gitOperation.requirement, /完全权限/);
  assert.equal(browserControl.status, "ready");
  assert.equal(browserControl.enabled, true);
  assert.match(browserControl.requirement, /完全权限/);
  assert.equal(databaseQuery.status, "ready");
  assert.equal(databaseQuery.enabled, true);
  assert.equal(mcpWebTools.status, "ready");
  assert.equal(mcpWebTools.enabled, true);
  assert.equal(mcpWebTools.source, "local_stdio");
  assert.equal(mcpWebTools.command, "npm run mcp:web");
  assert.deepEqual(mcpWebTools.tools, ["web_search", "fetch_url"]);
  assert.match(mcpWebTools.requirement, /MCP stdio/);
  assert.equal(mcpMarketplace.status, "unverified");
  assert.equal(mcpMarketplace.enabled, true);
  assert.equal(mcpMarketplace.source, "local_installer");
  assert.match(databaseQuery.requirement, /工具权限/);
  assert.equal(executeCommand.health.localVerified, true);
  assert.equal(search.health.externalVerified, false);
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
    },
    runtimeFacts: VERIFIED_RUNTIME
  });
  const search = capabilities.find((item) => item.id === "web-search");

  assert.equal(search.status, "unverified");
  assert.equal(search.enabled, true);
  assert.equal(search.source, "configured_local");
  assert.equal(JSON.stringify(search).includes("local-search-secret"), false);
});

test("capability registry reports global switches from the same execution policy", () => {
  const capabilities = listCapabilities({
    env: {},
    appSettings: { capabilities: { toolAccess: { web: false, automation: false } } },
    runtimeFacts: VERIFIED_RUNTIME
  });

  assert.equal(capabilities.find((item) => item.id === "web-search").enabled, false);
  assert.equal(capabilities.find((item) => item.id === "fetch-url").enabled, false);
  assert.equal(capabilities.find((item) => item.id === "execute-command").enabled, false);
  assert.equal(capabilities.find((item) => item.id === "workspace-files").enabled, true);
});

test("capability registry reports missing local prerequisites as unavailable", () => {
  const runtimeFacts = Object.fromEntries(Object.entries(VERIFIED_RUNTIME).map(([key, value]) => [key, typeof value === "boolean" ? false : "missing"]));
  const capabilities = listCapabilities({ env: {}, runtimeFacts });

  assert.equal(capabilities.find((item) => item.id === "execute-command").status, "unavailable");
  assert.equal(capabilities.find((item) => item.id === "browser-control").status, "unavailable");
  assert.equal(capabilities.find((item) => item.id === "database-query").status, "unavailable");
  assert.equal(capabilities.find((item) => item.id === "mcp-marketplace").status, "unavailable");
});

test("disabled capabilities reject real tool requests before execution and remain audited", async () => {
  const groupPath = fs.mkdtempSync(path.join(process.env.TEMP || ".", "ai-council-capability-gate-"));
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    appSettings: { capabilities: { toolAccess: { web: false, automation: false } } },
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "web_search", query: "must not run", reason: "Check disabled web." },
      { tool: "execute_command", command: "echo MUST_NOT_RUN", reason: "Check disabled terminal." }
    ]
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.code), ["capability_disabled", "capability_disabled"]);
  assert.deepEqual(result.rejected.map((item) => item.capabilityId), ["web", "automation"]);
  assert.equal(result.events.every((item) => item.type === "tool_failure"), true);
  const audit = fs.readFileSync(path.join(groupPath, "shared", "logs", "tools.jsonl"), "utf8");
  assert.match(audit, /"capabilityId":"web"/);
  assert.match(audit, /"capabilityId":"automation"/);
  assert.doesNotMatch(audit, /MUST_NOT_RUN.*completed/);
});

test("disabled MCP and web families reject MCP calls at the real tool boundary", async () => {
  const groupPath = fs.mkdtempSync(path.join(process.env.TEMP || ".", "ai-council-mcp-capability-gate-"));
  const mcpDisabled = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    appSettings: { capabilities: { toolAccess: { mcp: false } } },
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "mcp_call", serverId: "missing", mcpToolName: "echo", arguments: {}, reason: "Must stop before runtime lookup." }]
  });
  const webDisabled = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    appSettings: { capabilities: { toolAccess: { mcp: true, web: false } } },
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "mcp_call", serverId: "web-tools", mcpToolName: "web_search", arguments: { query: "must not run" }, reason: "Must stop before web access." }]
  });

  assert.equal(mcpDisabled.results.length, 0);
  assert.equal(mcpDisabled.rejected[0].code, "capability_disabled");
  assert.equal(mcpDisabled.rejected[0].capabilityId, "mcp");
  assert.equal(webDisabled.results.length, 0);
  assert.equal(webDisabled.rejected[0].code, "capability_disabled");
  assert.equal(webDisabled.rejected[0].capabilityId, "web");
  const audit = fs.readFileSync(path.join(groupPath, "shared", "logs", "mcp.jsonl"), "utf8");
  assert.match(audit, /"capabilityId":"mcp"/);
  assert.match(audit, /"capabilityId":"web"/);
});

test("web search uses built-in public HTML search without key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /bing\.com\/search/);
    return new Response(`
      <html><body>
        <li class="b_algo">
          <h2><a href="https://example.com/council">AI &amp; Council</a></h2>
          <p>Built in search result.</p>
        </li>
      </body></html>
    `, {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
  };
  try {
    const result = await searchWeb("ai council", { env: {} });

    assert.equal(result.ok, true);
    assert.equal(result.source, "public_html");
    assert.equal(result.provider, "Bing Web");
    assert.equal(result.results[0].title, "AI & Council");
    assert.equal(result.results[0].url, "https://example.com/council");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search can use a configured built-in HTML search endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /127\.0\.0\.1:47899\/search/);
    assert.match(String(url), /q=ai\+council/);
    return new Response(`
      <html><body>
        <li class="b_algo">
          <h2><a href="https://example.com/custom-search">Custom AI Council Search</a></h2>
          <p>Configured AI council endpoint result.</p>
        </li>
      </body></html>
    `, {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
  };
  try {
    const result = await searchWeb("ai council", {
      env: { AI_COUNCIL_BUILTIN_SEARCH_URL: "http://127.0.0.1:47899/search" }
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, "public_html");
    assert.equal(result.results[0].title, "Custom AI Council Search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search reports built-in search failure honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("blocked", { status: 503 });
  try {
    const result = await searchWeb("ai council", { env: {} });

    assert.equal(result.ok, false);
    assert.equal(result.source, "public_html");
    assert.equal(result.provider, "Bing Web");
    assert.equal(result.status, 503);
    assert.deepEqual(result.results, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search degrades an empty HTML result page instead of treating HTTP 200 as usable evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><body>No matching results.</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
  try {
    const result = await searchWeb("minecraft rabbit mod", { env: {} });

    assert.equal(result.ok, false);
    assert.equal(result.code, "search_no_results");
    assert.equal(result.health.status, "degraded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search degrades challenge and consent pages", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html><body>Verify that you are human to continue.</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
    const challenge = await searchWeb("minecraft rabbit mod", { env: {} });
    assert.equal(challenge.ok, false);
    assert.equal(challenge.code, "search_challenge_required");

    globalThis.fetch = async () => new Response("<html><body>Before you continue to Bing, accept cookie consent.</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
    const consent = await searchWeb("minecraft rabbit mod", { env: {} });
    assert.equal(consent.ok, false);
    assert.equal(consent.code, "search_consent_required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search degrades site-constrained results that never reach the requested site", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><body>
      <li class="b_algo"><h2><a href="https://www.minecraft.net/en-us">Minecraft Official</a></h2><p>Minecraft game information and downloads.</p></li>
      <li class="b_algo"><h2><a href="https://minecraft.wiki">Minecraft Wiki</a></h2><p>General Minecraft encyclopedia.</p></li>
    </body></html>
  `, {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
  try {
    const result = await searchWeb("site:curseforge.com minecraft rabbit bunny mod", { env: {} });

    assert.equal(result.ok, false);
    assert.equal(result.code, "search_site_constraint_unmet");
    assert.equal(result.health.expectedDomain, "curseforge.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search preserves relevant multi-term results and records deterministic health evidence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><body>
      <li class="b_algo"><h2><a href="https://www.curseforge.com/minecraft/mc-mods/rabbits">Minecraft Rabbit Mod</a></h2><p>A bunny mod that adds rabbit pets for Minecraft.</p></li>
    </body></html>
  `, {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
  try {
    const result = await searchWeb("site:curseforge.com minecraft rabbit bunny mod", { env: {} });

    assert.equal(result.ok, true);
    assert.equal(result.health.status, "healthy");
    assert.equal(result.health.domainMatches, 1);
    assert.equal(result.health.relevantResults, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
            title: "AI Council result",
            url: "https://example.com/real",
            description: "A real AI council response fixture"
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
    assert.equal(result.results[0].title, "AI Council result");
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

test("tool requests require tool permission and run built-in search", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html><body>
      <li class="b_algo">
        <h2><a href="https://example.com/news">News</a></h2>
        <p>News result.</p>
      </li>
    </body></html>
  `, {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
  const textOnly = await executeToolRequests({
    permissionTier: "text",
    agent: { id: "a", name: "A" },
    round: 1,
    requests: [{ tool: "web_search", query: "news", reason: "Need current info" }],
    env: {}
  });
  try {
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
    assert.equal(toolTier.results[0].status, "completed");
    assert.equal(toolTier.results[0].result.source, "public_html");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
