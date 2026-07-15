import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createSeededCampaignScenario, publicCampaignScenario } from "./realUserCampaign.js";

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

export async function runSeededRealUserCampaign(options = {}) {
  const group = structuredClone(options.group || {});
  const campaign = options.campaign || createSeededCampaignScenario({ seed: options.seed });
  assertRunnableGroup(group, { allowMockProvider: options.allowMockProvider === true });
  assertCampaignBudget(options, { allowMockProvider: options.allowMockProvider === true });
  if (Number(options.maxModelCalls) > 0) group.settings.maxModelCalls = Number(options.maxModelCalls);

  const outputRoot = path.resolve(options.outputDir || path.join(prototypeRoot, "eval", "real-user-campaign"));
  const runDir = path.join(outputRoot, `${safeId(campaign.id)}-${Date.now()}`);
  const dataDir = path.join(runDir, "data");
  const groupPath = path.join(dataDir, "workspace-ui", "campaign-group");
  const timeline = [];
  const startedAt = new Date().toISOString();
  let server;
  const interruptedSessions = [];
  let failure;
  let failureKind = "failed";

  fs.mkdirSync(runDir, { recursive: true });
  try {
    prepareGroupWorkspace(groupPath, group);
    server = await startHarnessServer({ dataDir, workspaceRoot: dataDir, environment: options.environment });
    for (const stage of campaign.stages || []) {
      if (stage.kind === "user" || stage.kind === "initial" || stage.kind === "followup" || stage.kind === "reopen") {
        const run = await postCouncilEvents({
          port: server.port,
          group,
          groupPath,
          question: stage.prompt,
          onEvent(event) { timeline.push(compactCampaignEvent(stage, event)); }
        });
        timeline.push({ stageId: stage.id, kind: stage.kind, result: "completed", events: run.events.length });
        continue;
      }
      if (stage.kind === "member_mutation") {
        const mutation = await applyCampaignMutation(server.port, groupPath, group, stage.mutation);
        timeline.push({ stageId: stage.id, kind: stage.kind, mutation: stage.mutation?.type || "", result: mutation.ok ? "completed" : "failed" });
        continue;
      }
      if (stage.kind === "interrupt") {
        const run = await postCouncilEvents({
          port: server.port,
          group,
          groupPath,
          question: stage.prompt || "continue",
          onEvent(event) { timeline.push(compactCampaignEvent(stage, event)); },
          abortWhen: stage.interruptAt === "during_model_streaming" ? isStreamingActivityEvent : isVerifiedToolActivityEvent
        });
        if (!run.aborted) throw harnessFailure("campaign_interrupt_did_not_reach_action", "Campaign interruption did not reach the requested activity boundary.");
        const interruptedSession = await waitForSession(server.port, groupPath, (session) => (
          session.status === "interrupted" && !interruptedSessions.some((item) => item.id === session.id)
        ));
        interruptedSessions.push(interruptedSession);
        await stopHarnessServer(server);
        server = await startHarnessServer({ dataDir, workspaceRoot: dataDir, environment: options.environment });
        timeline.push({ stageId: stage.id, kind: stage.kind, interruptAt: stage.interruptAt, result: "interrupted", sessionId: interruptedSession.id });
        continue;
      }
      timeline.push({ stageId: stage.id, kind: stage.kind, result: "checkpoint" });
    }
  } catch (error) {
    failure = error;
    failureKind = error?.harnessInfrastructure ? "infrastructure_error" : "failed";
  } finally {
    if (server) await stopHarnessServer(server);
  }

  const delivery = await verifyCampaignDeliverable(campaign.hiddenVerifier, groupPath);
  const sessions = listPersistedSessions(groupPath);
  const modelCalls = sessions.reduce((total, session) => total + Number(session.modelCallCount || 0), 0);
  const persistence = verifyCampaignPersistence(groupPath, sessions, group);
  const recovery = verifyNoDuplicateVerifiedWork(interruptedSessions, sessions);
  const resumedSources = new Set(sessions
    .filter((session) => session.question === "continue")
    .map((session) => session.continuationContext?.previousSessionId)
    .filter(Boolean));
  const resumed = interruptedSessions.length > 0 && interruptedSessions.every((session) => resumedSources.has(session.id));
  const report = {
    schema: "ai-council.real-user-campaign-run.v1",
    startedAt,
    completedAt: new Date().toISOString(),
    status: failure ? failureKind : delivery.passed && interruptedSessions.length === 2 && resumed && persistence.passed && recovery.passed ? "passed" : "failed",
    error: failure ? String(failure.message || failure).slice(0, 1600) : "",
    seed: campaign.seed,
    providerAcceptance: {
      mode: options.allowMockProvider === true ? "local_fake_provider_plumbing" : "real_provider",
      realProvider: options.allowMockProvider !== true,
      maxCostUsd: Number(options.maxCostUsd || 0),
      maxModelCalls: Number(options.maxModelCalls || 0),
      observedModelCalls: modelCalls
    },
    scenario: publicCampaignScenario(campaign),
    group: redactGroup(group),
    workspacePath: groupPath,
    autonomousExecution: {
      campaignStagesExecuted: timeline.filter((item) => item.result === "completed").length,
      materialActionsObserved: timeline.filter((item) => isMaterialActionType(item.type)).length,
      resumedAfterInterruption: resumed,
      noDuplicateVerifiedWork: recovery.passed,
      passed: !failure && resumed && persistence.passed && recovery.passed
    },
    minimumUsableDelivery: delivery,
    subjectiveQuality: { status: "not_scored" },
    sessions: { interrupted: interruptedSessions.map(summarizeSession), total: sessions.length, modelCalls },
    persistence,
    recovery,
    timeline
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

function assertCampaignBudget(options = {}, { allowMockProvider }) {
  if (allowMockProvider) return;
  const maxCostUsd = Number(options.maxCostUsd);
  const maxModelCalls = Number(options.maxModelCalls);
  if (!(maxCostUsd > 0) || !(maxModelCalls > 0)) {
    throw harnessFailure("campaign_budget_required", "A real user campaign requires explicit positive maxCostUsd and maxModelCalls.", true);
  }
}

async function applyCampaignMutation(port, groupPath, group, mutation = {}) {
  const agents = group.agents || [];
  const agentAt = (value) => agents[seatIndex(value)].id;
  if (mutation.type === "reorder") {
    const seatIds = mutation.seatIds.map(agentAt);
    const response = await postJson(port, "/api/group/seats/reorder", { groupPath, seatIds });
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    group.agents = seatIds.map((id) => byId.get(id));
    return response;
  }
  const seatId = agentAt(mutation.seatId);
  const patch = mutation.type === "rename"
    ? { displayName: mutation.displayName }
    : mutation.type === "disable"
      ? { enabled: false }
      : mutation.type === "restore"
        ? { enabled: true, role: mutation.role || "ordinary" }
        : { role: mutation.role || "ordinary" };
  const response = await postJson(port, "/api/group/seat", { groupPath, seatId, patch });
  const agent = agents.find((item) => item.id === seatId);
  if (agent) applyRuntimeAgentMutation(agent, patch);
  return response;
}

function seatIndex(value) {
  const match = String(value || "").match(/(\d+)$/);
  return Math.max(0, Number(match?.[1] || 1) - 1);
}

function applyRuntimeAgentMutation(agent, patch) {
  if (patch.displayName !== undefined) agent.name = patch.displayName;
  if (patch.enabled !== undefined) agent.enabled = Boolean(patch.enabled);
  if (patch.role === "reviewer") {
    agent.reviewer = true;
    agent.mandatoryRedTeam = true;
    agent.judge = false;
  } else if (patch.role === "summarizer") {
    agent.reviewer = false;
    agent.mandatoryRedTeam = false;
    agent.judge = true;
  } else if (patch.role) {
    agent.reviewer = false;
    agent.mandatoryRedTeam = false;
    agent.judge = false;
  }
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw harnessFailure("campaign_mutation_failed", `Campaign mutation ${pathname} failed with HTTP ${response.status}.`, true);
  return response.json();
}

function compactCampaignEvent(stage, event) {
  return { stageId: stage.id, ...compactEvent(stage.kind, event) };
}

function listPersistedSessions(groupPath) {
  const root = path.join(groupPath, "sessions");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

export function verifyCampaignPersistence(groupPath, sessions, runtimeGroup) {
  const checks = [];
  const taskStatePath = path.join(groupPath, "shared", "task_state.json");
  let taskState;
  try { taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf8")); } catch {}
  checks.push(check("task_state_persisted", Boolean(taskState), taskStatePath));
  const group = readJsonIfExists(path.join(groupPath, "group.json"));
  const expectedSeats = (runtimeGroup.agents || []).map(runtimeSeatSnapshot);
  const persistedSeats = (group?.seats || []).map(persistedSeatSnapshot);
  const memberStatePersisted = expectedSeats.length > 0
    && expectedSeats.length === persistedSeats.length
    && expectedSeats.every((seat, index) => sameSeatState(seat, persistedSeats[index]));
  checks.push(check("member_state_persisted", memberStatePersisted, JSON.stringify({ expectedSeats, persistedSeats })));

  const rawVisibleMessages = sessions.flatMap((session) => transcriptEntries(session));
  const renderedVisibleMessages = sessions.flatMap((session) => visibleTranscriptMessages(session));
  const timestampsPresent = rawVisibleMessages.every((message) => Number.isFinite(Date.parse(message.createdAt || "")));
  const visibleHistoryComplete = rawVisibleMessages.length === renderedVisibleMessages.length;
  const chronological = sessions.every((session) => isChronological(visibleTranscriptMessages(session)));
  checks.push(check("visible_history_timestamped", timestampsPresent, `${rawVisibleMessages.length} persisted visible messages`));
  checks.push(check("visible_history_complete", visibleHistoryComplete, `${rawVisibleMessages.length}/${renderedVisibleMessages.length} visible messages`));
  checks.push(check("visible_history_chronological", chronological, `${sessions.length} persisted sessions`));
  return { passed: checks.every((item) => item.passed), checks };
}

export function verifyNoDuplicateVerifiedWork(interruptedSessions = [], sessions = []) {
  const interruptedById = new Map((interruptedSessions || []).filter(Boolean).map((session) => [session.id, session]));
  const verifiedFingerprints = new Set([...interruptedById.values()].flatMap((session) => (
    (session.toolExecutionResults || []).filter(isSuccessfulCommand).map(commandFingerprint)
  )).filter(Boolean));
  const continuations = (sessions || []).filter((session) => interruptedById.has(session.continuationContext?.previousSessionId));
  const repeatedCommands = continuations.flatMap((session) => (
    (session.toolExecutionResults || []).filter(isSuccessfulCommand).filter((item) => verifiedFingerprints.has(commandFingerprint(item)))
  ));
  const blockedReplays = continuations.flatMap((session) => session.rejectedToolRequests || [])
    .filter((item) => item.code === "already_verified_continuation_command");
  const checks = [
    check("verified_work_before_interruption", verifiedFingerprints.size > 0, `${verifiedFingerprints.size} successful command fingerprints`),
    check("no_verified_command_replay_after_continue", repeatedCommands.length === 0, `${repeatedCommands.length} duplicate completed commands; ${blockedReplays.length} prevented replays`)
  ];
  return { passed: checks.every((item) => item.passed), checks };
}

function isSuccessfulCommand(item = {}) {
  return item.tool === "execute_command"
    && item.status === "completed"
    && Number(item.result?.exitCode) === 0
    && Boolean(item.command || item.result?.command);
}

function commandFingerprint(item = {}) {
  const command = String(item.command || item.result?.command || "").trim().replace(/\s+/g, " ").toLowerCase();
  return command ? createHash("sha256").update(command).digest("hex") : "";
}

function runtimeSeatSnapshot(agent = {}) {
  return {
    seatId: String(agent.id || ""),
    displayName: String(agent.name || ""),
    role: agent.judge ? "summarizer" : agent.mandatoryRedTeam ? "reviewer" : "ordinary",
    enabled: agent.enabled !== false
  };
}

function persistedSeatSnapshot(seat = {}) {
  return {
    seatId: String(seat.seatId || seat.id || ""),
    displayName: String(seat.displayName || seat.name || ""),
    role: String(seat.role || "ordinary"),
    enabled: seat.enabled !== false
  };
}

function sameSeatState(expected, actual) {
  return Boolean(actual)
    && expected.seatId === actual.seatId
    && expected.displayName === actual.displayName
    && expected.role === actual.role
    && expected.enabled === actual.enabled;
}

function transcriptEntries(session = {}) {
  return [
    ...(Array.isArray(session.interimMessages) ? session.interimMessages : []),
    ...(Array.isArray(session.messages) ? session.messages : [])
  ];
}

function visibleTranscriptMessages(session = {}) {
  return transcriptEntries(session).map((message, index) => ({ message, index })).sort((left, right) => {
    const time = Date.parse(left.message.createdAt || "") - Date.parse(right.message.createdAt || "");
    if (time) return time;
    const call = Number(left.message.modelCallIndex || 0) - Number(right.message.modelCallIndex || 0);
    return call || left.index - right.index;
  }).map((entry) => entry.message);
}

function isChronological(messages) {
  let previous = -Infinity;
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt || "");
    if (!Number.isFinite(timestamp) || timestamp < previous) return false;
    previous = timestamp;
  }
  return true;
}

function readJsonIfExists(filePath) {
  try { return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : undefined; } catch { return undefined; }
}

async function verifyCampaignDeliverable(verifier = {}, groupPath) {
  const filePath = path.resolve(groupPath, String(verifier.file || ""));
  const checks = [check("file_exists", fs.existsSync(filePath), verifier.file || "")];
  if (verifier.kind === "json" && fs.existsSync(filePath)) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      checks.push(check("json_expected", Object.entries(verifier.expected || {}).every(([key, expected]) => value[key] === expected), JSON.stringify(value)));
    } catch (error) { checks.push(check("json_parses", false, error.message)); }
  } else if (["node_cli", "python_cli"].includes(verifier.kind)) {
    const command = verifier.kind === "python_cli" ? "python" : process.execPath;
    const result = await runProcess(command, [filePath, ...(verifier.args || [])]);
    checks.push(check("command_exit", result.exitCode === 0, `exit=${result.exitCode}`));
    checks.push(check("final_requirement", result.stdout.trim() === verifier.expectedOutput, result.stdout.trim()));
  }
  return { passed: checks.every((item) => item.passed), checks };
}

function runProcess(command, args) {
  const result = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  result.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  const timer = setTimeout(() => result.kill(), 10000);
  return new Promise((resolve) => result.once("exit", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8") });
  }));
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

function isStreamingActivityEvent(event = {}) {
  return event.type === "agent_delta" || event.type === "model_start";
}

function isVerifiedToolActivityEvent(event = {}) {
  return event.type === "tool_success" && event.tool === "execute_command" && event.status === "completed";
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
