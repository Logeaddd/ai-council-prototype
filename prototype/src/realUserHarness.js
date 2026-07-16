import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import zlib from "node:zlib";
import { readZipArchiveEntries } from "./archiveTools.js";
import { CAMPAIGN_API_URL_TOKEN, createSeededCampaignScenario, EXTERNAL_ROOT_TOKEN, publicCampaignScenario } from "./realUserCampaign.js";
import { assertHardCampaignBudgetGroup, readCampaignBudgetLedger } from "./harnessCostGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(__dirname, "server.js");
const campaignSeatIdentities = new WeakMap();

export async function runSeededRealUserBaseline(options = {}) {
  const group = structuredClone(options.group || {});
  const scenario = normalizeScenario(options.scenario || createMinimumBaselineScenario(options.seed));
  assertRunnableGroup(group, { allowMockProvider: options.allowMockProvider === true });
  const providerEnvironment = moveGroupApiKeysToEnvironment(group, options.environment);
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
      environment: providerEnvironment
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
      environment: providerEnvironment
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
  const sourceCampaign = options.campaign || createSeededCampaignScenario({ seed: options.seed });
  assertRunnableGroup(group, { allowMockProvider: options.allowMockProvider === true });
  assertCampaignBudget(options, { allowMockProvider: options.allowMockProvider === true });
  if (options.allowMockProvider !== true) assertHardCampaignBudgetGroup(group);
  if (Number(options.maxModelCalls) > 0) group.settings.maxModelCalls = Number(options.maxModelCalls);
  const providerEnvironment = moveGroupApiKeysToEnvironment(group, options.environment);

  const outputRoot = path.resolve(options.outputDir || path.join(prototypeRoot, "eval", "real-user-campaign"));
  const runDir = path.join(outputRoot, `${safeId(sourceCampaign.id)}-${Date.now()}`);
  const dataDir = path.join(runDir, "data");
  const groupPath = path.join(dataDir, "workspace-ui", "campaign-group");
  let campaign = structuredClone(sourceCampaign);
  let apiFixture;
  const timeline = [];
  const startedAt = new Date().toISOString();
  let server;
  const interruptedSessions = [];
  let failure;
  let failureKind = "failed";

  fs.mkdirSync(runDir, { recursive: true });
  try {
    if (campaignNeedsApiFixture(sourceCampaign)) apiFixture = await startCampaignApiFixture(sourceCampaign.apiFixture);
    campaign = materializeCampaignPaths(sourceCampaign, runDir, options.externalWorkspaceRoot, apiFixture?.url);
    prepareGroupWorkspace(groupPath, group);
    prepareCampaignFixtures(groupPath, campaign.fixtures);
    if (campaign.externalWorkspaceRoot) prepareCampaignFixtures(campaign.externalWorkspaceRoot, campaign.externalFixtures);
    const environment = harnessEnvironment(providerEnvironment, Boolean(apiFixture), options.allowMockProvider === true ? undefined : {
      maxCostUsd: options.maxCostUsd,
      maxModelCalls: options.maxModelCalls
    });
    server = await startHarnessServer({ dataDir, workspaceRoot: dataDir, environment });
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
        if (!run.aborted) {
          const budgetStop = latestSessionGuardStopReason(groupPath, stage.prompt || "continue");
          if (budgetStop === "model_call_budget_exhausted") {
            throw harnessFailure("campaign_budget_exhausted_before_interrupt", "The campaign payment guard was exhausted before the requested interruption boundary was reached.");
          }
          throw harnessFailure("campaign_interrupt_did_not_reach_action", "Campaign interruption did not reach the requested activity boundary.");
        }
        const interruptedSession = await waitForSession(server.port, groupPath, (session) => (
          session.status === "interrupted" && !interruptedSessions.some((item) => item.id === session.id)
        ));
        interruptedSessions.push(interruptedSession);
        await stopHarnessServer(server);
        server = await startHarnessServer({ dataDir, workspaceRoot: dataDir, environment });
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

  try {
    const artifactDelivery = await verifyCampaignDeliverable(campaign.hiddenVerifier, groupPath);
    const sessions = listPersistedSessions(groupPath);
    const toolEvidence = verifyCampaignToolEvidence(campaign.hiddenVerifier, sessions);
    const delivery = {
      passed: artifactDelivery.passed && toolEvidence.passed,
      checks: [...artifactDelivery.checks, ...toolEvidence.checks]
    };
    const attemptedModelCalls = sessions.reduce((total, session) => total + Number(session.modelCallCount || 0), 0);
    const budgetLedger = readCampaignBudgetLedger(groupPath);
    const providerCalls = providerCallMetrics({
      attemptedModelCalls,
      budgetLedger,
      realProvider: options.allowMockProvider !== true
    });
    const persistence = verifyCampaignPersistence(groupPath, sessions, group);
    const replayRecovery = verifyNoDuplicateVerifiedWork(interruptedSessions, sessions);
    const resumption = verifyCampaignResumption(interruptedSessions, sessions);
    const recovery = {
      passed: replayRecovery.passed && resumption.passed,
      checks: [...replayRecovery.checks, ...resumption.checks]
    };
    const resumed = resumption.passed;
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
        observedModelCalls: providerCalls.observedModelCalls,
        attemptedModelCalls: providerCalls.attemptedModelCalls,
        blockedBeforeSendModelCalls: providerCalls.blockedBeforeSendModelCalls,
        budgetLedger: budgetLedger || null
      },
      scenario: publicCampaignScenario(campaign),
      group: redactGroup(group),
      workspacePath: groupPath,
      externalWorkspacePath: campaign.externalWorkspaceRoot || "",
      networkExercise: apiFixture
        ? {
          mode: "controlled_local_api",
          endpoint: apiFixture.url,
          requestsObserved: apiFixture.requests.length,
          limitation: "This verifies the real API tool path against a bounded harness service. It does not prove public-network reachability or real-provider autonomy."
        }
        : { mode: "not_required" },
      capabilityAcquisition: toolEvidence.acquisition,
      autonomousExecution: {
        campaignStagesExecuted: timeline.filter((item) => item.result === "completed").length,
        materialActionsObserved: timeline.filter((item) => isMaterialActionType(item.type)).length,
        resumedAfterInterruption: resumed,
        noDuplicateVerifiedWork: replayRecovery.passed,
        passed: !failure && resumed && persistence.passed && recovery.passed
      },
      minimumUsableDelivery: delivery,
      subjectiveQuality: { status: "not_scored" },
      sessions: { interrupted: interruptedSessions.map(summarizeSession), total: sessions.length, modelCalls: attemptedModelCalls },
      persistence,
      recovery,
      timeline
    };
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    return { runDir, groupPath, report };
  } finally {
    if (apiFixture) await stopCampaignApiFixture(apiFixture);
  }
}

function moveGroupApiKeysToEnvironment(group, environment = {}) {
  const next = { ...(environment || {}) };
  for (const agent of Array.isArray(group.agents) ? group.agents : []) {
    const apiKey = String(agent.apiKey || "");
    if (!apiKey) continue;
    const envName = String(agent.apiKeyEnv || `AI_COUNCIL_HARNESS_KEY_${createHash("sha256").update(String(agent.id || agent.name || "agent")).digest("hex").slice(0, 16).toUpperCase()}`);
    next[envName] = apiKey;
    agent.apiKeyEnv = envName;
    delete agent.apiKey;
  }
  return next;
}

export function providerCallMetrics({ attemptedModelCalls = 0, budgetLedger, realProvider = false } = {}) {
  const attempted = Math.max(0, Number(attemptedModelCalls) || 0);
  const ledgerCalls = Number(budgetLedger?.modelCalls);
  const observed = realProvider && Number.isFinite(ledgerCalls) ? Math.max(0, ledgerCalls) : attempted;
  return {
    observedModelCalls: observed,
    attemptedModelCalls: attempted,
    blockedBeforeSendModelCalls: Math.max(0, attempted - observed)
  };
}

function materializeCampaignPaths(sourceCampaign, runDir, externalWorkspaceRoot, apiUrl) {
  const requiresExternalWorkspace = JSON.stringify(sourceCampaign).includes(EXTERNAL_ROOT_TOKEN);
  const requiresApi = JSON.stringify(sourceCampaign).includes(CAMPAIGN_API_URL_TOKEN);
  if (requiresApi && !apiUrl) throw harnessFailure("campaign_api_fixture_missing", "API campaign needs a bounded harness API endpoint.", true);
  const externalRoot = requiresExternalWorkspace
    ? path.resolve(externalWorkspaceRoot || path.join(runDir, "external-user-project"))
    : "";
  if (externalRoot) fs.mkdirSync(externalRoot, { recursive: true });
  const serialized = JSON.stringify(sourceCampaign)
    .replaceAll(EXTERNAL_ROOT_TOKEN, externalRoot.replaceAll("\\", "/"))
    .replaceAll(CAMPAIGN_API_URL_TOKEN, String(apiUrl || ""));
  const campaign = JSON.parse(serialized);
  return externalRoot ? { ...campaign, externalWorkspaceRoot: externalRoot } : campaign;
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
  const noProgressTimeoutMs = positiveNumber(options.noProgressTimeoutMs, 120000);
  const events = [];
  let aborted = false;
  let stalled = false;
  let watchdog;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, noProgressTimeoutMs);
  };
  armWatchdog();
  try {
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
    for await (const event of readSseEvents(response.body)) {
      armWatchdog();
      events.push(event);
      options.onEvent?.(event);
      if (options.abortWhen?.(event)) {
        aborted = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (stalled) {
      throw harnessFailure("campaign_sse_no_progress_timeout", `Council SSE produced no event or heartbeat for ${noProgressTimeoutMs}ms.`, true);
    }
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(watchdog);
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
  const stableSeatIds = campaignSeatIdentities.get(group) || agents.map((agent) => agent.id);
  if (!campaignSeatIdentities.has(group)) campaignSeatIdentities.set(group, stableSeatIds);
  const agentAt = (value) => stableSeatIds[seatIndex(value)];
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

function latestSessionGuardStopReason(groupPath, question) {
  return listPersistedSessions(groupPath)
    .filter((session) => session.question === question)
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0]
    ?.guardStopReason || "";
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
    (session.toolExecutionResults || []).filter(isSuccessfulVerifiedWork).map(verifiedWorkFingerprint)
  )).filter(Boolean));
  const continuations = (sessions || []).filter((session) => interruptedById.has(session.continuationContext?.previousSessionId));
  const repeatedCommands = continuations.flatMap((session) => (
    (session.toolExecutionResults || []).filter(isSuccessfulVerifiedWork).filter((item) => verifiedFingerprints.has(verifiedWorkFingerprint(item)))
  ));
  const blockedReplays = continuations.flatMap((session) => session.rejectedToolRequests || [])
    .filter((item) => item.code === "already_verified_continuation_command");
  const checks = [
    check("verified_work_before_interruption", verifiedFingerprints.size > 0, `${verifiedFingerprints.size} successful verified-work fingerprints`),
    check("no_verified_command_replay_after_continue", repeatedCommands.length === 0, `${repeatedCommands.length} duplicate completed verification actions; ${blockedReplays.length} prevented replays`)
  ];
  return { passed: checks.every((item) => item.passed), checks };
}

export function verifyCampaignResumption(interruptedSessions = [], sessions = []) {
  const checks = [];
  for (const interrupted of (interruptedSessions || []).filter(Boolean)) {
    const continuations = (sessions || []).filter((session) => (
      session.continuationContext?.previousSessionId === interrupted.id
    ));
    const resumed = continuations.some((session) => (
      !["running", "interrupted"].includes(String(session.status || ""))
      && transcriptEntries(session).length > 0
    ));
    const detail = continuations.length
      ? continuations.map((session) => `${session.id}:${session.status || "unknown"}:visible=${transcriptEntries(session).length}`).join(", ")
      : "no continuation session";
    checks.push(check("continuation_completed_visible_work", resumed, `${interrupted.id}: ${detail}`));
  }
  if (!checks.length) checks.push(check("continuation_completed_visible_work", false, "no interrupted sessions"));
  return { passed: checks.every((item) => item.passed), checks };
}

export function verifyCampaignToolEvidence(verifier = {}, sessions = []) {
  const results = (sessions || []).flatMap((session) => session.toolExecutionResults || []);
  const checks = [];
  if (verifier.kind === "api_collection") {
    const expectedUrl = normalizeComparableUrl(verifier.apiUrl);
    const apiResults = results.filter((item) => item.tool === "api_request" && item.status === "completed" && item.result?.ok);
    const matched = apiResults.filter((item) => normalizeComparableUrl(item.result?.url || item.url) === expectedUrl);
    checks.push(
      check("api_request_recorded", apiResults.length > 0, `${apiResults.length} successful API requests persisted`),
      check("required_api_endpoint_requested", Boolean(expectedUrl) && matched.length > 0, `${matched.length}/${apiResults.length} successful requests matched the required endpoint`)
    );
  }
  const acquisitionTools = new Set(["install_package", "provision_tool", "skill_install", "mcp_install_npm"]);
  const acquisitionResults = results.map((item, index) => {
    if (acquisitionTools.has(item.tool) && item.status === "completed" && item.result?.ok !== false) return { item, index, kind: item.tool };
    if (isSuccessfulShellAcquisition(item)) return { item, index, kind: "execute_command_package_install" };
    return null;
  }).filter(Boolean);
  const usedAcquisitions = acquisitionResults.filter(({ item, index }) => results.slice(index + 1).some((later) => acquisitionFollowedByLaterWork(item, later)));
  const acquisition = {
    required: verifier.requiresAcquisition === true,
    passed: verifier.requiresAcquisition !== true || usedAcquisitions.length > 0,
    tools: [...new Set(usedAcquisitions.map(({ kind }) => kind))],
    acquiredTools: [...new Set(acquisitionResults.map(({ kind }) => kind))]
  };
  if (acquisition.required) {
    checks.push(check("capability_acquired_in_current_campaign", acquisitionResults.length > 0, acquisition.acquiredTools.join(", ") || "no successful acquisition tool result"));
    checks.push(check("acquired_capability_used_by_later_work", acquisition.passed, acquisition.tools.join(", ") || "no later successful tool referenced the acquired package, environment, skill, server or command"));
  }
  if (!checks.length) checks.push(check("required_tool_evidence", true, "not_required"));
  return { passed: checks.every((item) => item.passed), checks, acquisition };
}

function acquisitionFollowedByLaterWork(acquisition, later) {
  if (later.status !== "completed" || later.result?.ok === false) return false;
  const allowedLaterTools = acquisition.tool === "skill_install"
    ? new Set(["skill_read", "skill_enable", "execute_command", "run_code", "run_tests"])
    : acquisition.tool === "mcp_install_npm"
      ? new Set(["mcp_call", "mcp_list_tools", "execute_command", "run_code", "run_tests"])
      : new Set(["execute_command", "run_code", "run_tests"]);
  return allowedLaterTools.has(later.tool)
    && (later.tool !== "run_tests" || later.result?.passed !== false)
    && (later.tool !== "execute_command" || Number(later.result?.exitCode) === 0);
}

function isSuccessfulShellAcquisition(item) {
  if (item.tool !== "execute_command" || item.status !== "completed" || item.result?.ok === false || Number(item.result?.exitCode) !== 0) return false;
  const command = String(item.command || item.result?.command || "");
  if (!/(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:add|install)\b|\b(?:python|python3|py)(?:\.exe)?\s+-m\s+pip\s+install\b|(?:^|[;&|]\s*)pip3?\s+install\b|(?:^|[;&|]\s*)cargo\s+(?:add|install)\b|(?:^|[;&|]\s*)go\s+(?:get|install)\b|(?:^|[;&|]\s*)gem\s+install\b|(?:^|[;&|]\s*)(?:winget|choco|scoop|brew)\s+install\b|\bapt(?:-get)?\s+install\b/i.test(command)) return false;
  const output = `${item.result?.stdout || ""}\n${item.result?.stderr || ""}`;
  return !/(?:npm ERR!|permission denied|unable to acquire|could not open lock file|no module named ensurepip|command not found|not recognized as an internal or external command)/i.test(output);
}

function isSuccessfulVerifiedWork(item = {}) {
  if (!["execute_command", "run_code", "run_tests"].includes(item.tool)) return false;
  return item.status === "completed"
    && Number(item.result?.exitCode) === 0
    && (item.tool !== "run_tests" || item.result?.passed !== false)
    && Boolean(verifiedWorkPayload(item));
}

function verifiedWorkFingerprint(item = {}) {
  const payload = verifiedWorkPayload(item);
  return payload ? createHash("sha256").update(`${item.tool}\n${payload}`).digest("hex") : "";
}

function verifiedWorkPayload(item = {}) {
  if (item.tool === "execute_command") {
    return stableVerifiedWorkFields(item, ["command", "cwd", "shell"]);
  }
  if (item.tool === "run_code") {
    return stableVerifiedWorkFields(item, ["language", "code", "cwd"]);
  }
  if (item.tool === "run_tests") {
    return stableVerifiedWorkFields(item, ["runner", "command", "cwd"]);
  }
  return "";
}

function stableVerifiedWorkFields(item, keys) {
  const result = item.result || {};
  const values = keys.map((key) => String(item[key] ?? result[key] ?? "").trim().replace(/\s+/g, " ").toLowerCase());
  return values.some(Boolean) ? JSON.stringify(values) : "";
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

export async function verifyCampaignDeliverable(verifier = {}, groupPath) {
  const filePath = path.resolve(groupPath, String(verifier.file || ""));
  const checks = [check("file_exists", fs.existsSync(filePath), verifier.file || "")];
  if (verifier.kind === "json" && fs.existsSync(filePath)) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      checks.push(check("json_expected", Object.entries(verifier.expected || {}).every(([key, expected]) => value[key] === expected), JSON.stringify(value)));
    } catch (error) { checks.push(check("json_parses", false, error.message)); }
  } else if (verifier.kind === "api_collection" && fs.existsSync(filePath)) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      checks.push(check("api_collection_exact", stableJson(value) === stableJson(verifier.expected || {}), JSON.stringify({ keys: Object.keys(value || {}), itemCount: Array.isArray(value?.items) ? value.items.length : -1 })));
    } catch (error) { checks.push(check("api_collection_parses", false, error.message)); }
  } else if (verifier.kind === "csv" && fs.existsSync(filePath)) {
    try {
      const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
      const [headers = [], ...records] = rows;
      const expectedHeaders = (verifier.headers || []).map(String);
      const expectedRows = (verifier.rows || []).map((row) => row.map(String));
      checks.push(check("csv_parses", rows.length > 0, `${rows.length} rows`));
      checks.push(check("csv_headers", JSON.stringify(headers) === JSON.stringify(expectedHeaders), JSON.stringify(headers)));
      checks.push(check("csv_rows", JSON.stringify(records) === JSON.stringify(expectedRows), JSON.stringify(records)));
    } catch (error) { checks.push(check("csv_parses", false, error.message)); }
  } else if (verifier.kind === "zip" && fs.existsSync(filePath)) {
    try {
      const entries = readZipArchiveEntries(filePath).map((entry) => ({ name: entry.name, content: entry.content.toString("utf8") }));
      const expected = (verifier.entries || []).map((entry) => ({ name: String(entry.name), content: String(entry.content) }));
      checks.push(check("zip_entries", JSON.stringify(entries.map((entry) => entry.name)) === JSON.stringify(expected.map((entry) => entry.name)), JSON.stringify(entries.map((entry) => entry.name))));
      checks.push(check("zip_contents", JSON.stringify(entries) === JSON.stringify(expected), `${entries.length} extracted entries`));
    } catch (error) { checks.push(check("zip_parses", false, error.message)); }
  } else if (verifier.kind === "png_rgba" && fs.existsSync(filePath)) {
    try {
      const image = decodeRgbaPng(fs.readFileSync(filePath));
      checks.push(check("png_dimensions", image.width === verifier.width && image.height === verifier.height, `${image.width}x${image.height}`));
      checks.push(check("png_rgba_pixels", Buffer.from(verifier.pixels || []).equals(image.pixels), `${image.pixels.length} decoded bytes`));
    } catch (error) { checks.push(check("png_rgba_parses", false, error.message)); }
  } else if (["node_cli", "python_cli"].includes(verifier.kind)) {
    const command = verifier.kind === "python_cli" ? "python" : process.execPath;
    const result = await runProcess(command, [filePath, ...(verifier.args || [])]);
    checks.push(check("command_exit", result.exitCode === 0, `exit=${result.exitCode}`));
    checks.push(check("final_requirement", result.stdout.trim() === verifier.expectedOutput, result.stdout.trim()));
  }
  return { passed: checks.every((item) => item.passed), checks };
}

function decodeRgbaPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) throw new Error("invalid_png_signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let ended = false;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("truncated_png_chunk");
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = pngCrc32(buffer.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`invalid_png_crc:${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("png_must_be_non_interlaced_8bit_rgba");
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!(width > 0) || !(height > 0) || !compressed.length || !ended) throw new Error("png_missing_image_data");
  if (width * height > 16 * 1024 * 1024) throw new Error("png_pixel_limit_exceeded");
  const stride = width * 4;
  const expectedRawLength = height * (stride + 1);
  const raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedRawLength });
  if (raw.length !== expectedRawLength) throw new Error("unexpected_png_scanline_length");
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const target = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? target[x - 4] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= 4 ? prior[x - 4] : 0;
      if (filter === 0) target[x] = source[x];
      else if (filter === 1) target[x] = (source[x] + left) & 255;
      else if (filter === 2) target[x] = (source[x] + up) & 255;
      else if (filter === 3) target[x] = (source[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) target[x] = (source[x] + paeth(left, up, upLeft)) & 255;
      else throw new Error(`unsupported_png_filter:${filter}`);
    }
  }
  return { width, height, pixels };
}

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  return leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
      continue;
    }
    if (!quoted && character === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  if (quoted) throw new Error("unterminated_csv_quote");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value !== ""));
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

export function prepareGroupWorkspace(groupPath, group) {
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
  const packageBoundary = path.join(groupPath, "package.json");
  if (!fs.existsSync(packageBoundary)) {
    fs.writeFileSync(packageBoundary, JSON.stringify({
      name: "ai-council-harness-workspace",
      version: "0.0.0",
      private: true
    }, null, 2) + "\n", "utf8");
  }
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupFolderName: "baseline-group",
    groupPath,
    permissions: { defaultTier: "full", seatTiers: {} },
    seats
  }, null, 2), "utf8");
}

function campaignNeedsApiFixture(campaign = {}) {
  return JSON.stringify(campaign).includes(CAMPAIGN_API_URL_TOKEN);
}

function harnessEnvironment(environment = {}, allowLocalHttp = false, realCampaignBudget = undefined) {
  return {
    ...(environment || {}),
    ...(allowLocalHttp ? { AI_COUNCIL_HARNESS_ALLOW_LOCAL_HTTP: "1" } : {}),
    ...(realCampaignBudget ? {
      AI_COUNCIL_HARNESS_MAX_COST_USD: String(realCampaignBudget.maxCostUsd),
      AI_COUNCIL_HARNESS_MAX_MODEL_CALLS: String(realCampaignBudget.maxModelCalls)
    } : {})
  };
}

async function startCampaignApiFixture(fixture = {}) {
  const pathname = String(fixture.path || "").trim();
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(pathname)) {
    throw harnessFailure("invalid_campaign_api_fixture", "Campaign API fixture path must be a bounded absolute HTTP path.", true);
  }
  const body = JSON.stringify(fixture.body || {});
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) {
    throw harnessFailure("campaign_api_fixture_too_large", "Campaign API fixture exceeds the bounded 64KB response budget.", true);
  }
  const requests = [];
  const listener = http.createServer((req, res) => {
    requests.push({ method: req.method || "", pathname: new URL(req.url || "/", "http://fixture.invalid").pathname });
    if (req.method !== "GET" || new URL(req.url || "/", "http://fixture.invalid").pathname !== pathname) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    await new Promise((resolve) => listener.close(resolve));
    throw harnessFailure("campaign_api_fixture_start_failed", "Campaign API fixture did not receive a local TCP port.", true);
  }
  return { listener, url: `http://127.0.0.1:${port}${pathname}`, requests };
}

async function stopCampaignApiFixture(fixture) {
  if (!fixture?.listener || !fixture.listener.listening) return;
  await new Promise((resolve, reject) => fixture.listener.close((error) => error ? reject(error) : resolve()));
}

export function prepareCampaignFixtures(groupPath, fixtures = []) {
  const root = path.resolve(groupPath);
  for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
    const target = path.resolve(root, String(fixture?.path || ""));
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw harnessFailure("invalid_campaign_fixture", `Campaign fixture escapes the group workspace: ${fixture?.path || ""}`, true);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(fixture?.content || ""), "utf8");
  }
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
  if (server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await Promise.race([
      once(server.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
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

export function isStreamingActivityEvent(event = {}) {
  return ["agent_start", "model_start", "agent_delta"].includes(event.type);
}

function isVerifiedToolActivityEvent(event = {}) {
  return event.type === "tool_success"
    && ["execute_command", "run_code", "run_tests"].includes(event.tool)
    && event.status === "completed";
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

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
