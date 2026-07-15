import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { prepareCampaignFixtures, runSeededRealUserBaseline, runSeededRealUserCampaign, verifyCampaignDeliverable, verifyCampaignPersistence } from "../src/realUserHarness.js";
import { createSeededCampaignScenario } from "../src/realUserCampaign.js";

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
  const campaign = createSeededCampaignScenario({ seed: 8 });
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
        { tool: "workspace_edit", action: "write", path: campaign.hiddenVerifier.file, code, reason: "Write the current requested CLI." },
        { tool: "execute_command", command: `node ${campaign.hiddenVerifier.file} --name Ada`, shell: "system", reason: "Verify the current deliverable." }
      ]
    }));
  });
  await listen(provider);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-real-campaign-"));
  try {
    const agent = (id, name) => ({ id, name, role: "Deliver the requested artifact.", provider: "openai-compatible", apiBaseUrl: `http://127.0.0.1:${provider.address().port}`, allowUnsafePrivateNetwork: true, apiKey: "test-key", model: "test-model", weight: 1, enabled: true });
    const run = await runSeededRealUserCampaign({
      group: { id: "campaign-group", name: "Campaign Group", settings: { maxRounds: 1, minRounds: 1, allowSoloCouncil: true, stopWhenAllSkip: false }, agents: [agent("worker", "Worker"), agent("reviewer", "Reviewer"), agent("judge", "Judge")] },
      campaign,
      outputDir,
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
  const campaign = createSeededCampaignScenario({ seed: 3 });
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
