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

test("real HTTP/SSE rejects an unconfigured UI seat before it can call a provider", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-unconfigured-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  const provider = await startCountingProvider();
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
    const response = await requestJson(port, "/api/council/events", {
      question: "Create a local result.",
      workspaceGroupPath: groupPath,
      runtimeGroup: {
        id: "unconfigured-ui-runtime",
        name: "Unconfigured UI Runtime",
        agents: [{
          id: "builder",
          name: "Builder",
          role: "builder",
          provider: "unconfigured",
          apiBaseUrl: provider.apiBaseUrl,
          model: "would-be-model",
          weight: 1,
          enabled: true
        }]
      }
    });
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.match(response.body.error, /Missing model provider configuration for: builder/);
    assert.equal(provider.calls, 0, "an unconfigured UI seat must not reach a provider");
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    await removeDirectoryWithRetry(sandbox);
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

test("real server HTTP/SSE preserves a skip-status bounded contributor handoff and lets only the owner deliver", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-delegation-"));
  const groupPath = path.join(sandbox, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.mkdirSync(path.join(groupPath, "shared"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "shared", "research.txt"), "FACT_FROM_RESEARCH\n", "utf8");
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-delegation",
    name: "Server Delegation",
    permissions: { defaultTier: "text", seatTiers: { builder: "full", researcher: "full" } },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "researcher", displayName: "Researcher", enabled: true, privateFolder: "members/Researcher" },
      { seatId: "finalizer", displayName: "Finalizer", enabled: true, judge: true, privateFolder: "members/Finalizer" }
    ]
  }), "utf8");
  const provider = await startDelegatingProvider();
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
      question: "Create a local document using one delegated research fact, then verify it.",
      workspaceGroupPath: groupPath,
      runtimeGroup: runtimeGroupWithResearcher(provider.apiBaseUrl)
    });
    const messages = events.filter((event) => event.type === "agent_message");
    assert.deepEqual(messages.map((event) => event.message.agentId), ["builder", "researcher", "builder"]);
    const writes = events.filter((event) => event.type === "tool_success" && event.tool === "workspace_edit");
    assert.equal(writes.length, 1, JSON.stringify(events.map((event) => ({ type: event.type, tool: event.tool, agentId: event.agentId, error: event.error, message: event.message?.displayText }))));
    assert.equal(writes[0].agentId, "builder");
    assert.equal(fs.readFileSync(path.join(groupPath, "shared", "delegated.txt"), "utf8"), "FACT_FROM_RESEARCH\n");
    assert.equal(fs.existsSync(path.join(groupPath, "shared", "eager-before-handoff.txt")), false);
    assert.equal(events.some((event) => event.type === "tool_failure" && event.tool === "workspace_edit" && event.code === "delegation_handoff_required" && event.agentId === "builder"), true);

    const taskEvent = events.find((event) => event.type === "task_run" && event.taskRun?.id);
    assert.ok(taskEvent);
    const detail = await requestJson(port, `/api/task-runs/${encodeURIComponent(taskEvent.taskRun.id)}?groupPath=${encodeURIComponent(groupPath)}`, undefined, "GET");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.taskRun.state, "completed", JSON.stringify(detail.body.taskRun));
    const delegation = detail.body.taskRun.execution.ownership.delegations.find((item) => item.assigneeId === "researcher");
    assert.equal(delegation.status, "completed");
    assert.equal(delegation.native, true);
    assert.equal(delegation.ownerAcknowledged, true);
    assert.equal(delegation.result, "The source fact is FACT_FROM_RESEARCH.");
    assert.equal(delegation.handoffEvidence.some((item) => item.kind === "tool" && item.detail.includes("read_file")), true);
    assert.equal(delegation.handoffEvidence.some((item) => item.detail.includes("FACT_FROM_RESEARCH")), true);
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

test("direct HTTP/SSE observers can disconnect while an agent controls a real PTY and the durable run records the terminal lifecycle", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-pty-sse-"));
  const groupPath = path.join(sandbox, "group");
  const terminalInput = "PTY_HTTP_SSE_INPUT_SECRET";
  const terminalFileFact = "PTY_HTTP_SSE_FILE_FACT";
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "server-pty-sse",
    name: "Server PTY SSE",
    permissions: { defaultTier: "text", seatTiers: { builder: "full" } },
    seats: [
      { seatId: "builder", displayName: "Builder", enabled: true, privateFolder: "members/Builder" },
      { seatId: "finalizer", displayName: "Finalizer", enabled: true, judge: true, privateFolder: "members/Finalizer" }
    ]
  }), "utf8");
  const provider = await startInteractivePtyProvider({ terminalInput, terminalFileFact });
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
    const response = await fetch(`http://127.0.0.1:${port}/api/council/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Council-Token": localApiToken },
      body: JSON.stringify({
        question: "Create a terminal-driven local file, verify it, and close the terminal.",
        workspaceGroupPath: groupPath,
        runtimeGroup: runtimeGroupWithInteractivePty(provider.apiBaseUrl)
      })
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    const initialEvents = parseSseEvents(new TextDecoder().decode(first.value || new Uint8Array()));
    const started = initialEvents.find((event) => event.type === "run_started");
    assert.ok(started?.run?.id, JSON.stringify(initialEvents));
    await reader.cancel();

    const events = await requestRunEvents(port, groupPath, started.run.id, 0);
    assert.equal(events.some((event) => event.type === "run_interrupted"), false, JSON.stringify(events));
    assert.equal(events.some((event) => event.type === "tool_success" && event.tool === "execute_command"), true);
    assert.equal(events.some((event) => event.type === "tool_success" && event.tool === "process_control" && event.action === "input" && event.inputText?.redacted === true), true);
    assert.equal(events.some((event) => event.type === "tool_success" && event.tool === "process_control" && event.action === "output" && event.offset === 1), true);
    const terminalOutputPath = path.join(groupPath, "shared", "pty-http-sse.txt");
    const processId = events.find((event) => event.type === "tool_success" && event.tool === "execute_command")?.resultSummary?.processId;
    const terminalLog = processId ? fs.readFileSync(path.join(groupPath, "shared", "logs", "processes", processId, "stdout.log"), "utf8") : "missing process id";
    assert.equal(fs.existsSync(terminalOutputPath), true, terminalLog);
    assert.equal(fs.readFileSync(terminalOutputPath, "utf8").trim(), terminalFileFact);
    assert.equal(provider.terminalInputCount, 1, "The provider must issue real terminal input exactly once.");

    const taskEvent = events.find((event) => event.type === "task_run" && event.taskRun?.id);
    assert.ok(taskEvent, "The replayed SSE stream must expose the durable TaskRun.");
    const detail = await requestJson(port, `/api/task-runs/${encodeURIComponent(taskEvent.taskRun.id)}?groupPath=${encodeURIComponent(groupPath)}`, undefined, "GET");
    assert.equal(detail.status, 200);
    assert.equal(detail.body.taskRun.state, "completed", JSON.stringify(detail.body.taskRun));
    assert.equal(detail.body.events.some((event) => event.type === "background_process_observed" && event.payload?.action === "start"), true);
    assert.equal(detail.body.events.some((event) => event.type === "background_process_observed" && event.payload?.action === "stop" && event.payload?.status === "stopped"), true);
    assert.equal(detail.body.events.some((event) => event.type === "workspace_evidence" && event.payload?.path === "shared/pty-http-sse.txt"), true, JSON.stringify(detail.body.events));
    const persisted = { events, taskRun: detail.body };
    assert.deepEqual(findValuePaths(persisted, terminalInput), [], "Terminal input must not be persisted in SSE or TaskRun evidence.");
    for (const relativePath of ["shared/logs/tools.jsonl", "shared/logs/processes.jsonl", "shared/logs/model-calls.jsonl"]) {
      const content = fs.readFileSync(path.join(groupPath, relativePath), "utf8");
      assert.equal(content.includes(terminalInput), false, `${relativePath} must not retain terminal input.`);
    }
    assert.equal(terminalLog.includes(terminalInput), false, terminalLog);
  } finally {
    child.kill();
    await waitForExit(child);
    await provider.close();
    await removeDirectoryWithRetry(sandbox);
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

function runtimeGroupWithInteractivePty(apiBaseUrl) {
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
    id: "server-pty-sse",
    name: "Server PTY SSE",
    settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: false, agentTimeoutMs: 5000, maxToolIterations: 20, allowSoloCouncil: true },
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

function runtimeGroupWithResearcher(apiBaseUrl) {
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
    id: "server-delegation",
    name: "Server Delegation",
    settings: { maxRounds: 3, minConsensusWeight: 1, stopWhenAllSkip: false, agentTimeoutMs: 5000, maxToolIterations: 6, allowSoloCouncil: true },
    agents: [
      { ...base, id: "builder", name: "Builder", role: "Builder" },
      { ...base, id: "researcher", name: "Researcher", role: "Researcher" },
      { ...base, id: "finalizer", name: "Finalizer", role: "Finalizer", judge: true }
    ]
  };
}

async function startCountingProvider() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "provider_must_not_be_called" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    get calls() { return calls; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
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

async function startInteractivePtyProvider({ terminalInput, terminalFileFact }) {
  let outputRequested = false;
  let inputRequested = false;
  let verificationRequested = false;
  let stopRequested = false;
  let terminalInputCount = 0;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    const processId = prompt.match(/\bproc_[a-z0-9_]+\b/i)?.[0] || "";
    let payload;
    if (prompt.includes("FinalDecision JSON object")) {
      payload = finalDecision();
    } else if (!processId) {
      payload = {
        status: "speak",
        argument: "Start the requested durable terminal.",
        task_contract: {
          mode: "delivery",
          objective: "Create and verify the terminal-driven workspace file.",
          requires_workspace: true,
          requires_verification: true,
          deliverables: ["shared/pty-http-sse.txt"],
          completion_criteria: ["The terminal writes the requested file.", "A local command verifies its exact content.", "The terminal is stopped."],
          next_action: "Start an interactive terminal, provide its requested input, write the file, verify it, and stop it."
        },
        tool_requests: [{
          tool: "execute_command",
          command: "if not exist shared mkdir shared & echo PTY_HTTP_SSE_BOOT",
          shell: "cmd",
          interactive: true,
          columns: 100,
          rows: 30,
          reason: "Start a real terminal that will receive the file-writing command."
        }],
        objections: [],
        memory_candidates: []
      };
    } else if (!outputRequested) {
      outputRequested = true;
      payload = terminalRequest(processId, { action: "output", stream: "terminal", offset: 1, maxBytes: 2048 }, "Read the live terminal output from a nonzero offset.");
    } else if (!inputRequested) {
      inputRequested = true;
      terminalInputCount += 1;
      payload = terminalRequest(processId, { action: "input", inputText: `echo ${terminalFileFact}>shared\\pty-http-sse.txt & rem ${terminalInput}\r` }, "Use one exact terminal input to write the requested file.");
    } else if (!verificationRequested) {
      verificationRequested = true;
      payload = {
        status: "speak",
        argument: "Verify the file produced by the terminal.",
        tool_requests: [{
          tool: "run_code",
          language: "javascript",
          code: `const fs = require('fs'); if (fs.readFileSync('shared/pty-http-sse.txt', 'utf8').trim() !== '${terminalFileFact}') throw new Error('terminal output mismatch'); console.log('PTY_HTTP_SSE_VERIFIED');`,
          reason: "Mechanically verify the terminal-created file."
        }],
        objections: [],
        memory_candidates: []
      };
    } else if (!stopRequested) {
      stopRequested = true;
      payload = terminalRequest(processId, { action: "stop", timeoutMs: 10000 }, "Close the durable terminal after verification.");
    } else {
      payload = { status: "speak", argument: "The terminal-created file was verified and the terminal was stopped.", objections: [], memory_candidates: [] };
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
    get terminalInputCount() { return terminalInputCount; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function terminalRequest(processId, request, reason) {
  if (!processId) {
    return { status: "unavailable", reason: "interactive_process_id_missing_from_tool_context", retryable: false, objections: [], memory_candidates: [] };
  }
  return {
    status: "speak",
    argument: reason,
    tool_requests: [{ tool: "process_control", processId, reason, ...request }],
    objections: [],
    memory_candidates: []
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

async function startDelegatingProvider() {
  let intakeHandled = false;
  let ownerWriteIssued = false;
  let researcherReadIssued = false;
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    let payload;
    if (prompt.includes("FinalDecision JSON object")) {
      payload = finalDecision();
    } else if (prompt.includes("[Delegated research work]") && !researcherReadIssued) {
      researcherReadIssued = true;
      payload = {
        status: "speak",
        argument: "Read the bounded source file before returning the handoff.",
        tool_requests: [{ tool: "read_file", path: "shared/research.txt", reason: "Read the one delegated source fact." }],
        objections: [],
        memory_candidates: []
      };
    } else if (prompt.includes("[Delegated research work]")) {
      const delegationId = prompt.match(/Delegation:\s*([^\.\n]+)/)?.[1]?.trim() || "delegation:0:1:researcher";
      payload = {
        // A completed contributor may use skip after its tool follow-up.
        status: "skip",
        argument: "The bounded research task is complete.",
        delegation_handoff: {
          delegation_id: delegationId,
          summary: "The source fact is FACT_FROM_RESEARCH.",
          evidence: ["Official source fact: FACT_FROM_RESEARCH"]
        },
        file_operations: [{
          op: "write",
          path: "shared/delegated.txt",
          content: "CONTRIBUTOR_MUST_NOT_WRITE_FINAL\n",
          reason: "Deliberately exercise the runtime delegation boundary.",
          expected_effect: "Must be rejected because research has no write scope."
        }],
        objections: [],
        memory_candidates: []
      };
    } else if (!intakeHandled && prompt.includes("[Task intake owner]")) {
      intakeHandled = true;
      const contract = {
        status: "speak",
        argument: "Delegate the required research fact before writing.",
        task_contract: {
          mode: "delivery",
          objective: "Create and verify the requested local document.",
          requires_workspace: true,
          requires_verification: true,
          deliverables: ["shared/delegated.txt"],
          completion_criteria: ["The document contains the delegated fact.", "A local command verifies the document."],
          next_action: "Delegate the source fact, then write the document.",
          collaboration: { required: true, before_first_mutation: true, minimum_delegations: 1, types: ["research"], reason: "The user explicitly requires a research handoff." }
        },
        objections: [],
        memory_candidates: []
      };
      writeOpenAiContentAndNativeToolStream(res, contract, [{
        tool: "delegate_task",
        delegationType: "research",
        assigneeId: "researcher",
        delegationTask: "Find the one source fact needed for the document.",
        expectedEvidence: ["One source fact"],
        allowedTools: ["read_file"],
        allowWorkspaceMutation: false,
        allowedPaths: []
      }, {
        tool: "workspace_edit",
        action: "write",
        path: "shared/eager-before-handoff.txt",
        code: "MUST_NOT_BE_WRITTEN\n",
        reason: "Deliberately attempt an owner write in the delegation turn."
      }]);
      return;
    } else if (!ownerWriteIssued) {
      ownerWriteIssued = true;
      payload = {
        status: "speak",
        argument: "Use the returned handoff and write the document.",
        tool_requests: [{ tool: "workspace_edit", action: "write", path: "shared/delegated.txt", code: "FACT_FROM_RESEARCH\n", reason: "Write the final document from the delegated evidence." }],
        objections: [],
        memory_candidates: []
      };
    } else {
      payload = {
        status: "speak",
        argument: "Verify the owner-created document.",
        tool_requests: [{ tool: "run_code", language: "javascript", code: "const fs = require('fs'); if (fs.readFileSync('shared/delegated.txt', 'utf8') !== 'FACT_FROM_RESEARCH\\n') throw new Error('wrong document'); console.log('DELEGATION_OK');", reason: "Verify the owner-created final document." }],
        objections: [],
        memory_candidates: []
      };
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

function parseSseEvents(text) {
  return String(text || "").split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function findValuePaths(value, needle, pathPrefix = "$") {
  if (typeof value === "string") return value.includes(needle) ? [pathPrefix] : [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findValuePaths(item, needle, `${pathPrefix}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => findValuePaths(item, needle, `${pathPrefix}.${key}`));
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

function writeOpenAiContentAndNativeToolStream(res, content, request) {
  const requests = Array.isArray(request) ? request : [request];
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(content) } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: requests.map((item, index) => ({
    index,
    id: `native_tool_${index + 1}`,
    function: { name: "ai_council_tool", arguments: JSON.stringify(item) }
  })) } }] })}\n\n`);
  res.end("data: [DONE]\n\n");
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
