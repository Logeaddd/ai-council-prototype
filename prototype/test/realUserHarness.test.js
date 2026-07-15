import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { prepareCampaignFixtures, providerCallMetrics, runSeededRealUserBaseline, runSeededRealUserCampaign, verifyCampaignDeliverable, verifyCampaignPersistence, verifyCampaignToolEvidence } from "../src/realUserHarness.js";
import { createSeededCampaignScenario, EXTERNAL_ROOT_TOKEN } from "../src/realUserCampaign.js";

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
        { tool: "execute_command", command: `node ${campaignFile} --name Ada`, shell: "system", reason: "Verify the current deliverable." }
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
    assert.equal(run.report.persistence.passed, true);
    assert.equal(run.report.persistence.checks.every((check) => check.passed), true);
    assert.equal(run.report.recovery.passed, true);
    assert.equal(run.report.recovery.checks.every((check) => check.passed), true);
    assert.equal(path.isAbsolute(run.report.externalWorkspacePath), true);
    assert.equal(run.report.externalWorkspacePath.startsWith(run.groupPath), false);
    assert.equal(run.report.timeline.some((item) => item.mutation === "reorder" && item.result === "completed"), true);
    assert.equal(JSON.stringify(run.report).includes("test-key"), false);
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
