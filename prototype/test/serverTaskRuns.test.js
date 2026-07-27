import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");
const localApiToken = "test-local-api-token-0123456789abcdef";

test("real server HTTP/SSE flow exposes durable TaskRun evidence from real local tools", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-task-run-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-task-run",
    name: "Server TaskRun",
    permissions: { defaultTier: "text", seatTiers: { builder: "full" } },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "finalizer", displayName: "Finalizer", enabled: true, judge: true, privateFolder: "members/Finalizer" }
    ]
  }), "utf8");
  const provider = await startProvider();
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: path.join(sandbox, "data"),
      AI_COUNCIL_WORKSPACE_ROOT: sandbox,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const events = await requestSse(port, "/api/council/events", {
      question: "指定された作業領域の成果物を作成し、実際のコマンドで検証してください。",
      workspaceGroupPath: groupPath,
      runtimeGroup: runtimeGroup(provider.apiBaseUrl)
    });
    const taskEvent = events.find((event) => event.type === "task_run" && event.taskRun?.id);
    assert.ok(taskEvent, "SSE must publish a TaskRun update");
    const workspaceWrites = events.filter((event) => event.type === "tool_success" && event.tool === "workspace_edit");
    const verifications = events.filter((event) => event.type === "tool_success" && event.tool === "run_code");
    assert.equal(workspaceWrites.length, 1);
    assert.equal(workspaceWrites[0].agentId, "builder");
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].agentId, "builder");
    assert.equal(fs.readFileSync(path.join(groupPath, "shared", "sse.txt"), "utf8"), "SSE_RUNTIME_VERIFIED\n");

    const encodedGroupPath = encodeURIComponent(groupPath);
    const runs = await requestJson(port, `/api/task-runs?groupPath=${encodedGroupPath}`, undefined, "GET");
    assert.equal(runs.status, 200);
    assert.equal(runs.body.taskRuns.some((item) => item.id === taskEvent.taskRun.id && item.state === "completed"), true, JSON.stringify(runs.body.taskRuns));
    const detail = await requestJson(port, `/api/task-runs/${encodeURIComponent(taskEvent.taskRun.id)}?groupPath=${encodedGroupPath}`, undefined, "GET");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.events.some((event) => event.type === "context_compiled"), true, JSON.stringify(detail.body.events.map((event) => event.type)));
    assert.equal(detail.body.events.some((event) => event.type === "tool_attempt_finished"), true);
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a malformed intake reply stays with its owner and becomes an honest incomplete run", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-intake-contract-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-intake-contract",
    name: "Server Intake Contract",
    permissions: { defaultTier: "text", seatTiers: { builder: "full", helper: "full" } },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "helper", displayName: "Helper", enabled: true, privateFolder: "members/Helper" },
      { seatId: "finalizer", displayName: "Finalizer", enabled: true, judge: true, privateFolder: "members/Finalizer" }
    ]
  }), "utf8");
  const provider = await startMalformedIntakeProvider();
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: path.join(sandbox, "data"),
      AI_COUNCIL_WORKSPACE_ROOT: sandbox,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const events = await requestSse(port, "/api/council/events", {
      question: "Cree un resultado solicitado en la ubicacion solicitada y compruebelo.",
      workspaceGroupPath: groupPath,
      runtimeGroup: runtimeGroupWithHelper(provider.apiBaseUrl)
    });
    const messages = events.filter((event) => event.type === "agent_message");
    assert.equal(messages.length, 2, JSON.stringify(messages));
    assert.equal(messages.every((event) => event.message?.agentId === "builder"), true, JSON.stringify(messages));
    assert.equal(events.some((event) => event.type === "tool_success" && event.agentId !== "builder"), false);
    assert.equal(events.some((event) => event.type === "tool_success"), false);
    const completed = events.find((event) => event.type === "done");
    assert.equal(completed?.result?.session?.status, "incomplete", JSON.stringify(completed));
    assert.equal(completed?.result?.session?.executionState?.phase, "intake");
    assert.equal(completed?.result?.session?.executionState?.intakeAttempts, 2);
    assert.equal(completed?.result?.session?.executionState?.lastAction, "task_contract_missing");

    const taskEvent = events.find((event) => event.type === "task_run" && event.taskRun?.id);
    assert.ok(taskEvent, "SSE must publish the blocked intake TaskRun");
    const detail = await requestJson(port, `/api/task-runs/${encodeURIComponent(taskEvent.taskRun.id)}?groupPath=${encodeURIComponent(groupPath)}`, undefined, "GET");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.taskRun.execution.phase, "intake");
    assert.equal(detail.body.taskRun.execution.intakeAttempts, 2);
    assert.match(detail.body.taskRun.execution.lastError, /without a valid task contract/i);
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an observer disconnect does not abort the background run and cursor replay returns only missing events", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-run-replay-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-run-replay",
    name: "Server Run Replay",
    permissions: { defaultTier: "text", seatTiers: { builder: "full" } },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "finalizer", displayName: "Finalizer", enabled: true, judge: true, privateFolder: "members/Finalizer" }
    ]
  }), "utf8");
  const provider = await startProvider(160);
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: path.join(sandbox, "data"),
      AI_COUNCIL_WORKSPACE_ROOT: sandbox,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const started = await requestJson(port, "/api/council/runs", {
      question: "Create a small workspace document and verify it with a real command.",
      workspaceGroupPath: groupPath,
      runtimeGroup: runtimeGroup(provider.apiBaseUrl)
    });
    assert.equal(started.status, 202);
    assert.ok(started.body.id);

    const firstObserver = await fetch(`http://127.0.0.1:${port}/api/council/runs/${encodeURIComponent(started.body.id)}/events?groupPath=${encodeURIComponent(groupPath)}&after=0`, {
      headers: { "X-AI-Council-Token": localApiToken }
    });
    assert.equal(firstObserver.status, 200);
    const firstReader = firstObserver.body.getReader();
    const firstChunk = await firstReader.read();
    assert.equal(firstChunk.done, false);
    await firstReader.cancel();

    const allEvents = await requestRunEvents(port, groupPath, started.body.id, 0);
    assert.equal(allEvents.some((event) => event.type === "run_completed"), true, JSON.stringify(allEvents));
    assert.equal(allEvents.some((event) => event.type === "run_interrupted"), false, JSON.stringify(allEvents));
    const sessionEvent = allEvents.find((event) => event.type === "task_run" && event.taskRun?.id);
    assert.ok(sessionEvent);
    const runDetails = await requestJson(port, `/api/task-runs/${encodeURIComponent(sessionEvent.taskRun.id)}?groupPath=${encodeURIComponent(groupPath)}`, undefined, "GET");
    assert.equal(runDetails.body.taskRun.state, "completed");

    const cursor = allEvents[Math.floor(allEvents.length / 2)].eventSequence;
    const replay = await requestRunEvents(port, groupPath, started.body.id, cursor);
    assert.deepEqual(replay.map((event) => event.eventSequence), allEvents.filter((event) => event.eventSequence > cursor).map((event) => event.eventSequence));
    assert.equal(replay.every((event, index) => index === 0 || event.eventSequence > replay[index - 1].eventSequence), true);
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

function runtimeGroup(apiBaseUrl) {
  const base = {
    provider: "openai-compatible",
    apiBaseUrl,
    allowUnsafePrivateNetwork: true,
    apiKey: "test-key",
    model: "local-test-model",
    weight: 1,
    enabled: true
  };
  return {
    id: "server-task-run",
    name: "Server TaskRun",
    settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: false, agentTimeoutMs: 5000, maxToolIterations: 6, allowSoloCouncil: true },
    agents: [
      { ...base, id: "builder", name: "Builder", role: "Builder" },
      { ...base, id: "finalizer", name: "Finalizer", role: "Finalizer", judge: true }
    ]
  };
}

function runtimeGroupWithHelper(apiBaseUrl) {
  const base = {
    provider: "openai-compatible",
    apiBaseUrl,
    allowUnsafePrivateNetwork: true,
    apiKey: "test-key",
    model: "local-test-model",
    weight: 1,
    enabled: true
  };
  return {
    id: "server-intake-contract",
    name: "Server Intake Contract",
    settings: { maxRounds: 2, minConsensusWeight: 1, stopWhenAllSkip: false, agentTimeoutMs: 5000, maxToolIterations: 6, allowSoloCouncil: true },
    agents: [
      { ...base, id: "builder", name: "Builder", role: "Builder" },
      { ...base, id: "helper", name: "Helper", role: "Helper" },
      { ...base, id: "finalizer", name: "Finalizer", role: "Finalizer", judge: true }
    ]
  };
}

async function startProvider(responseDelayMs = 0) {
  let builderStep = 0;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    const payload = prompt.includes("FinalDecision JSON object")
      ? finalDecision()
      : builderStep++ === 0
        ? writeDocument()
        : builderStep === 2
          ? verifyDocument()
          : { status: "speak", argument: "The real local verification passed.", objections: [], memory_candidates: [] };
    setTimeout(() => {
      const chunk = JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${chunk}\n\n`);
      res.end("data: [DONE]\n\n");
    }, responseDelayMs);
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

async function startMalformedIntakeProvider() {
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    const payload = prompt.includes("FinalDecision JSON object")
      ? finalDecision()
      : { status: "speak", argument: "I will first think through the request.", objections: [], memory_candidates: [] };
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

function writeDocument() {
  return {
    status: "speak",
    argument: "Write the workspace document.",
    task_contract: {
      mode: "delivery",
      objective: "Create and verify the requested local workspace document.",
      requires_workspace: true,
      requires_verification: true,
      deliverables: ["shared/sse.txt"],
      completion_criteria: ["The document exists with the requested content.", "A local command verifies that content."],
      next_action: "Write the document, then verify it with a local command."
    },
    tool_requests: [{ tool: "workspace_edit", action: "write", path: "shared/sse.txt", code: "SSE_RUNTIME_VERIFIED\n", reason: "Create the requested workspace document." }],
    objections: [],
    memory_candidates: []
  };
}

function verifyDocument() {
  return {
    status: "speak",
    argument: "Verify the workspace document with the local code runtime.",
    tool_requests: [{ tool: "run_code", language: "javascript", code: "const fs = require('fs'); if (fs.readFileSync('shared/sse.txt', 'utf8') !== 'SSE_RUNTIME_VERIFIED\\n') throw new Error('bad document'); console.log('SSE_OK');", reason: "Verify the created document." }],
    objections: [],
    memory_candidates: []
  };
}

function finalDecision() {
  return {
    answer: "The workspace document was written and verified.",
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
}

async function requestSse(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AI-Council-Token": localApiToken },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

async function requestRunEvents(port, groupPath, runId, after) {
  const response = await fetch(`http://127.0.0.1:${port}/api/council/runs/${encodeURIComponent(runId)}/events?groupPath=${encodeURIComponent(groupPath)}&after=${after}`, {
    headers: { "X-AI-Council-Token": localApiToken }
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await requestJson(port, "/api/health", undefined, "GET");
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output()}`);
}

async function requestJson(port, pathname, body, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? { "X-AI-Council-Token": localApiToken } : { "Content-Type": "application/json", "X-AI-Council-Token": localApiToken },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
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
