import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCapabilityFacts, recordCapabilityToolResults } from "../src/capabilityFacts.js";
import { listCapabilities } from "../src/capabilityRegistry.js";
import { executeToolRequests } from "../src/toolRequests.js";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-capability-facts-"));
}

const VERIFIED_RUNTIME = {
  webRuntime: true, filesystem: true, archiveRuntime: true, shell: true, shellDetail: "test shell",
  backgroundRuntime: true, codeRuntime: true, codeRuntimeDetail: "test node", packageRuntime: true, packageRuntimeDetail: "test npm",
  provisionRuntime: true, provisionRuntimeDetail: "test provision", testRuntime: true, testRuntimeDetail: "test runner",
  git: true, gitDetail: "test git", browser: true, browserDetail: "test browser", database: true, databaseDetail: "test sqlite",
  memoryRuntime: true, skillRuntime: true, mcpRuntime: true, mcpRuntimeDetail: "test mcp", mcpMarketplaceRuntime: true, mcpMarketplaceDetail: "test npm"
};

test("actual successful web use upgrades the core capability from unverified to ready", () => {
  const groupPath = workspace();
  recordCapabilityToolResults({
    groupPath,
    agent: { id: "builder" },
    accepted: [{ id: "search-1", tool: "web_search", query: "agent runtime" }],
    results: [{ id: "search-1", tool: "web_search", status: "completed", result: { ok: true, source: "bing_html", results: [{ title: "result" }] } }]
  });
  const facts = listCapabilityFacts(groupPath);
  assert.equal(facts.find((item) => item.id === "core:web-search").status, "ready");
  const search = listCapabilities({ env: {}, groupPath, runtimeFacts: VERIFIED_RUNTIME }).find((item) => item.id === "web-search");
  assert.equal(search.status, "ready");
  assert.equal(search.health.externalVerified, true);
  assert.equal(search.lifecycle.lastTool, "web_search");
});

test("real tool execution records package and runtime acquisition facts without promoting them to fake UI capabilities", async () => {
  const groupPath = workspace();
  const outcome = await executeToolRequests({
    groupPath,
    permissionTier: "full",
    requests: [{ tool: "run_code", language: "javascript", code: "console.log('capability-fact-ok')", reason: "Exercise the local code runtime." }]
  });
  assert.equal(outcome.results[0].status, "completed");
  const fact = listCapabilityFacts(groupPath).find((item) => item.id === "core:run-code");
  assert.equal(fact.status, "ready");
  assert.equal(fact.lastTool, "run_code");
});
