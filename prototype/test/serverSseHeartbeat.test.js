import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { postCouncilEvents } from "../src/realUserHarness.js";

const root = path.resolve(".");
const localApiToken = "test-local-api-token-0123456789abcdef";

test("real HTTP/SSE keeps the campaign watchdog alive while a local tool is silent", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-sse-heartbeat-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-sse-heartbeat",
    name: "Server SSE Heartbeat",
    permissions: { defaultTier: "text", seatTiers: { builder: "full" } },
    seats: [{ seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" }]
  }), "utf8");
  const provider = await startSlowToolProvider();
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: path.join(sandbox, "data"),
      AI_COUNCIL_WORKSPACE_ROOT: sandbox,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken,
      AI_COUNCIL_HARNESS_ALLOW_LOCAL_HTTP: "1",
      AI_COUNCIL_SSE_HEARTBEAT_MS: "250"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const run = await postCouncilEvents({
      port,
      localApiToken,
      group: runtimeGroup(provider.apiBaseUrl),
      groupPath,
      question: "Create and verify the requested local file.",
      noProgressTimeoutMs: 2500
    });
    assert.equal(run.aborted, false);
    assert.ok(run.events.some((event) => event.type === "heartbeat"), JSON.stringify(run.events));
    const toolStart = run.events.findIndex((event) => event.type === "tool_start" && event.tool === "execute_command");
    const toolSuccess = run.events.findIndex((event, index) => index > toolStart && event.type === "tool_success" && event.tool === "execute_command");
    assert.ok(toolStart >= 0 && toolSuccess > toolStart, JSON.stringify(run.events));
    assert.ok(run.events.slice(toolStart + 1, toolSuccess).some((event) => event.type === "heartbeat"), JSON.stringify(run.events));
    assert.equal(fs.readFileSync(path.join(groupPath, "shared", "heartbeat.txt"), "utf8").trim(), "alive");
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    await removeDirectoryWithRetry(sandbox);
  }
});

function runtimeGroup(apiBaseUrl) {
  return {
    id: "server-sse-heartbeat",
    name: "Server SSE Heartbeat",
    settings: { maxRounds: 3, minConsensusWeight: 1, stopWhenAllSkip: false, agentTimeoutMs: 5000, maxToolIterations: 6, allowSoloCouncil: true },
    agents: [{
      id: "builder",
      name: "Builder",
      role: "Builder",
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "test-key",
      model: "local-test-model",
      weight: 1,
      enabled: true
    }]
  };
}

async function startSlowToolProvider() {
  let builderStep = 0;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    let payload;
    if (prompt.includes("FinalDecision JSON object")) {
      payload = {
        answer: "The local file was created and verified.",
        final_state: "ready_to_execute",
        consensus_score: 1,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      };
    } else {
      const step = builderStep++;
      if (step === 0) {
        payload = {
          status: "speak",
          argument: "Record the contract before performing the first action.",
          task_contract: {
            mode: "delivery",
            objective: "Create and verify the local heartbeat file.",
            requires_workspace: true,
            requires_verification: true,
            deliverables: ["shared/heartbeat.txt"],
            completion_criteria: ["The file contains alive.", "A local command verifies it."],
            next_action: "Run the command that creates the file, then verify it."
          },
          objections: [],
          memory_candidates: []
        };
      } else if (step === 1) {
        payload = {
          status: "speak",
          argument: "Run the deliberately slow local command.",
          tool_requests: [{
            tool: "execute_command",
            command: "Start-Sleep -Milliseconds 4000; New-Item -ItemType Directory -Force shared | Out-Null; Set-Content -LiteralPath 'shared/heartbeat.txt' -Value 'alive'",
            shell: "powershell",
            reason: "Create the requested local file after a long silent command period."
          }],
          objections: [],
          memory_candidates: []
        };
      } else if (step === 2) {
        payload = {
          status: "speak",
          argument: "Verify the local file after the command completes.",
          tool_requests: [{
            tool: "run_code",
            language: "javascript",
            code: "const fs = require('fs'); if (fs.readFileSync('shared/heartbeat.txt', 'utf8').trim() !== 'alive') throw new Error('heartbeat file mismatch'); console.log('HEARTBEAT_FILE_OK');",
            reason: "Mechanically verify the created local file."
          }],
          objections: [],
          memory_candidates: []
        };
      } else {
        payload = { status: "speak", argument: "The local file was created and verified.", objections: [], memory_candidates: [] };
      }
    }
    const chunk = JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${chunk}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output()}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function removeDirectoryWithRetry(directory) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code) || attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}
