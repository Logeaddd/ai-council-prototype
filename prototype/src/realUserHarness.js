import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(__dirname, "server.js");

export async function runSeededRealUserBaseline(options = {}) {
  const group = structuredClone(options.group || {});
  const scenario = normalizeScenario(options.scenario || createMinimumBaselineScenario(options.seed));
  assertRunnableGroup(group, { allowMockProvider: options.allowMockProvider === true });
  const outputRoot = path.resolve(options.outputDir || path.join(prototypeRoot, "eval", "real-user"));
  const runDir = path.join(outputRoot, `${safeId(scenario.id)}-${Date.now()}`);
  const dataDir = path.join(runDir, "data");
  const groupPath = path.join(dataDir, "workspace-ui", "baseline-group");
  const events = [];
  const startedAt = new Date().toISOString();
  let server;
  let firstRun;
  let continueRun;
  let editRun;
  let interruptedSession;
  let continuedSession;
  let editedSession;
  let failure;
  let failureKind = "failed";

  fs.mkdirSync(runDir, { recursive: true });
  try {
    prepareGroupWorkspace(groupPath, group);

    server = await startHarnessServer({
      dataDir,
      workspaceRoot: dataDir,
      environment: options.environment
    });
    firstRun = await postCouncilEvents({
      port: server.port,
      group,
      groupPath,
      question: scenario.initialQuestion,
      onEvent(event) {
        events.push(compactEvent("initial", event));
      },
      abortWhen: isMaterialActionEvent
    });
    if (!firstRun.aborted) throw harnessFailure("initial_run_did_not_reach_action", "The initial task ended before any material action was observed.");

    interruptedSession = await waitForSession(server.port, groupPath, (session) => session.status === "interrupted");
    await stopHarnessServer(server);
    server = await startHarnessServer({
      dataDir,
      workspaceRoot: dataDir,
      environment: options.environment
    });

    continueRun = await postCouncilEvents({
      port: server.port,
      group,
      groupPath,
      question: scenario.continueQuestion,
      onEvent(event) {
        events.push(compactEvent("continue", event));
      }
    });
    continuedSession = await waitForSession(server.port, groupPath, (session) => session.question === scenario.continueQuestion);

    editRun = await postCouncilEvents({
      port: server.port,
      group,
      groupPath,
      question: scenario.editQuestion,
      onEvent(event) {
        events.push(compactEvent("edit", event));
      }
    });
    editedSession = await waitForSession(server.port, groupPath, (session) => session.question === scenario.editQuestion);
  } catch (error) {
    failure = error;
    failureKind = error?.harnessInfrastructure ? "infrastructure_error" : "failed";
  } finally {
    if (server) await stopHarnessServer(server);
  }

  const verification = await verifyScenario(scenario, groupPath);
  const sessionChecks = verifySessions({ interruptedSession, continuedSession, editedSession });
  const actionEvents = events.filter((event) => isMaterialActionType(event.type));
  const report = {
    schema: "ai-council.real-user-baseline.v1",
    startedAt,
    completedAt: new Date().toISOString(),
    status: failure ? failureKind : verification.passed && sessionChecks.passed ? "passed" : "failed",
    error: failure ? String(failure.message || failure).slice(0, 1600) : "",
    seed: scenario.seed,
    scenario: publicScenario(scenario),
    group: redactGroup(group),
    workspacePath: groupPath,
    autonomousExecution: {
      actionEventsObserved: actionEvents.length,
      initialRunAbortedAfterAction: Boolean(firstRun?.aborted),
      continuationSessionId: continuedSession?.id || "",
      editSessionId: editedSession?.id || "",
      passed: Boolean(firstRun?.aborted) && actionEvents.length > 0 && sessionChecks.passed
    },
    minimumUsableDelivery: verification,
    subjectiveQuality: { status: "not_scored" },
    sessions: {
      interrupted: summarizeSession(interruptedSession),
      continued: summarizeSession(continuedSession),
      edited: summarizeSession(editedSession),
      checks: sessionChecks
    },
    timeline: events,
    transport: {
      entry: "POST /api/council/events",
      interruption: "SSE client disconnect followed by server restart",
      continuation: scenario.continueQuestion
    }
  };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  return { runDir, groupPath, report };
}

export function createMinimumBaselineScenario(seed = Date.now()) {
  const normalizedSeed = normalizeSeed(seed);
  const variants = [
    { id: "greeting", file: "deliverables/greeting.js", initial: "Hello", updated: "Welcome", punctuation: "." },
    { id: "salutation", file: "deliverables/salutation.js", initial: "Good day", updated: "Greetings", punctuation: "!" },
    { id: "message", file: "deliverables/message.js", initial: "Hi", updated: "Thanks", punctuation: "." }
  ];
  const variant = variants[normalizedSeed % variants.length];
  return {
    id: `node-cli-${variant.id}`,
    seed: normalizedSeed,
    file: variant.file,
    initialQuestion: `Create a small command-line program at ${variant.file}. It must accept --name <value> and print ${JSON.stringify(`${variant.initial}, <value>${variant.punctuation}`)} exactly. Run it to verify the result.`,
    continueQuestion: "continue",
    editQuestion: `Change the existing program so the same --name command prints ${JSON.stringify(`${variant.updated}, <value>${variant.punctuation}`)} exactly. Keep the command-line interface unchanged and verify it.`,
    verify: {
      args: ["--name", "Ada"],
      expectedOutput: `${variant.updated}, Ada${variant.punctuation}`
    }
  };
}

export async function postCouncilEvents(options = {}) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${options.port}/api/council/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      question: options.question,
      workspaceGroupPath: options.groupPath,
      runtimeGroup: options.group
    })
  });
  if (!response.ok || !response.body) {
    throw harnessFailure("council_sse_request_failed", `Council SSE request failed with HTTP ${response.status}.`, true);
  }

  const events = [];
  let aborted = false;
  try {
    for await (const event of readSseEvents(response.body)) {
      events.push(event);
      options.onEvent?.(event);
      if (options.abortWhen?.(event)) {
        aborted = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  return { events, aborted };
}

export async function* readSseEvents(stream) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) yield event;
      boundary = pending.indexOf("\n\n");
    }
  }
  pending += decoder.decode();
  const event = parseSseBlock(pending);
  if (event) yield event;
}

export function parseSseBlock(block) {
  const lines = String(block || "").replaceAll("\r", "").split("\n");
  const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data) return null;
  try {
    return { type: eventType, ...JSON.parse(data) };
  } catch {
    return { type: eventType, rawData: data };
  }
}

function normalizeScenario(value) {
  const scenario = { ...value };
  const required = ["id", "file", "initialQuestion", "continueQuestion", "editQuestion"];
  for (const field of required) {
    if (!String(scenario[field] || "").trim()) throw harnessFailure("invalid_scenario", `Baseline scenario is missing ${field}.`, true);
  }
  if (!scenario.verify?.expectedOutput || !Array.isArray(scenario.verify?.args)) {
    throw harnessFailure("invalid_scenario_verifier", "Baseline scenario needs a hidden command verifier.", true);
  }
  scenario.seed = normalizeSeed(scenario.seed);
  return scenario;
}

function assertRunnableGroup(group, options = {}) {
  const enabled = Array.isArray(group.agents) ? group.agents.filter((agent) => agent.enabled !== false) : [];
  if (!enabled.length) throw harnessFailure("missing_agents", "Real-user baseline needs at least one enabled model.", true);
  if (!options.allowMockProvider && enabled.some((agent) => agent.provider === "mock")) {
    throw harnessFailure("mock_provider_denied", "Real-user baseline refuses mock providers. Use allowMockProvider only for harness plumbing tests.", true);
  }
  for (const agent of enabled) {
    if (!agent.id || !agent.name || !agent.role || !agent.provider || !agent.apiBaseUrl || !agent.model) {
      throw harnessFailure("invalid_agent", `Enabled agent ${agent.id || agent.name || "unknown"} is incomplete.`, true);
    }
  }
  group.settings = {
    maxRounds: 1,
    minRounds: 1,
    stopWhenAllSkip: false,
    allowSoloCouncil: true,
    agentTimeoutMs: 900000,
    maxToolIterations: 0,
    maxModelCalls: 0,
    noProgressModelCalls: 0,
    ...(group.settings || {})
  };
}

function prepareGroupWorkspace(groupPath, group) {
  for (const relative of ["shared/inbox", "shared/logs", "members", "sessions", "approvals"]) {
    fs.mkdirSync(path.join(groupPath, relative), { recursive: true });
  }
  const seats = group.agents.map((agent) => ({
    seatId: agent.id,
    displayName: agent.name,
    currentModel: agent.model,
    role: agent.judge ? "summarizer" : agent.mandatoryRedTeam ? "reviewer" : "ordinary",
    enabled: agent.enabled !== false,
    privateFolder: `members/${safeId(agent.id)}`
  }));
  for (const seat of seats) fs.mkdirSync(path.join(groupPath, seat.privateFolder), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupFolderName: "baseline-group",
    groupPath,
    permissions: { defaultTier: "full", seatTiers: {} },
    seats
  }, null, 2), "utf8");
}

async function startHarnessServer(options = {}) {
  const port = await availablePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: prototypeRoot,
    env: {
      ...process.env,
      ...(options.environment || {}),
      AI_COUNCIL_DATA_DIR: options.dataDir,
      AI_COUNCIL_WORKSPACE_ROOT: options.workspaceRoot,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    await waitForHealth(port, child, () => output);
    return { child, port };
  } catch (error) {
    await stopHarnessServer({ child });
    throw error;
  }
}

async function stopHarnessServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill();
  await Promise.race([
    once(server.child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw harnessFailure("server_exited_early", `Harness server exited early: ${output()}`, true);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Wait for the isolated local server to bind.
    }
    await delay(50);
  }
  throw harnessFailure("server_start_timeout", "Harness server did not become healthy.", true);
}

async function waitForSession(port, groupPath, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const sessionsResponse = await fetch(`http://127.0.0.1:${port}/api/sessions?groupPath=${encodeURIComponent(groupPath)}`);
    if (sessionsResponse.ok) {
      const body = await sessionsResponse.json();
      const found = (body.sessions || []).find(predicate);
      if (found?.id) {
        const detailResponse = await fetch(`http://127.0.0.1:${port}/api/session?groupPath=${encodeURIComponent(groupPath)}&sessionId=${encodeURIComponent(found.id)}`);
        if (detailResponse.ok) return (await detailResponse.json()).session;
      }
    }
    await delay(50);
  }
  throw harnessFailure("session_persistence_timeout", "Expected persisted session was not available through the real history API.");
}

async function availablePort() {
  const listener = http.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!port) throw harnessFailure("port_allocation_failed", "Harness could not allocate a local TCP port.", true);
  return port;
}

async function verifyScenario(scenario, groupPath) {
  const filePath = path.resolve(groupPath, scenario.file);
  const checks = [];
  checks.push(check("file_exists", fs.existsSync(filePath), scenario.file));
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    checks.push(check("file_nonempty", stat.size > 0, `${stat.size} bytes`));
  }
  const command = await runNode(filePath, scenario.verify.args);
  checks.push(check("command_exit", command.exitCode === 0, `exit=${command.exitCode}; stderr=${command.stderr.slice(0, 300)}`));
  checks.push(check("final_requirement", command.stdout.trim() === scenario.verify.expectedOutput, `expected=${JSON.stringify(scenario.verify.expectedOutput)} actual=${JSON.stringify(command.stdout.trim())}`));
  return { passed: checks.every((item) => item.passed), checks };
}

function verifySessions({ interruptedSession, continuedSession, editedSession }) {
  const checks = [
    check("interrupted_persisted", interruptedSession?.status === "interrupted", interruptedSession?.status || "missing"),
    check("continued_persisted", Boolean(continuedSession?.id), continuedSession?.id || "missing"),
    check("edit_persisted", Boolean(editedSession?.id), editedSession?.id || "missing"),
    check("continue_remembers_interrupted_session", continuedSession?.continuationContext?.previousSessionId === interruptedSession?.id, `${continuedSession?.continuationContext?.previousSessionId || ""} -> ${interruptedSession?.id || ""}`)
  ];
  return { passed: checks.every((item) => item.passed), checks };
}

function runNode(filePath, args) {
  if (!fs.existsSync(filePath)) return { exitCode: -1, stdout: "", stderr: "file_missing" };
  const result = spawn(process.execPath, [filePath, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  result.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  result.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const timer = setTimeout(() => result.kill(), 10000);
  return new Promise((resolve) => {
    result.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    result.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: "", stderr: error.message });
    });
  });
}

function isMaterialActionEvent(event = {}) {
  return isMaterialActionType(event.type) && event.status !== "rejected";
}

function isMaterialActionType(type) {
  return ["tool_start", "tool_success", "file_operation_start", "file_operation_success"].includes(type);
}

function compactEvent(stage, event = {}) {
  return {
    stage,
    type: event.type || "",
    status: event.status || "",
    tool: event.tool || event.request?.tool || "",
    agentId: event.agentId || event.source_agent_id || "",
    createdAt: event.createdAt || ""
  };
}

function publicScenario(scenario) {
  return {
    id: scenario.id,
    seed: scenario.seed,
    initialQuestion: scenario.initialQuestion,
    continueQuestion: scenario.continueQuestion,
    editQuestion: scenario.editQuestion
  };
}

function redactGroup(group = {}) {
  return {
    id: group.id || "",
    name: group.name || "",
    agents: (group.agents || []).map((agent) => ({
      id: agent.id || "",
      name: agent.name || "",
      provider: agent.provider || "",
      model: agent.model || "",
      apiKeySet: Boolean(agent.apiKey || agent.apiKeyEnv)
    }))
  };
}

function summarizeSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    question: session.question,
    continuationSource: session.continuationContext?.previousSessionId || "",
    messages: (session.messages || []).length,
    interimMessages: (session.interimMessages || []).length,
    toolResults: (session.toolExecutionResults || []).length,
    finalState: session.finalDecision?.final_state || ""
  };
}

function normalizeSeed(value) {
  const number = Number.parseInt(String(value ?? Date.now()), 10);
  return Number.isFinite(number) ? Math.abs(number) : Date.now();
}

function safeId(value) {
  return String(value || "baseline").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "baseline";
}

function check(id, passed, evidence) {
  return { id, passed: Boolean(passed), evidence };
}

function harnessFailure(code, message, harnessInfrastructure = false) {
  const error = new Error(message);
  error.code = code;
  error.harnessInfrastructure = harnessInfrastructure;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
