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
  const extractArchive = capabilities.find((item) => item.id === "extract-archive");

  assert.equal(search.status, "needs_config");
  assert.equal(search.enabled, false);
  assert.match(search.requirement, /BRAVE_SEARCH_API_KEY/);
  assert.equal(fetchUrl.status, "ready");
  assert.equal(fetchUrl.enabled, true);
  assert.equal(extractArchive.status, "ready");
  assert.match(extractArchive.requirement, /full permission/);
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
