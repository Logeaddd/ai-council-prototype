import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTaskSpecificChecks, runRealProviderBenchmark } from "../src/realProviderBenchmark.js";

test("real-provider benchmark requires explicit caps, real providers, and pricing", async () => {
  const workspace = createWorkspace();
  await assert.rejects(() => runRealProviderBenchmark({
    group: { agents: [{ id: "a", enabled: true, provider: "mock" }] },
    task: { prompt: "Task" },
    workspaceTemplate: workspace,
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-out-")),
    maxCostUsd: 1,
    maxModelCalls: 1000
  }), (error) => error.code === "mock_provider_denied");
});

test("real-provider benchmark writes an isolated usage and cost report", async () => {
  const workspace = createWorkspace();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-report-"));
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    const finalCall = JSON.stringify(body.messages || []).includes("FinalDecision JSON object");
    const text = finalCall
      ? JSON.stringify({ answer: "Verified.", consensus_score: 1, supporting_agents: ["Builder"], dissenting_agents: [], minority_report: "", risks: [], next_actions: [], selected_file_operation_ids: [], memory_candidates: [] })
      : JSON.stringify({
        status: "skip",
        reason: "No objection.",
        task_contract: {
          mode: "discussion",
          objective: "Assess the current project state.",
          requires_workspace: false,
          requires_verification: false,
          deliverables: [],
          completion_criteria: ["Provide the assessment."],
          next_action: "Contribute the assessment to the final synthesis."
        }
      });
    writeOpenAiStream(res, text, { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 });
  });
  await listen(server);
  try {
    const group = benchmarkGroup(server.address().port);
    const run = await runRealProviderBenchmark({
      group,
      task: { id: "smoke", title: "Smoke", prompt: "Assess the current project state." },
      workspaceTemplate: workspace,
      outputDir,
      maxCostUsd: 0.1,
      maxModelCalls: 4
    });
    assert.equal(run.report.status, "passed");
    assert.equal(run.report.accounting.tokenSource, "provider_usage");
    assert.equal(run.report.accounting.modelCalls, 2);
    assert.equal(run.report.accounting.inputTokens, 40);
    assert.equal(run.report.accounting.outputTokens, 10);
    assert.ok(run.report.accounting.costUsd > 0);
    assert.equal(fs.existsSync(path.join(run.runDir, "report.json")), true);
    assert.notEqual(run.workspacePath, workspace);
  } finally {
    await close(server);
  }
});

test("real-provider benchmark aborts before a request that would exceed the cost cap", async () => {
  const workspace = createWorkspace();
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {}
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Unexpected" }), { prompt_tokens: 1, completion_tokens: 1 });
  });
  await listen(server);
  try {
    const group = benchmarkGroup(server.address().port);
    group.agents.forEach((agent) => { agent.maxTokens = 64000; });
    const run = await runRealProviderBenchmark({
      group,
      task: { id: "cap", prompt: "Assess the project." },
      workspaceTemplate: workspace,
      outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-cap-")),
      maxCostUsd: 0.000001,
      maxModelCalls: 4
    });
    assert.equal(run.report.status, "cost_cap_exceeded");
    assert.equal(requestCount, 0);
  } finally {
    await close(server);
  }
});

test("Forge benchmark cannot pass with an unrelated JAR or missing task behavior", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-checks-"));
  const missing = evaluateTaskSpecificChecks({ id: "forge-1.20.1-random-surface" }, workspace, {
    toolExecutionResults: [],
    finalDecision: { requested_artifact_verification: { status: "verified" } }
  });
  assert.equal(missing.passed, false);
  assert.equal(missing.checks.find((item) => item.id === "java_source_present").passed, false);

  const sourcePath = path.join(workspace, "src", "main", "java", "Mod.java");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `
    class Mod {
      void onPlayerTick(PlayerTickEvent event, ChunkPos chunk) {
        long cooldown = 5 * 60 * 20;
        for (int layer = 0; layer < 2; layer++) {
          var block = ForgeRegistries.BLOCKS.getValues().stream().skip(Random.nextInt()).findFirst();
        }
      }
    }
  `, "utf8");
  const complete = evaluateTaskSpecificChecks({ id: "forge-1.20.1-random-surface" }, workspace, {
    toolExecutionResults: [{ tool: "execute_command", status: "completed", command: ".\\gradlew.bat build", result: { exitCode: 0 } }],
    finalDecision: { requested_artifact_verification: { status: "verified" } }
  });
  assert.equal(complete.passed, true);
});

function benchmarkGroup(port) {
  const apiBaseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    id: "benchmark-group",
    name: "Benchmark Group",
    settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 2000 },
    agents: [
      { id: "builder", name: "Builder", role: "Builder", provider: "openai-compatible", apiBaseUrl, allowUnsafePrivateNetwork: true, apiKey: "test-key", model: "test-model", weight: 1, enabled: true, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, maxTokens: 100 },
      { id: "judge", name: "Judge", role: "Judge", provider: "openai-compatible", apiBaseUrl, allowUnsafePrivateNetwork: true, apiKey: "test-key", model: "test-model", weight: 1, enabled: true, judge: true, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, maxTokens: 100 }
    ]
  };
}

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-workspace-"));
  fs.mkdirSync(path.join(workspace, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "group.json"), JSON.stringify({
    id: "benchmark-workspace",
    name: "Benchmark Workspace",
    permissions: { defaultTier: "text" },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "judge", displayName: "Judge", enabled: true, judge: true, privateFolder: "members/Judge" }
    ]
  }), "utf8");
  return workspace;
}

function writeOpenAiStream(res, text, usage) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readRequestBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}
