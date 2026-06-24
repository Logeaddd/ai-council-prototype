import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverProviderModels, checkProviderHealth, clearModelDiscoveryCache } from "../src/modelDiscovery.js";
import { findProviderPreset, listProviderPresets, resolveProviderBaseUrl } from "../src/providerRegistry.js";

test("provider registry exposes official OpenAI-compatible presets with custom override", () => {
  const presets = listProviderPresets();
  assert.ok(presets.some((preset) => preset.id === "deepseek" && preset.officialBaseUrl === "https://api.deepseek.com/v1"));
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
    const first = await discoverProviderModels({ providerId: "custom", apiBaseUrl, apiKey: "test-key" });
    const second = await discoverProviderModels({ providerId: "custom", apiBaseUrl, apiKey: "test-key" });
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
    const health = await checkProviderHealth({ providerId: "custom", apiBaseUrl, timeoutMs: 100, useCache: false });
    assert.equal(health.ok, false);
    assert.equal(health.source, "timeout_inference");
    assert.match(health.error, /Timed out/);
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
