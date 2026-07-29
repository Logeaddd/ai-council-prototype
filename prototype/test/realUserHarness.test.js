import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { campaignProviderFailureReason, classifyCampaignDelivery, isStreamingActivityEvent, postCouncilEvents, prepareCampaignFixtures, prepareGroupWorkspace, providerCallMetrics, runSeededRealUserBaseline, runSeededRealUserCampaign, seedCampaignHistory, verifyCampaignCollaboration, verifyCampaignDeliverable, verifyCampaignPersistence, verifyCampaignResumption, verifyCampaignToolEvidence, verifyNoDuplicateVerifiedWork, waitForHarnessHealth } from "../src/realUserHarness.js";
import { createSeededCampaignScenario, EXTERNAL_ROOT_TOKEN, publicCampaignScenario } from "../src/realUserCampaign.js";
import { queryPublicEventPage } from "../src/publicEventJournal.js";

test("seeded real-user baseline uses the HTTP/SSE route, persists interruption, continues after restart, and verifies an edited artifact", async () => {
  const provider = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Completed the requested work.",
        consensus_score: 1,
        supporting_agents: ["Worker"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    nonFinalCalls += 1;
    if (nonFinalCalls === 1 || nonFinalCalls === 2) {
      writeOpenAiStream(res, roundResponse("Hello"));
      return;
    }
    if (nonFinalCalls === 4) {
      writeOpenAiStream(res, roundResponse("Welcome"));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({ status: "speak", argument: "The requested program was written and verified.", objections: [], confidence: 1, memory_candidates: [] }));
  });
  let nonFinalCalls = 0;
  await listen(provider);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-real-user-"));
  try {
    const group = {
      id: "baseline-group",
      name: "Baseline Group",
      settings: { maxRounds: 1, minRounds: 1, allowSoloCouncil: true, stopWhenAllSkip: false },
      agents: [{
        id: "worker",
        name: "Worker",
        role: "Build the requested deliverable using available tools.",
        provider: "openai-compatible",
        apiBaseUrl: `http://127.0.0.1:${provider.address().port}`,
        allowUnsafePrivateNetwork: true,
        apiKey: "test-key",
        model: "test-model",
        weight: 1,
        enabled: true
      }]
    };
    const scenario = {
      id: "controlled-greeting",
      seed: 42,
      file: "deliverables/greeting.js",
      initialQuestion: "Create the requested program.",
      continueQuestion: "continue",
      editQuestion: "Change the existing greeting.",
      verify: { args: ["--name", "Ada"], expectedOutput: "Welcome, Ada." }
    };
    const run = await runSeededRealUserBaseline({ group, scenario, outputDir, allowMockProvider: true });

    assert.equal(run.report.status, "passed", JSON.stringify(run.report, null, 2));
    assert.equal(run.report.autonomousExecution.initialRunAbortedAfterAction, true);
    assert.equal(run.report.sessions.interrupted.status, "interrupted");
    assert.equal(run.report.sessions.checks.passed, true);
    assert.equal(run.report.minimumUsableDelivery.passed, true);
    assert.equal(fs.existsSync(path.join(run.runDir, "report.json")), true);
    assert.equal(JSON.stringify(run.report).includes("test-key"), false, "baseline reports must not expose provider credentials");
  } finally {
    await close(provider);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("real-provider campaign reporting uses the durable budget ledger for sent-call counts", () => {
  const metrics = providerCallMetrics({
    realProvider: true,
    attemptedModelCalls: 124,
    budgetLedger: { modelCalls: 120 }
  });
  assert.deepEqual(metrics, {
    observedModelCalls: 120,
    attemptedModelCalls: 124,
    blockedBeforeSendModelCalls: 4
  });
  assert.deepEqual(providerCallMetrics({ realProvider: false, attemptedModelCalls: 7 }), {
    observedModelCalls: 7,
    attemptedModelCalls: 7,
    blockedBeforeSendModelCalls: 0
  });
});

test("real HTTP/SSE campaign requests fail as infrastructure when no event or heartbeat arrives", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.flushHeaders();
  });
  await listen(server);
  try {
    await assert.rejects(() => postCouncilEvents({
      port: server.address().port,
      group: { id: "stalled-group", agents: [] },
      groupPath: "/tmp/stalled-group",
      question: "continue",
      noProgressTimeoutMs: 50
    }), (error) => error.code === "campaign_sse_no_progress_timeout" && error.harnessInfrastructure === true);
  } finally {
    await close(server);
  }
});

test("harness startup times out when a listening server never answers health requests", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    // Leave the response open: a TCP listener alone is not a healthy harness server.
  });
  await listen(server);
  try {
    await assert.rejects(() => waitForHarnessHealth(server.address().port, { exitCode: null }, () => "child still running", {
      timeoutMs: 80,
      pollMs: 5,
      requestTimeoutMs: 10
    }), (error) => error.code === "server_start_timeout" && error.harnessInfrastructure === true && /child still running/.test(error.message));
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test("model-stream interruption can close at real agent start before text or tool output", () => {
  assert.equal(isStreamingActivityEvent({ type: "agent_start" }), true);
  assert.equal(isStreamingActivityEvent({ type: "agent_delta" }), true);
  assert.equal(isStreamingActivityEvent({ type: "tool_start" }), false);
});

test("provider exhaustion is infrastructure evidence instead of an agent interruption failure", () => {
  const exhausted = campaignProviderFailureReason({
    messages: [
      { response: { status: "unavailable", reason: "agent_call_failed:builder:HTTP 402: Insufficient Balance" } },
      { response: { status: "unavailable", reason: "agent_call_failed:builder:HTTP 402: Insufficient Balance" } }
    ]
  });
  assert.match(exhausted, /provider calls were unavailable/i);
  assert.equal(campaignProviderFailureReason({
    messages: [
      { response: { status: "unavailable", reason: "agent_call_failed:builder:HTTP 402: Insufficient Balance" } },
      { response: { status: "speak", argument: "Another member completed the work." } }
    ]
  }), "");
});

test("campaign recovery requires completed visible work after every interruption", () => {
  const interrupted = [{ id: "interrupted-one" }, { id: "interrupted-two" }];
  const sessions = [
    {
      id: "continued-one",
      status: "incomplete",
      continuationContext: { previousSessionId: "interrupted-one" },
      messages: [{ createdAt: "2026-07-16T00:00:00.000Z" }]
    },
    {
      id: "continued-two",
      status: "interrupted",
      continuationContext: { previousSessionId: "interrupted-two" },
      messages: []
    }
  ];
  const failed = verifyCampaignResumption(interrupted, sessions);
  assert.equal(failed.passed, false);
  assert.equal(failed.checks.filter((item) => !item.passed).length, 1);

  sessions[1] = {
    ...sessions[1],
    status: "completed",
    messages: [{ createdAt: "2026-07-16T00:01:00.000Z" }]
  };
  assert.equal(verifyCampaignResumption(interrupted, sessions).passed, true);
});

test("campaign recovery recognizes successful run_code and run_tests as verified work without allowing replay", () => {
  const interrupted = [{
    id: "interrupted-verified-tools",
    toolExecutionResults: [
      { tool: "run_code", status: "completed", language: "node", code: "console.log('verified')", result: { exitCode: 0 } },
      { tool: "run_tests", status: "completed", runner: "custom", command: "node --test", cwd: "shared/app", result: { exitCode: 0, passed: true } }
    ]
  }];
  const cleanContinuation = [{ id: "continued", continuationContext: { previousSessionId: "interrupted-verified-tools" }, toolExecutionResults: [] }];
  const clean = verifyNoDuplicateVerifiedWork(interrupted, cleanContinuation);
  assert.equal(clean.passed, true);
  assert.match(clean.checks[0].evidence, /2 successful verified-work fingerprints/);

  const replayed = verifyNoDuplicateVerifiedWork(interrupted, [{
    ...cleanContinuation[0],
    toolExecutionResults: [{ tool: "run_code", status: "completed", language: "node", code: "console.log('verified')", result: { exitCode: 0 } }]
  }]);
  assert.equal(replayed.passed, false);
  assert.match(replayed.checks[1].evidence, /1 duplicate completed verification actions/);
});

test("real-user baseline rejects mock providers outside its plumbing test mode", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-real-user-reject-"));
  try {
    await assert.rejects(() => runSeededRealUserBaseline({
      outputDir,
      group: {
        id: "mock-group",
        name: "Mock Group",
        agents: [{ id: "mock", name: "Mock", role: "Test", provider: "mock", apiBaseUrl: "mock://local", model: "mock", weight: 1, enabled: true }]
      }
    }), (error) => error.code === "mock_provider_denied");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("seeded campaign drives HTTP/SSE stages, member disturbances and interruption recovery", async () => {
  const campaign = createSeededCampaignScenario({ seed: 3 });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-real-campaign-"));
  const externalWorkspaceRoot = path.join(outputDir, "user-authorized-project");
  const campaignFile = campaign.hiddenVerifier.file.replaceAll(EXTERNAL_ROOT_TOKEN, externalWorkspaceRoot.replaceAll("\\", "/"));
  const code = `const index = process.argv.indexOf('--name');\nconst name = index >= 0 ? process.argv[index + 1] : '';\nconsole.log('Thanks, ' + name + '.');\n`;
  const provider = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({ answer: "Completed.", consensus_score: 1, supporting_agents: ["Worker"], dissenting_agents: [], minority_report: "", risks: [], next_actions: [], selected_file_operation_ids: [], memory_candidates: [] }));
      return;
    }
    if (prompt.includes("Tool results from your previous request are now available")) {
      writeOpenAiStream(res, JSON.stringify({ status: "speak", argument: "The current deliverable was written and verified.", objections: [], confidence: 1, memory_candidates: [] }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I will update the requested deliverable.",
      objections: [],
      confidence: 1,
      memory_candidates: [],
      tool_requests: [
        { tool: "workspace_edit", action: "write", path: campaignFile, code, reason: "Write the current requested CLI." },
        { tool: "execute_command", command: `node ${JSON.stringify(campaignFile)} --name Ada`, shell: "system", reason: "Verify the current deliverable." }
      ]
    }));
  });
  await listen(provider);
  try {
    const agent = (id, name) => ({ id, name, role: "Deliver the requested artifact.", provider: "openai-compatible", apiBaseUrl: `http://127.0.0.1:${provider.address().port}`, allowUnsafePrivateNetwork: true, apiKey: "test-key", model: "test-model", weight: 1, enabled: true });
    const run = await runSeededRealUserCampaign({
      group: { id: "campaign-group", name: "Campaign Group", settings: { maxRounds: 1, minRounds: 1, allowSoloCouncil: true, stopWhenAllSkip: false }, agents: [agent("worker", "Worker"), agent("reviewer", "Reviewer"), agent("judge", "Judge")] },
      campaign,
      outputDir,
      externalWorkspaceRoot,
      allowMockProvider: true
    });
    assert.equal(run.report.status, "passed", JSON.stringify(run.report, null, 2));
    assert.equal(run.report.autonomousExecution.resumedAfterInterruption, true);
    assert.equal(run.report.sessions.interrupted.length, 2);
    assert.equal(run.report.minimumUsableDelivery.passed, true);
    assert.equal(run.report.capabilityAcquisition.executionReceipt.schema, "ai-council.capability-execution-receipt.v1");
    assert.equal(run.report.collaboration.executionReceipt.schema, "ai-council.collaboration-execution-receipt.v1");
    assert.equal(run.report.collaboration.executionReceipt.sessionFiles.length > 0, true);
    assert.equal(run.report.persistence.passed, true);
    assert.equal(run.report.persistence.checks.every((check) => check.passed), true);
    assert.equal(run.report.persistence.checks.find((check) => check.id === "user_stage_questions_persisted")?.passed, true);
    assert.equal(run.report.persistence.checks.find((check) => check.id === "user_stage_questions_chronological")?.passed, true);
    assert.equal(run.report.recovery.passed, true);
    assert.equal(run.report.recovery.checks.every((check) => check.passed), true);
    assert.equal(path.isAbsolute(run.report.externalWorkspacePath), true);
    assert.equal(run.report.externalWorkspacePath.startsWith(run.groupPath), false);
    assert.equal(run.report.timeline.some((item) => item.mutation === "reorder" && item.result === "completed"), true);
    assert.equal(JSON.stringify(run.report).includes("test-key"), false);
    assert.deepEqual(findSecretFiles(run.runDir, "test-key"), []);
  } finally {
    await close(provider);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("campaign persistence rejects missing visible-message timestamps and lost member mutations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-persistence-"));
  try {
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "shared", "task_state.json"), "{}", "utf8");
    fs.writeFileSync(path.join(root, "group.json"), JSON.stringify({
      seats: [{ seatId: "worker", displayName: "Old name", role: "ordinary", enabled: true }]
    }), "utf8");
    const persistence = verifyCampaignPersistence(root, [{
      interimMessages: [{ createdAt: "", modelCallIndex: 1 }],
      messages: [{ createdAt: "2026-07-15T00:00:01.000Z", modelCallIndex: 2 }]
    }], {
      agents: [{ id: "worker", name: "Renamed worker", mandatoryRedTeam: true, enabled: false }]
    });
    assert.equal(persistence.passed, false);
    assert.equal(persistence.checks.find((check) => check.id === "visible_history_timestamped")?.passed, false);
    assert.equal(persistence.checks.find((check) => check.id === "member_state_persisted")?.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign persistence rejects swallowed and reordered user-stage questions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-user-question-persistence-"));
  const campaign = {
    stages: [
      { kind: "initial", prompt: "create the artifact" },
      { kind: "followup", prompt: "edit the artifact" },
      { kind: "interrupt" },
      { kind: "reopen", prompt: "continue" }
    ]
  };
  const group = { agents: [{ id: "worker", name: "Worker", role: "ordinary", enabled: true }] };
  try {
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "shared", "task_state.json"), "{}", "utf8");
    fs.writeFileSync(path.join(root, "group.json"), JSON.stringify({
      seats: [{ seatId: "worker", displayName: "Worker", role: "ordinary", enabled: true }]
    }), "utf8");
    const session = (id, question, second) => ({
      id,
      question,
      createdAt: `2026-07-27T00:00:0${second}.000Z`,
      startedAt: `2026-07-27T00:00:0${second}.000Z`,
      messages: []
    });

    const swallowed = verifyCampaignPersistence(root, [
      session("session_01", "create the artifact", 1),
      session("session_02", "edit the artifact", 2),
      session("session_03", "continue", 3)
    ], group, campaign);
    assert.equal(swallowed.passed, false);
    assert.equal(swallowed.checks.find((check) => check.id === "user_stage_questions_persisted")?.passed, false);

    const reordered = verifyCampaignPersistence(root, [
      session("session_01", "edit the artifact", 1),
      session("session_02", "create the artifact", 2),
      session("session_03", "continue", 3),
      session("session_04", "continue", 4)
    ], group, campaign);
    assert.equal(reordered.passed, false);
    assert.equal(reordered.checks.find((check) => check.id === "user_stage_questions_persisted")?.passed, true);
    assert.equal(reordered.checks.find((check) => check.id === "user_stage_questions_chronological")?.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign CSV fixtures stay hidden from prompts and have a mechanical delivery verifier", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-csv-"));
  const campaign = createSeededCampaignScenario({ seed: 4 });
  try {
    prepareCampaignFixtures(root, campaign.fixtures);
    const fixture = campaign.fixtures[0];
    assert.equal(fs.readFileSync(path.join(root, fixture.path), "utf8"), fixture.content);
    fs.mkdirSync(path.join(root, path.dirname(campaign.hiddenVerifier.file)), { recursive: true });
    const [headers, ...rows] = [campaign.hiddenVerifier.headers, ...campaign.hiddenVerifier.rows];
    fs.writeFileSync(path.join(root, campaign.hiddenVerifier.file), [headers, ...rows].map((row) => row.join(",")).join("\n"), "utf8");
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).passed, true);

    fs.writeFileSync(path.join(root, campaign.hiddenVerifier.file), "name,score,result\nwrong,0,REVIEW\n", "utf8");
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capability acquisition evidence must come from a successful current-campaign tool result", () => {
  const verifier = { kind: "png_rgba", requiresAcquisition: true };
  assert.equal(verifyCampaignToolEvidence(verifier, []).passed, false);
  assert.equal(verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [{ tool: "install_package", status: "failed", result: { ok: false } }] }]).passed, false);
  const installedButUnused = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [{
    tool: "install_package",
    status: "completed",
    result: { ok: true, packageName: "chosen-image-package", environmentPath: "shared/environments/npm" }
  }] }]);
  assert.equal(installedButUnused.passed, false);
  const passed = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [
    {
      id: "install-image-package",
      tool: "install_package",
      status: "completed",
      result: { ok: true, packageName: "chosen-image-package", environmentPath: "shared/environments/npm" }
    },
    {
      id: "run-image-package",
      tool: "execute_command",
      status: "completed",
      command: "node shared/environments/npm/render-image.js --engine chosen-image-package",
      capabilityUsage: [{ acquisitionId: "install-image-package", acquisitionTool: "install_package", kind: "installed_package", references: ["chosen-image-package"] }],
      result: { ok: true, exitCode: 0 }
    }
  ] }]);
  assert.equal(passed.passed, true);
  assert.equal(passed.acquisition.passed, true);
  assert.deepEqual(passed.acquisition.tools, ["install_package"]);
  assert.equal(passed.acquisition.evidence.schema, "ai-council.capability-use-evidence.v1");
  assert.equal(passed.acquisition.evidence.uses.length, 1);

  const unlinkedShellInstall = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [
    { id: "shell-install", tool: "execute_command", status: "completed", command: "npm install chosen-image-package", result: { ok: true, exitCode: 0, stdout: "added 1 package" } },
    { tool: "execute_command", status: "completed", command: "node render-image.js", result: { ok: true, exitCode: 0 } }
  ] }]);
  assert.equal(unlinkedShellInstall.passed, false);

  const linkedShellInstall = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [
    { id: "shell-install", tool: "execute_command", status: "completed", command: "npm install chosen-image-package", result: { ok: true, exitCode: 0, stdout: "added 1 package" } },
    {
      id: "run-shell-package",
      tool: "run_code",
      status: "completed",
      capabilityUsage: [{ acquisitionId: "shell-install", acquisitionTool: "execute_command", kind: "shell_installed_package", references: ["chosen-image-package"] }],
      result: { ok: true, exitCode: 0 }
    }
  ] }]);
  assert.equal(linkedShellInstall.passed, true);
  assert.deepEqual(linkedShellInstall.acquisition.tools, ["execute_command_package_install"]);
  assert.equal(linkedShellInstall.acquisition.evidence.uses[0].kind, "shell_installed_package");

  const maskedFailure = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [
    { tool: "execute_command", status: "completed", command: "apt-get install image-tool | tail -5", result: { ok: true, exitCode: 0, stdout: "E: Could not open lock file: Permission denied" } },
    { tool: "execute_command", status: "completed", command: "node render-image.js", result: { ok: true, exitCode: 0 } }
  ] }]);
  assert.equal(maskedFailure.passed, false);
});

test("context retrieval evidence requires the seeded event and a later target write by the retrieving agent", () => {
  const verifier = {
    kind: "json",
    file: "deliverables/history.json",
    requiresContextRetrieval: true,
    contextEventId: "retained-history-9:message:36"
  };
  const retrieved = {
    id: "context-lookup",
    tool: "search_context",
    status: "completed",
    source_agent_id: "builder",
    result: { ok: true, results: [{ eventId: verifier.contextEventId, snippet: "retained answer" }] }
  };
  const write = {
    id: "context-write",
    tool: "workspace_edit",
    status: "completed",
    source_agent_id: "builder",
    path: verifier.file,
    result: { ok: true }
  };
  const passed = verifyCampaignToolEvidence(verifier, [{ toolExecutionResults: [retrieved, write] }]);
  assert.equal(passed.passed, true);
  assert.equal(passed.contextRetrieval.passed, true);
  assert.equal(passed.contextRetrieval.evidence.searches[0].eventId, verifier.contextEventId);

  const wrongAgent = verifyCampaignToolEvidence(verifier, [{
    toolExecutionResults: [retrieved, { ...write, source_agent_id: "reviewer" }]
  }]);
  assert.equal(wrongAgent.passed, false);
  assert.equal(wrongAgent.contextRetrieval.passed, false);
});

test("context history seeding creates a long retained journal without leaking the answer to the public campaign script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-history-"));
  const campaign = createSeededCampaignScenario({ seed: 9 });
  try {
    prepareGroupWorkspace(root, { agents: [] });
    const seeded = seedCampaignHistory(root, campaign);
    const page = queryPublicEventPage(root, { query: campaign.historyFixture.marker, limit: 5 });
    assert.equal(seeded.status, "seeded");
    assert.equal(seeded.seededEvents >= 70, true);
    assert.equal(page.events.some((item) => item.id === campaign.hiddenVerifier.contextEventId), true);
    assert.equal(JSON.stringify(publicCampaignScenario(campaign)).includes(campaign.historyFixture.historicalValue), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context retrieval gates the hidden historical value while reporting ordinary document fields as advisories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-advisory-"));
  const campaign = createSeededCampaignScenario({ seed: 9 });
  try {
    const artifact = {
      ...campaign.hiddenVerifier.expected,
      retrievalMethod: "search_context",
      status: "complete",
      recordType: "retained_lookup",
      retrievedBy: "context_search"
    };
    const target = path.join(root, campaign.hiddenVerifier.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(artifact, null, 2), "utf8");
    const verification = await verifyCampaignDeliverable(campaign.hiddenVerifier, root);
    assert.equal(verification.passed, true);
    assert.equal(verification.advisoryChecks.find((item) => item.id === "json_advisory_status")?.passed, false);
    assert.equal(classifyCampaignDelivery(verification).outcomeConformance.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign workspaces create a local npm boundary instead of installing into an ancestor product", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-package-boundary-"));
  try {
    fs.writeFileSync(path.join(parent, "package.json"), JSON.stringify({ name: "ancestor-product", private: true }), "utf8");
    const groupPath = path.join(parent, "nested", "campaign-group");
    prepareGroupWorkspace(groupPath, { agents: [] });
    const boundary = JSON.parse(fs.readFileSync(path.join(groupPath, "package.json"), "utf8"));
    assert.equal(boundary.name, "ai-council-harness-workspace");
    assert.equal(boundary.private, true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("campaign collaboration verifier requires an acknowledged read-only handoff before the owner writes the target", () => {
  const verifier = { requiresDelegation: true, file: "deliverables/release-brief.json" };
  const delegation = {
    id: "delegation:1:1:critic",
    type: "research",
    assignedBy: "builder",
    assigneeId: "critic",
    allowWorkspaceMutation: false,
    native: true,
    createdAt: "2026-07-27T00:00:10.000Z",
    status: "completed",
    ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_file#critic-read completed" }]
  };
  const sessions = [
    {
      createdAt: "2026-07-27T00:00:00.000Z",
      executionState: { ownership: { delegations: [{ ...delegation, ownerAcknowledged: false }] } },
      toolExecutionResults: []
    },
    {
      createdAt: "2026-07-27T00:01:00.000Z",
      executionState: { ownership: { delegations: [delegation] } },
      toolExecutionResults: [
        { id: "critic-read", tool: "read_file", status: "completed", createdAt: "2026-07-27T00:01:10.000Z", source_agent_id: "critic", path: "inputs/research-note.txt", result: { ok: true } },
        { tool: "workspace_edit", status: "completed", createdAt: "2026-07-27T00:01:11.000Z", source_agent_id: "builder", path: verifier.file, result: { ok: true, path: verifier.file } }
      ]
    }
  ];

  assert.equal(verifyCampaignCollaboration(verifier, sessions).passed, true);
  assert.equal(verifyCampaignCollaboration(verifier, sessions.slice(0, 1)).passed, false);
});

test("campaign collaboration verifier applies distinct implementation, review, and unblocker evidence contracts", () => {
  const at = (seconds) => `2026-07-27T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  const sessionFor = (delegation, results) => ({
    createdAt: at(0),
    executionState: { ownership: { delegations: [delegation] } },
    toolExecutionResults: results
  });
  const implementation = {
    id: "delegation:2:1:implementer", type: "implementation", assignedBy: "owner", assigneeId: "implementer",
    allowWorkspaceMutation: true, allowedPaths: ["shared/component"], native: true, createdAt: at(1), status: "completed", ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "workspace_edit#implementation-write completed" }]
  };
  const implementationSession = sessionFor(implementation, [
    { id: "implementation-write", tool: "workspace_edit", path: "shared/component/feature.txt", status: "completed", createdAt: at(2), source_agent_id: "implementer", result: { ok: true } },
    { id: "owner-verify", tool: "run_code", status: "completed", createdAt: at(3), source_agent_id: "owner", result: { ok: true, exitCode: 0 } }
  ]);
  assert.equal(verifyCampaignCollaboration({ requiresDelegation: true, delegationTypes: ["implementation"] }, [implementationSession]).passed, true);
  assert.equal(verifyCampaignCollaboration({ requiresDelegation: true, delegationTypes: ["implementation"] }, [{ ...implementationSession, toolExecutionResults: implementationSession.toolExecutionResults.slice(0, 1) }]).passed, false);

  const review = {
    id: "delegation:2:2:reviewer", type: "review", assignedBy: "owner", assigneeId: "reviewer",
    allowWorkspaceMutation: false, native: true, createdAt: at(4), status: "completed", ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_file#review-read completed" }]
  };
  const reviewSession = sessionFor(review, [
    { id: "review-read", tool: "read_file", path: "inputs/draft.txt", status: "completed", createdAt: at(5), source_agent_id: "reviewer", result: { ok: true } },
    { id: "owner-repair", tool: "workspace_edit", path: "deliverables/release.txt", status: "completed", createdAt: at(6), source_agent_id: "owner", result: { ok: true } }
  ]);
  assert.equal(verifyCampaignCollaboration({ requiresDelegation: true, delegationTypes: ["review"], file: "deliverables/release.txt" }, [reviewSession]).passed, true);

  const unblocker = {
    id: "delegation:2:3:unblocker", type: "unblocker", assignedBy: "owner", assigneeId: "unblocker",
    allowWorkspaceMutation: false, native: true, createdAt: at(7), status: "completed", ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_process_status#process-ready completed" }]
  };
  const unblockerSession = sessionFor(unblocker, [
    { id: "process-ready", tool: "read_process_status", status: "completed", createdAt: at(8), source_agent_id: "unblocker", result: { ok: true } },
    { id: "owner-continue", tool: "workspace_edit", path: "deliverables/release.txt", status: "completed", createdAt: at(9), source_agent_id: "owner", result: { ok: true } }
  ]);
  assert.equal(verifyCampaignCollaboration({ requiresDelegation: true, delegationTypes: ["unblocker"], file: "deliverables/release.txt" }, [unblockerSession]).passed, true);
});

test("campaign collaboration verifier accepts durable TaskRun-only delegation evidence and rejects a write that predates it", () => {
  const verifier = { requiresDelegation: true, file: "deliverables/release-brief.json" };
  const delegation = {
    id: "delegation:1:2:critic",
    type: "research",
    checkpointVersion: 2,
    assignedBy: "builder",
    assigneeId: "critic",
    allowWorkspaceMutation: false,
    allowedTools: ["read_file"],
    native: true,
    createdAt: "2026-07-27T00:02:00.000Z",
    status: "completed",
    ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_file#critic-read completed" }]
  };
  const taskRunOnly = {
    createdAt: "2026-07-27T00:02:00.000Z",
    taskRun: { execution: { ownership: { delegations: [delegation] } } },
    toolExecutionResults: [
      { id: "critic-read", tool: "read_file", status: "completed", createdAt: "2026-07-27T00:02:01.000Z", source_agent_id: "critic", path: "inputs/research.txt", result: { ok: true } },
      { id: "owner-write", tool: "workspace_edit", status: "completed", createdAt: "2026-07-27T00:02:02.000Z", source_agent_id: "builder", path: verifier.file, result: { ok: true, path: verifier.file } }
    ]
  };
  assert.equal(verifyCampaignCollaboration(verifier, [taskRunOnly]).passed, true);

  const writeFirst = {
    ...taskRunOnly,
    toolExecutionResults: [...taskRunOnly.toolExecutionResults].reverse()
  };
  assert.equal(verifyCampaignCollaboration(verifier, [writeFirst]).passed, false);
});

test("campaign collaboration verifier rejects model-reported or pre-delegation handoff evidence", () => {
  const verifier = { requiresDelegation: true, file: "deliverables/release-brief.json" };
  const delegation = {
    id: "delegation:1:3:critic",
    type: "research",
    assignedBy: "builder",
    assigneeId: "critic",
    allowWorkspaceMutation: false,
    native: true,
    createdAt: "2026-07-27T00:03:00.000Z",
    status: "completed",
    ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_file#critic-read completed" }]
  };
  const session = {
    createdAt: "2026-07-27T00:04:00.000Z",
    executionState: { ownership: { delegations: [delegation] } },
    toolExecutionResults: [
      { id: "critic-read", tool: "read_file", status: "completed", createdAt: "2026-07-27T00:02:59.000Z", source_agent_id: "critic", result: { ok: true } },
      { id: "owner-write", tool: "workspace_edit", status: "completed", createdAt: "2026-07-27T00:04:01.000Z", source_agent_id: "builder", path: verifier.file, result: { ok: true, path: verifier.file } }
    ]
  };
  assert.equal(verifyCampaignCollaboration(verifier, [session]).passed, false);

  const modelReported = structuredClone(session);
  modelReported.executionState.ownership.delegations[0].native = false;
  modelReported.toolExecutionResults[0].createdAt = "2026-07-27T00:03:01.000Z";
  assert.equal(verifyCampaignCollaboration(verifier, [modelReported]).passed, false);
});

test("capability-acquisition PNG verifier checks the real binary structure, dimensions and every RGBA pixel", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-acquired-image-"));
  try {
    const campaign = createSeededCampaignScenario({ seed: 7 });
    const target = path.join(root, campaign.hiddenVerifier.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const correct = Buffer.from(campaign.hiddenVerifier.pixels);
    fs.writeFileSync(target, makeRgbaPng(campaign.hiddenVerifier.width, campaign.hiddenVerifier.height, correct));
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).passed, true);

    const wrong = Buffer.from(correct);
    wrong[0] ^= 0xff;
    fs.writeFileSync(target, makeRgbaPng(campaign.hiddenVerifier.width, campaign.hiddenVerifier.height, wrong));
    const wrongResult = await verifyCampaignDeliverable(campaign.hiddenVerifier, root);
    assert.equal(wrongResult.passed, false);
    const layers = classifyCampaignDelivery(wrongResult);
    assert.equal(layers.minimumUsableDelivery.passed, true, "a valid RGBA artifact proves delivery physiology even when task pixels are wrong");
    assert.equal(layers.outcomeConformance.passed, false);

    fs.writeFileSync(target, "not a png", "utf8");
    const malformed = classifyCampaignDelivery(await verifyCampaignDeliverable(campaign.hiddenVerifier, root));
    assert.equal(malformed.minimumUsableDelivery.passed, false);
    assert.equal(malformed.outcomeConformance.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("document campaign verifier requires a structurally valid illustrated multi-page PDF", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-pdf-"));
  const campaign = createSeededCampaignScenario({ seed: 10 });
  try {
    const target = path.join(root, campaign.hiddenVerifier.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, makeCampaignPdf({ pages: 2, includeImage: true }));
    const valid = await verifyCampaignDeliverable(campaign.hiddenVerifier, root);
    assert.equal(valid.passed, true, JSON.stringify(valid));
    assert.equal(classifyCampaignDelivery(valid).minimumUsableDelivery.passed, true);

    fs.writeFileSync(target, makeCampaignPdf({ pages: 1, includeImage: true }));
    const tooShort = await verifyCampaignDeliverable(campaign.hiddenVerifier, root);
    assert.equal(tooShort.passed, false);
    assert.equal(classifyCampaignDelivery(tooShort).minimumUsableDelivery.passed, true, "a parseable PDF remains visible as delivery physiology even when it misses the requested pages");

    fs.writeFileSync(target, makeCampaignPdf({ pages: 2, includeImage: false }));
    const unillustrated = await verifyCampaignDeliverable(campaign.hiddenVerifier, root);
    assert.equal(unillustrated.passed, false);

    fs.writeFileSync(target, "%PDF-1.7\nnot-a-document\n", "ascii");
    assert.equal(classifyCampaignDelivery(await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).minimumUsableDelivery.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign ZIP verifier checks extracted entry names and content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-zip-"));
  const campaign = createSeededCampaignScenario({ seed: 5 });
  try {
    const archive = path.join(root, campaign.hiddenVerifier.file);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, makeZip(campaign.hiddenVerifier.entries));
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).passed, true);

    fs.writeFileSync(archive, makeZip([{ ...campaign.hiddenVerifier.entries[0], content: "wrong\n" }]));
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, root)).passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("API collection campaign uses the real API tool, persists its evidence, and mechanically verifies the collected JSON", async () => {
  const campaign = createSeededCampaignScenario({ seed: 6 });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-campaign-api-"));
  const artifact = JSON.stringify(campaign.hiddenVerifier.expected, null, 2) + "\n";
  const verifyCommand = `node -e "JSON.parse(require('node:fs').readFileSync('${campaign.hiddenVerifier.file}', 'utf8')); console.log('catalog-ok')"`;
  let apiRequestIssued = false;
  let pendingApiWrite = false;
  const provider = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({ answer: "Completed.", consensus_score: 1, supporting_agents: ["Worker"], dissenting_agents: [], minority_report: "", risks: [], next_actions: [], selected_file_operation_ids: [], memory_candidates: [] }));
      return;
    }
    if (prompt.includes("Tool results from your previous request are now available")) {
      if (pendingApiWrite) {
        pendingApiWrite = false;
        writeOpenAiStream(res, campaignArtifactResponse(campaign.hiddenVerifier.file, artifact, verifyCommand));
        return;
      }
      writeOpenAiStream(res, JSON.stringify({ status: "speak", argument: "The current catalog artifact was written and verified.", objections: [], confidence: 1, memory_candidates: [] }));
      return;
    }
    if (!apiRequestIssued) {
      const url = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/v1\/catalog\/\d+/)?.[0];
      assert.ok(url, "the simulated user must provide the API endpoint without exposing response data");
      apiRequestIssued = true;
      pendingApiWrite = true;
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I will collect the requested API records before writing the catalog.",
        objections: [],
        confidence: 1,
        memory_candidates: [],
        tool_requests: [{ tool: "api_request", method: "GET", url, reason: "Collect the requested catalog data." }]
      }));
      return;
    }
    writeOpenAiStream(res, campaignArtifactResponse(campaign.hiddenVerifier.file, artifact, verifyCommand));
  });
  await listen(provider);
  try {
    const agent = (id, name) => ({ id, name, role: "Deliver the requested artifact.", provider: "openai-compatible", apiBaseUrl: `http://127.0.0.1:${provider.address().port}`, allowUnsafePrivateNetwork: true, apiKey: "test-key", model: "test-model", weight: 1, enabled: true });
    const run = await runSeededRealUserCampaign({
      group: { id: "campaign-api-group", name: "Campaign API Group", settings: { maxRounds: 1, minRounds: 1, allowSoloCouncil: true, stopWhenAllSkip: false }, agents: [agent("worker", "Worker"), agent("reviewer", "Reviewer"), agent("judge", "Judge")] },
      campaign,
      outputDir,
      allowMockProvider: true
    });
    const sessions = fs.readdirSync(path.join(run.groupPath, "sessions"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(run.groupPath, "sessions", name), "utf8")));

    assert.equal(run.report.status, "passed", JSON.stringify(run.report, null, 2));
    assert.equal(run.report.minimumUsableDelivery.passed, true);
    assert.equal(run.report.networkExercise.mode, "controlled_local_api");
    assert.equal(run.report.networkExercise.requestsObserved >= 1, true);
    assert.equal((await verifyCampaignDeliverable(campaign.hiddenVerifier, run.groupPath)).passed, true);
    assert.equal(verifyCampaignToolEvidence(campaign.hiddenVerifier, sessions).passed, false, "the unmaterialized endpoint token cannot match persisted runtime tool evidence");
    assert.equal(verifyCampaignToolEvidence({ ...campaign.hiddenVerifier, apiUrl: run.report.networkExercise.endpoint }, sessions).passed, true);
    assert.equal(JSON.stringify(run.report).includes("test-key"), false);
    assert.deepEqual(findSecretFiles(run.runDir, "test-key"), []);
  } finally {
    await close(provider);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

function roundResponse(greeting) {
  const code = `const index = process.argv.indexOf('--name');\nconst name = index >= 0 ? process.argv[index + 1] : '';\nconsole.log(${JSON.stringify(greeting)} + ', ' + name + '.');\n`;
  return JSON.stringify({
    status: "speak",
    argument: "I will write the requested command-line program.",
    objections: [],
    confidence: 1,
    memory_candidates: [],
    tool_requests: [{ tool: "workspace_edit", action: "write", path: "deliverables/greeting.js", code, reason: "Create or update the requested program." }]
  });
}

function findSecretFiles(root, secret) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:json|jsonl|log|txt|md)$/i.test(entry.name) && fs.readFileSync(target, "utf8").includes(secret)) matches.push(target);
    }
  };
  visit(root);
  return matches;
}

function campaignArtifactResponse(file, artifact, verifyCommand) {
  return JSON.stringify({
    status: "speak",
    argument: "I will keep the requested catalog artifact current and verify it.",
    objections: [],
    confidence: 1,
    memory_candidates: [],
    tool_requests: [
      { tool: "workspace_edit", action: "write", path: file, code: artifact, reason: "Write the current catalog JSON." },
      { tool: "execute_command", command: verifyCommand, shell: "system", reason: "Verify that the current catalog JSON parses." }
    ]
  });
}

function makeCampaignPdf(options = {}) {
  const pageCount = Math.max(1, Number(options.pages || 1));
  const imageObjectNumber = 3 + pageCount * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${[...Array(pageCount)].map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`
  ];
  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    const imageResource = options.includeImage ? ` /Resources << /XObject << /Im1 ${imageObjectNumber} 0 R >> >>` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contentNumber} 0 R${imageResource} >>`);
    objects.push("<< /Length 0 >>\nstream\n\nendstream");
  }
  if (options.includeImage) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\x00\x00\x00\nendstream");
  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f ", ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)].join("\n");
  chunks.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(chunks);
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeRgbaPng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(testCrc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function testCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeOpenAiStream(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
