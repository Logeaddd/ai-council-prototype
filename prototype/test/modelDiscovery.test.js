import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviderModels, checkProviderHealth, clearModelDiscoveryCache } from "../src/modelDiscovery.js";
import { findProviderPreset, listProviderPresets, resolveProviderBaseUrl } from "../src/providerRegistry.js";

test("provider registry exposes official OpenAI-compatible presets with custom override", () => {
  const presets = listProviderPresets();
  assert.ok(presets.some((preset) => preset.id === "deepseek" && preset.officialBaseUrl === "https://api.deepseek.com/v1"));
  assert.ok(presets.some((preset) => preset.id === "anthropic" && preset.transport === "anthropic-messages"));
  assert.ok(presets.some((preset) => preset.id === "custom" && preset.customUrl));
  assert.equal(findProviderPreset("openai").transport, "openai-compatible");
  assert.equal(resolveProviderBaseUrl("deepseek", "https://proxy.example/v1"), "https://proxy.example/v1");
});

test("model discovery reports real response and cache sources", async () => {
  clearModelDiscoveryCache();
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer test-key");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model", owned_by: "unit" }] }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const first = await discoverProviderModels({
      providerId: "custom",
      apiBaseUrl,
      apiKey: "test-key",
      allowUnsafePrivateNetwork: true
    });
    const second = await discoverProviderModels({
      providerId: "custom",
      apiBaseUrl,
      apiKey: "test-key",
      allowUnsafePrivateNetwork: true
    });
    assert.equal(first.ok, true);
    assert.equal(first.source, "real_response");
    assert.deepEqual(first.models.map((model) => model.id), ["a-model", "z-model"]);
    assert.equal(second.source, "cache");
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("provider health marks timeout inference without pretending success", async () => {
  clearModelDiscoveryCache();
  const server = http.createServer(() => {});
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const health = await checkProviderHealth({
      providerId: "custom",
      apiBaseUrl,
      timeoutMs: 100,
      useCache: false,
      allowUnsafePrivateNetwork: true
    });
    assert.equal(health.ok, false);
    assert.equal(health.source, "timeout_inference");
    assert.match(health.error, /Timed out/);
  } finally {
    await close(server);
  }
});

test("model discovery explains invalid keys and HTML endpoints plainly", async () => {
  clearModelDiscoveryCache();
  const server = http.createServer((req, res) => {
    if (req.url === "/html/models") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not api</html>");
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid token" }));
  });
  await listen(server);
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    const unauthorized = await discoverProviderModels({
      providerId: "custom",
      apiBaseUrl: `${base}/v1`,
      apiKey: "bad-key",
      allowUnsafePrivateNetwork: true,
      useCache: false
    });
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.error, /密钥无效/);

    const html = await discoverProviderModels({
      providerId: "custom",
      apiBaseUrl: `${base}/html`,
      allowUnsafePrivateNetwork: true,
      useCache: false
    });
    assert.equal(html.ok, false);
    assert.match(html.error, /不是模型 API/);
  } finally {
    await close(server);
  }
});

test("Anthropic model discovery uses official API key headers", async () => {
  clearModelDiscoveryCache();
  let requestHeaders;
  const server = http.createServer((req, res) => {
    requestHeaders = req.headers;
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-test-model" }] }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const result = await discoverProviderModels({
      providerId: "anthropic",
      apiBaseUrl,
      apiKey: "anthropic-test-key",
      allowUnsafePrivateNetwork: true,
      useCache: false
    });
    assert.equal(requestHeaders["x-api-key"], "anthropic-test-key");
    assert.equal(requestHeaders["anthropic-version"], "2023-06-01");
    assert.equal(requestHeaders.authorization, undefined);
    assert.equal(result.ok, true);
    assert.deepEqual(result.models.map((model) => model.id), ["claude-test-model"]);
  } finally {
    await close(server);
  }
});

test("model discovery blocks metadata and private network base URLs", async () => {
  const metadata = await discoverProviderModels({
    providerId: "custom",
    apiBaseUrl: "http://169.254.169.254/latest",
    apiKey: "test-key",
    useCache: false
  });
  assert.equal(metadata.ok, false);
  assert.equal(metadata.source, "error");
  assert.match(metadata.error, /Blocked unsafe API base URL/);

  const privateLan = await discoverProviderModels({
    providerId: "custom",
    apiBaseUrl: "http://10.0.0.2/v1",
    apiKey: "test-key",
    useCache: false
  });
  assert.equal(privateLan.ok, false);
  assert.equal(privateLan.source, "error");
  assert.match(privateLan.error, /Blocked unsafe API base URL/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
