import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCouncil, runCouncilEvents } from "../src/discussionEngine.js";
import { validateGroupConfig } from "../src/config.js";
import { appendCompressedTranscriptChunk, readSummaryCache, writeGroupSharedSummary, writeMemberShortSummary } from "../src/summaryCache.js";
import { appendSessionUsage, readGroupUsage } from "../src/usageStats.js";
import { approveExecutionStandards, prepareExecutionStandards } from "../src/executionStandards.js";
import { appendPrivateChatMessage } from "../src/privateChat.js";
import { upsertPublicMemory } from "../src/publicMemory.js";
import { writeContextArchive } from "../src/storage.js";


test("onModelCall records round and final model payloads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-model-call-"));
  const calls = [];
  const group = validateGroupConfig({
    id: "mock-call-log",
    name: "Mock Call Log",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const result = await runCouncil("Question", group, tmp, { onModelCall: (call) => calls.push(call) });

  assert.equal(calls.length, 2);
  assert.ok(result.session.createdAt);
  assert.ok(result.session.completedAt);
  assert.equal(Number.isFinite(result.session.durationMs), true);
  assert.equal(Number.isFinite(result.session.messages[0].durationMs), true);
  assert.equal(Number.isFinite(result.session.finalDecision.durationMs), true);
  assert.equal(calls[0].phase, "round");
  assert.equal(calls[0].agentId, "judge");
  assert.match(calls[0].inputMessages.map((message) => message.content).join("\n"), /Question:/);
  assert.match(calls[0].rawText, /status/);
  assert.equal(calls[1].phase, "final");
  assert.match(calls[1].inputMessages[0].content, /FinalDecision JSON object/);
  assert.match(calls[1].rawText, /answer/);
});

test("attached files reach round and final model prompts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-attachments-"));
  const calls = [];
  const group = validateGroupConfig({
    id: "attachment-call-log",
    name: "Attachment Call Log",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  await runCouncil("Read the attached file.", group, tmp, {
    attachments: [
      {
        name: "handoff.md",
        type: "text/markdown",
        sizeBytes: 48,
        content: "ATTACHED_HANDOFF_SECRET: pass this into the council."
      }
    ],
    onModelCall: (call) => calls.push(call)
  });

  const roundPrompt = calls.find((call) => call.phase === "round").inputMessages.map((message) => message.content).join("\n");
  const finalPrompt = calls.find((call) => call.phase === "final").inputMessages.map((message) => message.content).join("\n");
  assert.match(roundPrompt, /User attached files/);
  assert.match(roundPrompt, /handoff\.md/);
  assert.match(roundPrompt, /ATTACHED_HANDOFF_SECRET/);
  assert.match(finalPrompt, /ATTACHED_HANDOFF_SECRET/);
});

test("tool requests execute and return results to the same member follow-up prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tool-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { researcher: "tool" }
    }
  }), "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Used the guarded tool result.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to inspect a URL before answering.",
        tool_requests: [
          {
            tool: "fetch_url",
            url: "https://169.254.169.254/latest",
            reason: "Verify the web tool guard before relying on the page."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The app returned a guarded tool result, so I will not claim the blocked URL was read.",
      objections: [],
      confidence: 0.8,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "tool-followup",
      name: "Tool Followup",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "tool-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Use a web tool if needed.", group, tmp, { groupPath: tmp });
    const followupPrompt = JSON.stringify(requestBodies[1]?.messages || []);

    assert.equal(result.session.toolExecutionResults.length, 1);
    assert.equal(result.session.toolExecutionResults[0].status, "failed");
    assert.match(followupPrompt, /Tool execution results/);
    assert.match(followupPrompt, /Blocked unsafe URL/);
    assert.match(result.session.messages[0].response.argument, /guarded tool result/);
  } finally {
    await close(server);
  }
});

test("file tool requests emit events and return file content to the same member follow-up prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-tool-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { reader: "tool" }
    }
  }), "utf8");
  fs.writeFileSync(path.join(tmp, "brief.md"), "FILE_TOOL_SECRET_FACT: real local content", "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "File tool result was used.",
        consensus_score: 1,
        supporting_agents: ["Reader"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need the local brief first.",
        tool_requests: [
          {
            tool: "read_file",
            path: "brief.md",
            reason: "Read the local brief before answering."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I read FILE_TOOL_SECRET_FACT from the real file tool result.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "file-tool-followup",
      name: "File Tool Followup",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "reader",
          name: "Reader",
          role: "Reader",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "file-tool-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const events = [];
    let result;
    for await (const event of runCouncilEvents("Use the local brief.", group, tmp, { groupPath: tmp })) {
      events.push(event);
      if (event.type === "done") result = event.result;
    }
    const followupPrompt = JSON.stringify(requestBodies[1]?.messages || []);

    assert.equal(result.session.toolExecutionResults.length, 1);
    assert.equal(result.session.toolExecutionResults[0].tool, "read_file");
    assert.equal(result.session.toolExecutionResults[0].status, "completed");
    assert.match(followupPrompt, /Tool execution results/);
    assert.match(followupPrompt, /FILE_TOOL_SECRET_FACT/);
    assert.ok(events.some((event) => event.type === "tool_start" && event.tool === "read_file"));
    assert.ok(events.some((event) => event.type === "tool_success" && event.tool === "read_file"));
    assert.match(result.session.messages[0].response.argument, /FILE_TOOL_SECRET_FACT/);
  } finally {
    await close(server);
  }
});

test("tool requests can run in multiple real iterations before the member answers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tool-chain-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { researcher: "tool" }
    }
  }), "utf8");
  fs.writeFileSync(path.join(tmp, "brief.md"), [
    "CHAIN_FIRST_FACT: read this first.",
    "CHAIN_SECOND_FACT: grep this after reading."
  ].join("\n"), "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Both real tool results were used.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to read the brief first.",
        tool_requests: [
          {
            tool: "read_file",
            path: "brief.md",
            reason: "Read the local brief before deciding the next step."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 2) {
      assert.match(prompt, /CHAIN_FIRST_FACT/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I saw the first fact and now need to grep the second one.",
        tool_requests: [
          {
            tool: "grep_content",
            path: ".",
            query: "CHAIN_SECOND_FACT",
            reason: "Verify the second fact with a second real tool step."
          }
        ],
        objections: [],
        confidence: 0.6,
        memory_candidates: []
      }));
      return;
    }
    assert.match(prompt, /CHAIN_SECOND_FACT/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I used CHAIN_FIRST_FACT and CHAIN_SECOND_FACT from real tool results.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "tool-chain",
      name: "Tool Chain",
      settings: {
        maxRounds: 1,
        maxToolIterations: 4,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "tool-chain-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Use multiple tools if needed.", group, tmp, { groupPath: tmp });

    assert.equal(requestBodies.length, 4);
    assert.equal(result.session.toolExecutionResults.length, 2);
    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.tool), ["read_file", "grep_content"]);
    assert.equal(result.session.messages[0].toolExecutionResults.length, 2);
    assert.match(result.session.messages[0].response.argument, /CHAIN_FIRST_FACT/);
    assert.match(result.session.messages[0].response.argument, /CHAIN_SECOND_FACT/);
  } finally {
    await close(server);
  }
});

test("finalizer is still called after a large real tool-result batch is budgeted", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-evidence-budget-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { builder: "tool" }
    }
  }), "utf8");
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(path.join(tmp, `evidence-${index}.txt`), `EVIDENCE_${index}_HEAD ${"large evidence ".repeat(1400)} EVIDENCE_${index}_TAIL`, "utf8");
  }
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      assert.match(prompt, /Execution evidence pack/);
      assert.match(prompt, /Complete raw results remain in session storage/);
      writeOpenAiStream(res, JSON.stringify({
        answer: "Final synthesis used the bounded execution evidence.",
        consensus_score: 1,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "Read the real evidence files.",
        tool_requests: Array.from({ length: 8 }, (_, index) => ({
          tool: "read_file",
          path: `evidence-${index}.txt`,
          reason: `Read evidence ${index}.`
        })),
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The complete results are stored and the bounded evidence is sufficient.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "evidence-budget",
      name: "Evidence Budget",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [{
        id: "builder",
        name: "Builder",
        role: "Builder",
        provider: "openai-compatible",
        apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        allowUnsafePrivateNetwork: true,
        apiKey: "secret-runtime-key",
        model: "evidence-model",
        providerLimits: { contextWindow: 9000, maxOutputTokens: 1000 },
        tokenLimits: { maxInputTokensPerCall: 8000 },
        weight: 1,
        enabled: true
      }]
    });
    const events = [];
    for await (const event of runCouncilEvents("Use real evidence and then synthesize.", group, tmp, { groupPath: tmp })) {
      events.push(event);
    }
    const result = events.find((event) => event.type === "done")?.result;
    const finalStart = events.find((event) => event.type === "final_start");

    assert.equal(requestBodies.length, 3);
    assert.equal(result.session.toolExecutionResults.length, 8);
    assert.ok(result.session.toolExecutionResults.every((item) => item.result.content.includes("EVIDENCE_")));
    assert.equal(finalStart.contextStatus.executionEvidenceCompression.originalCount, 8);
    assert.equal(finalStart.contextStatus.executionEvidenceCompression.applied, true);
    assert.ok(finalStart.contextStatus.executionEvidenceCompression.keptCount > 0);
    assert.match(result.session.finalDecision.answer, /bounded execution evidence/);
  } finally {
    await close(server);
  }
});

test("tool loop blocks an identical failed command and keeps the failure available for recovery", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tool-repeat-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "full",
      seatTiers: { builder: "full" }
    }
  }), "utf8");
  const failCommand = process.platform === "win32"
    ? `"${process.execPath}" -e "process.exit(7)"`
    : `'${process.execPath}' -e 'process.exit(7)'`;
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Recovered after a real command failure.",
        consensus_score: 1,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "Run the command.",
        tool_requests: [{ tool: "execute_command", command: failCommand, shell: "system", reason: "Observe a real failure." }],
        objections: [],
        confidence: 0.4,
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 2) {
      assert.match(prompt, /exitCode/);
      assert.match(prompt, /7/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "Repeat the same command.",
        tool_requests: [{ tool: "execute_command", command: failCommand, shell: "system", reason: "Repeat it unchanged." }],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    assert.match(prompt, /repeated_failed_command/);
    assert.match(prompt, /Do not repeat an identical failed command/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The identical retry was rejected, so I changed strategy and stopped retrying it.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "tool-repeat",
      name: "Tool Repeat",
      settings: {
        maxRounds: 1,
        maxToolIterations: 4,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [{
        id: "builder",
        name: "Builder",
        role: "Builder",
        provider: "openai-compatible",
        apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        allowUnsafePrivateNetwork: true,
        apiKey: "secret-runtime-key",
        model: "tool-repeat-model",
        weight: 1,
        enabled: true
      }]
    });
    const result = await runCouncil("Recover from a failed command.", group, tmp, { groupPath: tmp });

    assert.equal(requestBodies.length, 4);
    assert.equal(result.session.toolExecutionResults.length, 1);
    assert.equal(result.session.toolExecutionResults[0].status, "failed");
    assert.equal(result.session.rejectedToolRequests[0].code, "repeated_failed_command");
    assert.match(result.session.messages[0].response.argument, /changed strategy/);
  } finally {
    await close(server);
  }
});

test("MCP search follow-up prompt suggests install and next tool step", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "full",
      seatTiers: { researcher: "full" }
    }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes("registry.npmjs.org")) return originalFetch(url, options);
    return new Response(JSON.stringify({
      objects: [
        {
          package: {
            name: "agent-mcp-tool",
            version: "0.1.0",
            description: "Agent MCP tool"
          },
          score: { final: 0.8 }
        }
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "MCP search guidance was used.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to find an MCP tool.",
        tool_requests: [
          {
            tool: "mcp_search_npm",
            query: "agent mcp",
            reason: "Find installable MCP tools."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    assert.match(prompt, /MCP tool search found installable npm packages/);
    assert.match(prompt, /agent-mcp-tool/);
    assert.match(prompt, /mcp_install_npm/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I found agent-mcp-tool and would install it if it fits the task.",
      objections: [],
      confidence: 0.8,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "mcp-followup",
      name: "MCP Followup",
      settings: {
        maxRounds: 1,
        maxToolIterations: 3,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "mcp-followup-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Find a tool if needed.", group, tmp, { groupPath: tmp });

    assert.equal(result.session.toolExecutionResults[0].tool, "mcp_search_npm");
    assert.equal(result.session.toolExecutionResults[0].status, "completed");
    assert.match(result.session.messages[0].response.argument, /agent-mcp-tool/);
  } finally {
    globalThis.fetch = originalFetch;
    await close(server);
  }
});

test("MCP install follow-up can list and call the installed tool in the same member loop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-chain-"));
  const groupPath = path.join(tmp, "group");
  const baseDir = path.join(tmp, "base");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "full",
      seatTiers: { researcher: "full" }
    }
  }), "utf8");
  const packageDir = writeDiscussionFakeMcpPackage(baseDir);
  const nonFinalPrompts = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "The installed MCP tool returned MCP_CHAIN_FACT.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }

    nonFinalPrompts.push(prompt);
    if (nonFinalPrompts.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to install a local MCP tool before answering.",
        tool_requests: [
          {
            tool: "mcp_install_npm",
            serverId: "chain-tool",
            packageSpec: packageDir,
            binName: "fake-mcp",
            reason: "Install the MCP tool for this task."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 2) {
      assert.match(prompt, /MCP install completed/);
      assert.match(prompt, /chain-tool/);
      assert.match(prompt, /mcp_list_tools/);
      assert.match(prompt, /mcp_list_resources/);
      assert.match(prompt, /mcp_list_prompts/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The MCP server is installed. I need its tool list.",
        tool_requests: [
          {
            tool: "mcp_list_tools",
            serverId: "chain-tool",
            reason: "List tools from the installed MCP server."
          }
        ],
        objections: [],
        confidence: 0.6,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 3) {
      assert.match(prompt, /MCP tool list is available/);
      assert.match(prompt, /chain-tool:echo/);
      assert.match(prompt, /mcp_call/);
      assert.match(prompt, /include serverId only when the same tool name appears/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The echo tool is available. I need to call it.",
        tool_requests: [
          {
            tool: "mcp_call",
            mcpToolName: "echo",
            arguments: { text: "MCP_CHAIN_FACT" },
            reason: "Call the installed MCP tool."
          }
        ],
        objections: [],
        confidence: 0.7,
        memory_candidates: []
      }));
      return;
    }

    assert.match(prompt, /MCP call.*echo.*returned real content/);
    assert.match(prompt, /MCP_CHAIN_FACT/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The installed MCP echo tool returned MCP_CHAIN_FACT.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "mcp-chain",
      name: "MCP Chain",
      settings: {
        maxRounds: 1,
        maxToolIterations: 4,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 5000,
        toolTimeoutMs: 30000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "mcp-chain-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Install and use an MCP tool.", group, baseDir, { groupPath });

    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.tool), [
      "mcp_install_npm",
      "mcp_list_tools",
      "mcp_call"
    ]);
    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.status), [
      "completed",
      "completed",
      "completed"
    ]);
    assert.match(result.session.messages[0].response.argument, /MCP_CHAIN_FACT/);
    assert.equal(nonFinalPrompts.length, 4);
  } finally {
    await close(server);
  }
});

test("MCP resource and prompt follow-up can read and get unique entries without serverId", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-resource-prompt-chain-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "full",
      seatTiers: { researcher: "full" }
    }
  }), "utf8");
  const packageDir = writeDiscussionFakeMcpPackage(tmp);
  const baseDir = path.join(tmp, "base");
  fs.mkdirSync(baseDir, { recursive: true });

  const nonFinalPrompts = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "The MCP resource and prompt returned MCP_RESOURCE_CHAIN_FACT and MCP_PROMPT_CHAIN_FACT.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }

    nonFinalPrompts.push(prompt);
    if (nonFinalPrompts.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to install a local MCP package before reading its resource and prompt.",
        tool_requests: [
          {
            tool: "mcp_install_npm",
            serverId: "resource-prompt-tool",
            packageSpec: packageDir,
            binName: "fake-mcp",
            reason: "Install the MCP package."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 2) {
      assert.match(prompt, /MCP install completed/);
      assert.match(prompt, /mcp_list_tools/);
      assert.match(prompt, /mcp_list_resources/);
      assert.match(prompt, /mcp_list_prompts/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The MCP package is installed. I need the resource list.",
        tool_requests: [
          {
            tool: "mcp_list_resources",
            serverId: "resource-prompt-tool",
            reason: "List MCP resources."
          }
        ],
        objections: [],
        confidence: 0.6,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 3) {
      assert.match(prompt, /MCP resource list is available/);
      assert.match(prompt, /resource-prompt-tool:memo:\/\/chain/);
      assert.match(prompt, /mcp_read_resource/);
      assert.match(prompt, /include serverId only when the same URI appears/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The resource is available. I need to read it.",
        tool_requests: [
          {
            tool: "mcp_read_resource",
            uri: "memo://chain",
            reason: "Read the MCP resource."
          }
        ],
        objections: [],
        confidence: 0.65,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 4) {
      assert.match(prompt, /MCP resource.*memo:\/\/chain.*returned real content/);
      assert.match(prompt, /MCP_RESOURCE_CHAIN_FACT/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The resource is read. I need the prompt list.",
        tool_requests: [
          {
            tool: "mcp_list_prompts",
            serverId: "resource-prompt-tool",
            reason: "List MCP prompts."
          }
        ],
        objections: [],
        confidence: 0.7,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 5) {
      assert.match(prompt, /MCP prompt list is available/);
      assert.match(prompt, /resource-prompt-tool:brief/);
      assert.match(prompt, /mcp_get_prompt/);
      assert.match(prompt, /include serverId only when the same prompt name appears/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The prompt is available. I need to get it.",
        tool_requests: [
          {
            tool: "mcp_get_prompt",
            promptName: "brief",
            arguments: { topic: "MCP_PROMPT_CHAIN_FACT" },
            reason: "Get the MCP prompt."
          }
        ],
        objections: [],
        confidence: 0.75,
        memory_candidates: []
      }));
      return;
    }

    assert.match(prompt, /MCP prompt.*brief.*returned real prompt messages/);
    assert.match(prompt, /MCP_PROMPT_CHAIN_FACT/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The MCP resource returned MCP_RESOURCE_CHAIN_FACT and the MCP prompt returned MCP_PROMPT_CHAIN_FACT.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "mcp-resource-prompt-chain",
      name: "MCP Resource Prompt Chain",
      settings: {
        maxRounds: 1,
        maxToolIterations: 6,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 5000,
        toolTimeoutMs: 30000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "mcp-resource-prompt-chain-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Use MCP resource and prompt.", group, baseDir, { groupPath });

    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.tool), [
      "mcp_install_npm",
      "mcp_list_resources",
      "mcp_read_resource",
      "mcp_list_prompts",
      "mcp_get_prompt"
    ]);
    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.status), [
      "completed",
      "completed",
      "completed",
      "completed",
      "completed"
    ]);
    assert.equal(result.session.toolExecutionResults[2].result.serverId, "resource-prompt-tool");
    assert.equal(result.session.toolExecutionResults[4].result.serverId, "resource-prompt-tool");
    assert.match(result.session.messages[0].response.argument, /MCP_RESOURCE_CHAIN_FACT/);
    assert.match(result.session.messages[0].response.argument, /MCP_PROMPT_CHAIN_FACT/);
    assert.equal(nonFinalPrompts.length, 6);
  } finally {
    await close(server);
  }
});

test("built-in web MCP can be joined and called from the council loop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-built-in-web-mcp-"));
  const groupPath = path.join(tmp, "group");
  const baseDir = path.join(tmp, "base");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "full",
      seatTiers: { researcher: "full" }
    }
  }), "utf8");

  const searchServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body>
        <li class="b_algo">
          <h2><a href="https://example.com/builtin-mcp">Built-in MCP Search Result</a></h2>
          <p>BUILTIN_MCP_SEARCH_FACT from the joined web MCP server.</p>
        </li>
      </body></html>
    `);
  });
  await listen(searchServer);
  const originalSearchUrl = process.env.AI_COUNCIL_BUILTIN_SEARCH_URL;
  process.env.AI_COUNCIL_BUILTIN_SEARCH_URL = `http://127.0.0.1:${searchServer.address().port}/search`;

  const nonFinalPrompts = [];
  const modelServer = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "The built-in web MCP returned BUILTIN_MCP_SEARCH_FACT.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }

    nonFinalPrompts.push(prompt);
    if (nonFinalPrompts.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to join the built-in web MCP tools.",
        tool_requests: [
          {
            tool: "mcp_install_npm",
            catalogId: "web-tools",
            reason: "Join the built-in web MCP tools."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 2) {
      assert.match(prompt, /MCP install completed/);
      assert.match(prompt, /web-tools/);
      assert.match(prompt, /mcp_list_tools/);
      assert.match(prompt, /mcp_list_resources/);
      assert.match(prompt, /mcp_list_prompts/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The web MCP server is joined. I need its tool list.",
        tool_requests: [
          {
            tool: "mcp_list_tools",
            serverId: "web-tools",
            reason: "List joined web MCP tools."
          }
        ],
        objections: [],
        confidence: 0.6,
        memory_candidates: []
      }));
      return;
    }
    if (nonFinalPrompts.length === 3) {
      assert.match(prompt, /MCP tool list is available/);
      assert.match(prompt, /web-tools:web_search/);
      assert.match(prompt, /mcp_call/);
      assert.match(prompt, /include serverId only when the same tool name appears/);
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "The joined web search tool is available. I need to call it.",
        tool_requests: [
          {
            tool: "mcp_call",
            mcpToolName: "web_search",
            arguments: { query: "AI Council built-in MCP", count: 1 },
            reason: "Call joined web search."
          }
        ],
        objections: [],
        confidence: 0.7,
        memory_candidates: []
      }));
      return;
    }

    assert.match(prompt, /MCP call.*web_search.*returned real content/);
    assert.match(prompt, /BUILTIN_MCP_SEARCH_FACT/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The joined web MCP search returned BUILTIN_MCP_SEARCH_FACT.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(modelServer);
  const modelAddress = modelServer.address();

  try {
    const group = validateGroupConfig({
      id: "built-in-web-mcp-chain",
      name: "Built-in Web MCP Chain",
      settings: {
        maxRounds: 1,
        maxToolIterations: 4,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 5000,
        toolTimeoutMs: 30000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "built-in-web-mcp-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Join and use web search.", group, baseDir, { groupPath });

    assert.deepEqual(result.session.toolExecutionResults.map((item) => item.tool), [
      "mcp_install_npm",
      "mcp_list_tools",
      "mcp_call"
    ]);
    assert.equal(result.session.toolExecutionResults[0].result.source, "built_in_mcp");
    assert.equal(result.session.toolExecutionResults[2].result.toolName, "web_search");
    assert.match(result.session.messages[0].response.argument, /BUILTIN_MCP_SEARCH_FACT/);
    assert.equal(nonFinalPrompts.length, 4);
  } finally {
    if (originalSearchUrl === undefined) delete process.env.AI_COUNCIL_BUILTIN_SEARCH_URL;
    else process.env.AI_COUNCIL_BUILTIN_SEARCH_URL = originalSearchUrl;
    await close(modelServer);
    await close(searchServer);
  }
});

test("repeated tool requests stop at the configured iteration limit without fake success", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tool-loop-limit-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { looper: "tool" }
    }
  }), "utf8");
  fs.writeFileSync(path.join(tmp, "brief.md"), "LOOP_LIMIT_FACT", "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "The member hit the tool loop limit.",
        consensus_score: 0,
        supporting_agents: [],
        dissenting_agents: ["Looper"],
        minority_report: "Tool loop limit hit.",
        risks: ["tool_iteration_limit_exceeded"],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I keep asking for the same tool.",
      tool_requests: [
        {
          tool: "read_file",
          path: "brief.md",
          reason: "Repeat the same tool request."
        }
      ],
      objections: [],
      confidence: 0.2,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "tool-loop-limit",
      name: "Tool Loop Limit",
      settings: {
        maxRounds: 1,
        maxToolIterations: 2,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "looper",
          name: "Looper",
          role: "Looper",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "tool-loop-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Do not loop forever.", group, tmp, { groupPath: tmp });

    assert.equal(requestBodies.length, 4);
    assert.equal(result.session.toolExecutionResults.length, 2);
    assert.equal(result.session.messages[0].response.status, "unavailable");
    assert.equal(result.session.messages[0].response.reason, "tool_iteration_limit_exceeded:2");
    assert.equal(result.session.messages[0].toolExecutionResults.length, 2);
  } finally {
    await close(server);
  }
});

test("rejected tool requests return reasons to the same member follow-up prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-rejected-tool-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "text",
      seatTiers: { writer: "text" }
    }
  }), "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "The tool rejection was handled.",
        consensus_score: 1,
        supporting_agents: ["Writer"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I will try a command even though I am text-only.",
        tool_requests: [
          {
            tool: "execute_command",
            command: "echo should-not-run",
            reason: "This should be rejected by permission."
          }
        ],
        objections: [],
        confidence: 0.3,
        memory_candidates: []
      }));
      return;
    }
    assert.match(prompt, /Rejected tool requests/);
    assert.match(prompt, /permission_denied/);
    assert.match(prompt, /text-only permission/);
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "The app rejected the command because this seat is text-only, so I will answer without claiming it ran.",
      objections: [],
      confidence: 0.8,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "rejected-tool-followup",
      name: "Rejected Tool Followup",
      settings: {
        maxRounds: 1,
        maxToolIterations: 4,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "writer",
          name: "Writer",
          role: "Writer",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "rejected-tool-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const result = await runCouncil("Handle rejected tools honestly.", group, tmp, { groupPath: tmp });

    assert.equal(requestBodies.length, 3);
    assert.equal(result.session.toolExecutionResults.length, 0);
    assert.equal(result.session.rejectedToolRequests.length, 1);
    assert.equal(result.session.messages[0].rejectedToolRequests.length, 1);
    assert.match(result.session.messages[0].response.argument, /text-only/);
  } finally {
    await close(server);
  }
});

test("context search tool requests return archived public snippets to follow-up prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-tool-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { researcher: "tool" }
    }
  }), "utf8");
  writeContextArchive({
    id: "session_context_tool_runtime_1",
    question: "Earlier archive retrieval task.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "old",
        agentName: "Old",
        response: { status: "speak", argument: "CONTEXT_TOOL_RUNTIME_FACT is saved public archive retrieval history." }
      }
    ],
    finalDecision: { final_state: "ready_to_execute", answer: "Archived." }
  }, tmp);
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Used archived context.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need to search old group history.",
        tool_requests: [
          {
            tool: "search_context",
            query: "archive retrieval",
            reason: "Find saved public context before answering."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I found CONTEXT_TOOL_RUNTIME_FACT from the archive search result.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "context-tool-followup",
      name: "Context Tool Followup",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "context-tool-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const events = [];
    let result;
    for await (const event of runCouncilEvents("Use archive retrieval.", group, tmp, { groupPath: tmp })) {
      events.push(event);
      if (event.type === "done") result = event.result;
    }
    const followupPrompt = JSON.stringify(requestBodies[1]?.messages || []);

    assert.equal(result.session.toolExecutionResults.length, 1);
    assert.equal(result.session.toolExecutionResults[0].tool, "search_context");
    assert.equal(result.session.toolExecutionResults[0].status, "completed");
    assert.match(followupPrompt, /Tool execution results/);
    assert.match(followupPrompt, /CONTEXT_TOOL_RUNTIME_FACT/);
    assert.ok(events.some((event) => event.type === "tool_start" && event.tool === "search_context"));
    assert.ok(events.some((event) => event.type === "tool_success" && event.tool === "search_context"));
  } finally {
    await close(server);
  }
});

test("context load tool requests return archived public rounds to follow-up prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-load-followup-"));
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({
    permissions: {
      defaultTier: "tool",
      seatTiers: { researcher: "tool" }
    }
  }), "utf8");
  writeContextArchive({
    id: "session_context_load_runtime_1",
    question: "Earlier context load task.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:00.000Z",
    status: "completed",
    messages: [
      {
        round: 3,
        agentId: "old",
        agentName: "Old",
        response: { status: "speak", argument: "LOAD_CONTEXT_RUNTIME_FACT is saved in public round three." }
      }
    ],
    finalDecision: { final_state: "ready_to_execute", answer: "Archived." }
  }, tmp);
  fs.mkdirSync(path.join(tmp, "members", "Old", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "members", "Old", "inbox", "private-chat.jsonl"), "LOAD_CONTEXT_PRIVATE_RUNTIME_FACT", "utf8");
  const requestBodies = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readRequestBody(req));
    requestBodies.push(body);
    const prompt = JSON.stringify(body.messages || []);
    if (prompt.includes("FinalDecision JSON object")) {
      writeOpenAiStream(res, JSON.stringify({
        answer: "Used loaded archived context.",
        consensus_score: 1,
        supporting_agents: ["Researcher"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }));
      return;
    }
    if (requestBodies.length === 1) {
      writeOpenAiStream(res, JSON.stringify({
        status: "speak",
        argument: "I need the saved public round.",
        tool_requests: [
          {
            tool: "load_context",
            sessionId: "session_context_load_runtime_1",
            round: 3,
            reason: "Load the archived public round before answering."
          }
        ],
        objections: [],
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "I found LOAD_CONTEXT_RUNTIME_FACT from the loaded archive result.",
      objections: [],
      confidence: 0.9,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const group = validateGroupConfig({
      id: "context-load-followup",
      name: "Context Load Followup",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          role: "Researcher",
          provider: "openai-compatible",
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "context-load-model",
          weight: 1,
          enabled: true
        }
      ]
    });
    const events = [];
    let result;
    for await (const event of runCouncilEvents("Use loaded archive context.", group, tmp, { groupPath: tmp })) {
      events.push(event);
      if (event.type === "done") result = event.result;
    }
    const followupPrompt = JSON.stringify(requestBodies[1]?.messages || []);

    assert.equal(result.session.toolExecutionResults.length, 1);
    assert.equal(result.session.toolExecutionResults[0].tool, "load_context");
    assert.equal(result.session.toolExecutionResults[0].status, "completed");
    assert.match(followupPrompt, /LOAD_CONTEXT_RUNTIME_FACT/);
    assert.doesNotMatch(followupPrompt, /LOAD_CONTEXT_PRIVATE_RUNTIME_FACT/);
    assert.ok(events.some((event) => event.type === "tool_start" && event.tool === "load_context"));
    assert.ok(events.some((event) => event.type === "tool_success" && event.tool === "load_context"));
  } finally {
    await close(server);
  }
});

test("group model call trace records prompt and output summaries without api keys", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-model-trace-"));
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    writeOpenAiStream(res, JSON.stringify({
      status: "speak",
      argument: "Traceable answer.",
      objections: [],
      confidence: 0.8,
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "trace-group",
      name: "Trace Group",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "writer",
          name: "Writer",
          role: "Writer",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "trace-model",
          weight: 1,
          enabled: true
        }
      ]
    });

    await runCouncil("Trace this call.", group, tmp, { groupPath: tmp });

    const traceFile = path.join(tmp, "shared", "logs", "model-calls.jsonl");
    const lines = fs.readFileSync(traceFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(lines.some((line) => line.event === "start" && `${line.input.head}${line.input.tail}`.includes("Trace this call.")));
    assert.ok(lines.some((line) => line.event === "complete" && `${line.output.head}${line.output.tail}`.includes("Traceable answer.")));
    assert.doesNotMatch(fs.readFileSync(traceFile, "utf8"), /secret-runtime-key/);
  } finally {
    await close(server);
  }
});

test("independent work mode isolates ordinary member prompts at the provider boundary", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-independent-"));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      model: body.model,
      prompt: body.messages.map((message) => {
        if (typeof message.content === "string") return message.content;
        return JSON.stringify(message.content);
      }).join("\n")
    });
    const payloads = {
      "alpha-model": {
        status: "speak",
        argument: "ALPHA_PROVIDER_SECRET",
        objections: [],
        confidence: 0.8,
        memory_candidates: []
      },
      "beta-model": {
        status: "speak",
        argument: "BETA_PROVIDER_SECRET",
        objections: [],
        confidence: 0.8,
        memory_candidates: []
      },
      "monitor-model": {
        status: "speak",
        argument: "Monitor can inspect independent answers.",
        objections: [],
        confidence: 0.8,
        memory_candidates: []
      },
      "judge-model": {
        answer: "Independent answers were collected and summarized.",
        consensus_score: 1,
        supporting_agents: ["Alpha", "Beta"],
        dissenting_agents: [],
        minority_report: "",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      }
    };
    writeOpenAiStream(res, JSON.stringify(payloads[body.model]));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "independent-mode",
      name: "Independent Mode",
      settings: {
        workMode: "independent",
        maxRounds: 1,
        minConsensusWeight: 0.5,
        stopWhenAllSkip: true,
        agentTimeoutMs: 3000
      },
      agents: [
        { ...baseAgent, id: "alpha", name: "Alpha", role: "Answer A", model: "alpha-model" },
        { ...baseAgent, id: "beta", name: "Beta", role: "Answer B", model: "beta-model" },
        { ...baseAgent, id: "monitor", name: "Monitor", role: "Supervisor", model: "monitor-model", mandatoryRedTeam: true },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", model: "judge-model", judge: true }
      ]
    });

    await runCouncil("Answer without seeing other members.", group, tmp);

    const byModel = new Map(requests.map((request) => [request.model, request.prompt]));
    assert.equal(requests.map((request) => request.model).join(","), "alpha-model,beta-model,monitor-model,judge-model");
    assert.doesNotMatch(byModel.get("beta-model"), /ALPHA_PROVIDER_SECRET/);
    assert.match(byModel.get("beta-model"), /Independent answer mode/);
    assert.match(byModel.get("monitor-model"), /ALPHA_PROVIDER_SECRET/);
    assert.match(byModel.get("monitor-model"), /BETA_PROVIDER_SECRET/);
    assert.match(byModel.get("judge-model"), /ALPHA_PROVIDER_SECRET/);
    assert.match(byModel.get("judge-model"), /BETA_PROVIDER_SECRET/);
  } finally {
    await close(server);
  }
});

test("final consensus_score is engine-controlled, not judge-controlled", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const { session } = await runCouncil("Question", group, tmp);
  const engineScore = session.consensusByRound.at(-1).score;
  assert.equal(session.finalDecision.consensus_score, engineScore);
});

test("final_state is engine-controlled and unresolved blockers override judge prose", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-final-state-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    callCount += 1;
    const payloads = [
      {
        status: "skip",
        reason: "No objection."
      },
      {
        status: "speak",
        argument: "This cannot be called executable yet.",
        objection_items: [
          {
            id: "missing-runtime-check",
            issue: "The code has no runnable verification.",
            severity: "blocker",
            blocks_final: true,
            in_scope: true,
            why: "The user asked for an executable coding result.",
            suggested_fix: "Add and run a minimal smoke test."
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      },
      {
        status: "skip",
        reason: "No objection."
      },
      {
        answer: "Judge claims this is ready.",
        consensus_score: 1,
        final_state: "ready_to_execute",
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      }
    ];
    writeOpenAiStream(res, JSON.stringify(payloads[Math.min(callCount - 1, payloads.length - 1)]));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "final-state",
      name: "Final State",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "critic", name: "Critic", role: "Critic", mandatoryRedTeam: true },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", judge: true }
      ]
    });

    const { session } = await runCouncil("Write executable code.", group, tmp);

    assert.equal(requests.length, 3);
    assert.equal(session.finalDecision.consensus_score, 1);
    assert.equal(session.finalDecision.final_state, "failed_to_converge");
    assert.equal(session.finalDecision.blocking_issues[0].id, "missing-runtime-check");
    assert.match(session.finalDecision.risks.join("\n"), /BLOCKER missing-runtime-check/);
  } finally {
    await close(server);
  }
});

test("default mock council reaches consensus after explicit non-red-team skips", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 3,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const { session } = await runCouncil("Question", group, tmp);
  assert.equal(session.consensusByRound.at(-1).score, 1);
  assert.deepEqual([...new Set(session.messages.map((message) => message.round))], [1, 2]);
  assert.equal(session.finalDecision.consensus_score, 1);
});

test("default judge is finalizer-only and does not spend a round call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "judge-non-voting",
    name: "Judge Non Voting",
    settings: {
      maxRounds: 5,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const { session } = await runCouncil("Will the judge keep talking forever?", group, tmp);
  const judgeRoundMessages = session.messages.filter((message) => message.agentId === "judge");

  assert.equal(judgeRoundMessages.length, 0);
  assert.equal(session.consensusByRound.at(-1).denominator, 1);
  assert.equal(session.finalDecision.supporting_agents.includes("Builder"), true);
});

test("finalizer-only judge skips round calls and non-blocking reviewer risk does not force another round", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-finalizer-round-skip-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    const payloads = [
      {
        status: "speak",
        position: "deliverable",
        argument: "Use a direct reduce implementation with an initial zero.",
        objections: [],
        suggested_revision: "function sumNumbers(numbers) { return numbers.reduce((sum, n) => sum + n, 0); }",
        confidence: 0.9,
        memory_candidates: []
      },
      {
        status: "speak",
        position: "reviewer",
        argument: "The implementation meets the user's simple numeric-array request. I only note that non-number inputs are out of scope.",
        objections: ["Non-number inputs are not handled, but the user asked for a numeric array."],
        objection_items: [
          {
            id: "non-number-inputs",
            issue: "Non-number inputs are not handled, but the user asked for a numeric array.",
            severity: "minor",
            blocks_final: false,
            in_scope: false,
            why: "The original task explicitly says numeric array.",
            suggested_fix: "Keep as a note, not a blocker."
          }
        ],
        confidence: 0.85,
        memory_candidates: []
      },
      {
        status: "skip",
        reason: "No new change after the implementation was accepted."
      },
      {
        status: "skip",
        reason: "No blocking objection remains."
      },
      {
        answer: "Use the reduce implementation. Keep the non-number note as a non-blocking risk.",
        consensus_score: 0,
        supporting_agents: ["Builder"],
        dissenting_agents: ["Reviewer"],
        minority_report: "Reviewer noted an out-of-scope non-number input risk.",
        risks: ["Non-number inputs are out of scope."],
        next_actions: [],
        memory_candidates: []
      }
    ];
    writeOpenAiStream(res, JSON.stringify(payloads[Math.min(callCount - 1, payloads.length - 1)]));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "judge-finalizer-only",
      name: "Judge Finalizer Only",
      settings: { maxRounds: 5, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "reviewer", name: "Reviewer", role: "Reviewer", reviewer: true, mandatoryRedTeam: true, reviewIntensity: 1 },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", judge: true }
      ]
    });

    const { session } = await runCouncil("请写 sumNumbers(numbers)。", group, tmp);

    assert.equal(requests.length, 5);
    assert.deepEqual(session.messages.map((message) => `${message.round}:${message.agentId}`), [
      "1:builder",
      "1:reviewer",
      "2:builder",
      "2:reviewer"
    ]);
    assert.deepEqual(session.messages.slice(2).map((message) => message.response.status), ["skip", "skip"]);
    assert.equal(session.consensusByRound.length, 2);
    assert.equal(session.finalDecision.final_state, "usable_with_risks");
  } finally {
    await close(server);
  }
});

test("ordinary answer counterarguments require a real follow-up skip before convergence", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-counterargument-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    callCount += 1;
    const payloads = [
      {
        status: "speak",
        position: "answer",
        argument: "Freedom includes responsibility. Counterargument handled inside the answer.",
        objections: ["Responsibility might limit freedom, but this is already answered in the argument."],
        objection_items: [
          {
            id: "handled-counterargument",
            issue: "Responsibility might limit freedom, but this is already answered in the argument.",
            severity: "minor",
            blocks_final: false,
            in_scope: true,
            why: "This is part of the requested counterargument response.",
            suggested_fix: "No extra round needed."
          }
        ],
        suggested_revision: "Final answer with a handled counterargument.",
        confidence: 0.9,
        memory_candidates: []
      },
      {
        status: "skip",
        reason: "No new objection after the handled counterargument."
      },
      {
        answer: "Final answer with a handled counterargument.",
        consensus_score: 0,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      }
    ];
    writeOpenAiStream(res, JSON.stringify(payloads[Math.min(callCount - 1, payloads.length - 1)]));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "counterargument",
      name: "Counterargument",
      settings: { maxRounds: 5, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", judge: true }
      ]
    });

    const { session } = await runCouncil("Discuss freedom and answer one counterargument.", group, tmp);

    assert.equal(requests.length, 3);
    assert.deepEqual(session.messages.map((message) => `${message.round}:${message.agentId}:${message.response.status}`), [
      "1:builder:speak",
      "2:builder:skip"
    ]);
    assert.deepEqual(session.unresolvedObjections.builder, []);
    assert.equal(session.consensusByRound.length, 2);
    assert.equal(session.finalDecision.final_state, "ready_to_execute");
  } finally {
    await close(server);
  }
});

test("stores display-ready dialogue with speaker prefix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const { session } = await runCouncil("Question", group, tmp);
  assert.ok(session.messages[0].displayText.startsWith(`Builder${"\u8bf4\uff1a"}`));
  assert.equal(session.messages[0].agentName, "Builder");
});

test("can write session output into selected group workspace", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const { sessionPath } = await runCouncil("Question", group, tmp, { groupPath });
  assert.ok(sessionPath.startsWith(path.join(groupPath, "sessions")));
  assert.ok(fs.existsSync(sessionPath));
});

test("event runner emits ordered per-agent progress before final result", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const events = [];
  for await (const event of runCouncilEvents("Question", group, tmp)) {
    events.push(event);
  }

  assert.deepEqual(events
    .filter((event) => event.type !== "agent_delta")
    .slice(0, 6)
    .map((event) => `${event.type}:${event.agentName || event.message?.agentName}`), [
    "agent_start:Builder",
    "agent_message:Builder",
    "agent_start:Critic",
    "agent_message:Critic",
    "round_complete:undefined",
    "final_start:Judge"
  ]);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.session.status, "completed");
});

test("event runner can emit token deltas before an agent message", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const events = [];
  for await (const event of runCouncilEvents("Question", group, tmp)) {
    events.push(event);
  }

  const firstDelta = events.findIndex((event) => event.type === "agent_delta" && event.agentName === "Builder");
  const firstMessage = events.findIndex((event) => event.type === "agent_message" && event.message.agentName === "Builder");
  assert.ok(firstDelta > -1);
  assert.ok(firstMessage > firstDelta);
});

test("event runner can continue from the next seat after a stopped agent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const events = [];
  for await (const event of runCouncilEvents("Question", group, tmp, { startAfterAgentId: "builder" })) {
    events.push(event);
  }

  const starts = events
    .filter((event) => event.type === "agent_start")
    .map((event) => event.agentName);
  assert.deepEqual(starts, ["Critic"]);
  assert.equal(events.at(-1).result.session.activeAgentIds.includes("builder"), false);
});

test("event runner can resume at the paused current agent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const events = [];
  for await (const event of runCouncilEvents("Question", group, tmp, {
    startAtAgentId: "critic",
    resumeInstruction: "Continue the interrupted answer."
  })) {
    events.push(event);
  }

  const starts = events
    .filter((event) => event.type === "agent_start")
    .map((event) => event.agentName);
  assert.deepEqual(starts, ["Critic"]);
  assert.equal(events.at(-1).result.session.activeAgentIds.includes("builder"), false);
  assert.equal(events.at(-1).result.session.activeAgentIds.includes("critic"), true);
});

test("runtime OpenAI-compatible agents use direct API keys without storing secrets", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      authorization: req.headers.authorization,
      body
    });
    callCount += 1;
    const payload = callCount === 1
      ? {
        status: "speak",
        position: "support",
        argument: "Use the real runtime API config.",
        objections: [],
        suggested_revision: "",
        confidence: 0.8,
        memory_candidates: []
      }
      : {
        answer: "Runtime API config works.",
        consensus_score: 0,
        supporting_agents: ["Runtime Agent"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "runtime",
      name: "Runtime",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "seat_01",
          name: "Runtime Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session, sessionPath } = await runCouncil("Question", group, tmp);
    const written = fs.readFileSync(sessionPath, "utf8");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authorization, "Bearer secret-runtime-key");
    assert.equal(requests[0].body.model, "runtime-model");
    assert.equal(session.groupSnapshot.agents[0].apiKey, undefined);
    assert.equal(session.groupSnapshot.agents[0].apiKeySet, true);
    assert.doesNotMatch(written, /secret-runtime-key/);
    assert.equal(session.finalDecision.answer, "Runtime API config works.");
  } finally {
    await close(server);
  }
});

test("failed runtime calls become unavailable and do not count as support", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (requests.length <= 2) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    const payload = {
      answer: "Fallback final summary.",
      consensus_score: 0,
      supporting_agents: [],
      dissenting_agents: ["Runtime Agent"],
      minority_report: "Runtime Agent was unavailable.",
      risks: ["rate limited"],
      next_actions: [],
      memory_candidates: []
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "runtime-failure",
      name: "Runtime Failure",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "seat_01",
          name: "Runtime Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session } = await runCouncil("Question", group, tmp);

    assert.equal(session.messages[0].response.status, "unavailable");
    assert.match(session.messages[0].response.reason, /agent_call_failed:seat_01/);
    assert.equal(session.consensusByRound.at(-1).score, 0);
    assert.deepEqual(session.consensusByRound.at(-1).supportingAgents, []);
    assert.deepEqual(session.consensusByRound.at(-1).dissentingAgents, ["Runtime Agent"]);
  } finally {
    await close(server);
  }
});

test("non-compressible core overflow marks an agent unavailable before API call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = {
      answer: "No call should be needed for the overflowing agent.",
      consensus_score: 0,
      supporting_agents: [],
      dissenting_agents: ["Tiny Agent"],
      minority_report: "Tiny Agent context overflow.",
      risks: ["context overflow"],
      next_actions: [],
      memory_candidates: []
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "core-overflow",
      name: "Core Overflow",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "tiny",
          name: "Tiny Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          providerLimits: {
            contextWindow: 120,
            maxOutputTokens: 50
          },
          tokenLimits: {
            maxInputTokensPerCall: 60
          }
        }
      ]
    });
    const question = "这是一个非常长的老板问题，用来触发不可压缩核心超过小模型上下文限制。".repeat(3);

    const { session } = await runCouncil(question, group, tmp);

    assert.equal(session.messages[0].response.status, "unavailable");
    assert.match(session.messages[0].response.reason, /non_compressible_core_exceeds_input_limit/);
    assert.equal(session.messages[0].contextStatus.coreOverflow, true);
    assert.equal(session.consensusByRound.at(-1).score, 0);
    assert.equal(requestCount, 0);
  } finally {
    await close(server);
  }
});

test("member token session budget blocks provider call without skip support", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = {
      answer: "No member call should happen when the member budget is exceeded.",
      consensus_score: 0,
      supporting_agents: [],
      dissenting_agents: ["Budgeted Agent"],
      minority_report: "Budgeted Agent unavailable.",
      risks: ["token budget exceeded"],
      next_actions: [],
      memory_candidates: []
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "token-budget",
      name: "Token Budget",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "budgeted",
          name: "Budgeted Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          providerLimits: {
            contextWindow: 12000,
            maxOutputTokens: 1000
          },
          tokenLimits: {
            maxTokensPerSession: 10
          }
        }
      ]
    });

    const { session } = await runCouncil("Question", group, tmp);

    assert.equal(session.messages[0].response.status, "unavailable");
    assert.match(session.messages[0].response.reason, /token_budget_exceeded/);
    assert.equal(session.consensusByRound.at(-1).score, 0);
    assert.equal(requestCount, 0);
  } finally {
    await close(server);
  }
});

test("member cost session budget blocks provider call without skip support", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cost-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Budgeted Agent", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const workspaceGroup = {
    groupPath,
    seats: [
      {
        seatId: "budgeted",
        displayName: "Budgeted Agent",
        currentModel: "runtime-model",
        privateFolder: "members/Budgeted Agent",
        role: "Judge"
      }
    ]
  };
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
  appendSessionUsage(groupPath, {
    id: "previous",
    groupId: "cost-budget",
    messages: [
      {
        agentId: "budgeted",
        agentName: "Budgeted Agent",
        contextStatus: { totalTokens: 900000 },
        response: { status: "skip", reason: "Previous usage." }
      }
    ]
  }, workspaceGroup);
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = {
      answer: "No member call should happen when the cost budget is exceeded.",
      consensus_score: 0,
      supporting_agents: [],
      dissenting_agents: ["Budgeted Agent"],
      minority_report: "Budgeted Agent unavailable.",
      risks: ["cost budget exceeded"],
      next_actions: [],
      memory_candidates: []
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "cost-budget",
      name: "Cost Budget",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "budgeted",
          name: "Budgeted Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          pricing: { inputPerMillion: 1, outputPerMillion: 0 },
          tokenLimits: {
            maxCostPerSession: 0.5
          }
        }
      ]
    });

    const { session } = await runCouncil("Question", group, tmp, { groupPath });

    assert.equal(session.messages[0].response.status, "unavailable");
    assert.match(session.messages[0].response.reason, /cost_budget_exceeded/);
    assert.equal(session.consensusByRound.at(-1).score, 0);
    assert.equal(requestCount, 0);
  } finally {
    await close(server);
  }
});

test("member budget warning is surfaced without blocking provider call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-budget-warning-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Budget Watch", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const workspaceGroup = {
    groupPath,
    seats: [
      {
        seatId: "watch",
        displayName: "Budget Watch",
        currentModel: "runtime-model",
        privateFolder: "members/Budget Watch",
        role: "Judge"
      }
    ]
  };
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
  appendSessionUsage(groupPath, {
    id: "previous-warning",
    groupId: "budget-warning",
    messages: [
      {
        agentId: "watch",
        agentName: "Budget Watch",
        contextStatus: { totalTokens: 650000 },
        response: { status: "skip", reason: "Previous usage." }
      }
    ]
  }, workspaceGroup);
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = requestCount === 1
      ? { status: "skip", reason: "Within budget but near warning." }
      : {
        answer: "Final answer.",
        consensus_score: 1,
        supporting_agents: ["Budget Watch"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "budget-warning",
      name: "Budget Warning",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true,
        tokenLimits: {
          warningThreshold: 0.6,
          compressionThreshold: 0.75,
          hardStopThreshold: 0.9
        }
      },
      agents: [
        {
          id: "watch",
          name: "Budget Watch",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          pricing: { inputPerMillion: 1, outputPerMillion: 0 },
          tokenLimits: {
            maxCostPerSession: 1
          }
        }
      ]
    });

    const { session } = await runCouncil("Question", group, tmp, { groupPath });

    assert.equal(requestCount, 2);
    assert.equal(session.messages[0].response.status, "skip");
    assert.equal(session.messages[0].contextStatus.costBudgetStatus, "warning");
    assert.equal(session.messages[0].contextStatus.budgetStatus, "warning");
  } finally {
    await close(server);
  }
});

test("final judge core overflow falls back without provider call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = {
      status: "skip",
      reason: "No objection."
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: {
        contextWindow: 10000,
        maxOutputTokens: 1000
      }
    };
    const group = validateGroupConfig({
      id: "final-overflow",
      name: "Final Overflow",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        {
          ...baseAgent,
          id: "builder",
          name: "Builder",
          role: "Builder"
        },
        {
          ...baseAgent,
          id: "critic",
          name: "Critic",
          role: "Critic",
          mandatoryRedTeam: true
        },
        {
          ...baseAgent,
          id: "judge",
          name: "Judge",
          role: "Judge",
          judge: true,
          providerLimits: {
            contextWindow: 120,
            maxOutputTokens: 50
          },
          tokenLimits: {
            maxInputTokensPerCall: 60
          }
        }
      ]
    });
    const question = "Long final synthesis context. ".repeat(20);

    const events = [];
    for await (const event of runCouncilEvents(question, group, tmp)) {
      events.push(event);
    }
    const finalEvent = events.find((event) => event.type === "final_decision");

    assert.equal(requestCount, 2);
    assert.equal(finalEvent.contextStatus.coreOverflow, true);
    assert.match(finalEvent.finalDecision.risks.join("\n"), /final_judge_unavailable:non_compressible_core_exceeds_input_limit/);
  } finally {
    await close(server);
  }
});

test("final judge token budget falls back without final provider call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = {
      status: "skip",
      reason: "No objection."
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: {
        contextWindow: 12000,
        maxOutputTokens: 1000
      }
    };
    const group = validateGroupConfig({
      id: "final-budget",
      name: "Final Budget",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        {
          ...baseAgent,
          id: "builder",
          name: "Builder",
          role: "Builder"
        },
        {
          ...baseAgent,
          id: "critic",
          name: "Critic",
          role: "Critic",
          mandatoryRedTeam: true
        },
        {
          ...baseAgent,
          id: "judge",
          name: "Judge",
          role: "Judge",
          judge: true,
          tokenLimits: {
            maxTokensPerSession: 10
          }
        }
      ]
    });

    const events = [];
    for await (const event of runCouncilEvents("Question", group, tmp)) {
      events.push(event);
    }
    const finalEvent = events.find((event) => event.type === "final_decision");

    assert.equal(requestCount, 2);
    assert.match(finalEvent.finalDecision.risks.join("\n"), /final_judge_unavailable:token_budget_exceeded/);
  } finally {
    await close(server);
  }
});

test("final judge cost budget falls back without final provider call", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-final-cost-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Judge", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const workspaceGroup = {
    groupPath,
    seats: [
      {
        seatId: "judge",
        displayName: "Judge",
        currentModel: "runtime-model",
        privateFolder: "members/Judge",
        role: "Judge"
      }
    ]
  };
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
  appendSessionUsage(groupPath, {
    id: "previous-final",
    groupId: "final-cost",
    messages: [
      {
        agentId: "judge",
        agentName: "Judge",
        contextStatus: { totalTokens: 900000 },
        response: { status: "skip", reason: "Previous usage." }
      }
    ]
  }, workspaceGroup);
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    const payload = {
      status: "skip",
      reason: "No objection."
    };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: {
        contextWindow: 12000,
        maxOutputTokens: 1000
      }
    };
    const group = validateGroupConfig({
      id: "final-cost",
      name: "Final Cost",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        {
          ...baseAgent,
          id: "builder",
          name: "Builder",
          role: "Builder"
        },
        {
          ...baseAgent,
          id: "critic",
          name: "Critic",
          role: "Critic",
          mandatoryRedTeam: true
        },
        {
          ...baseAgent,
          id: "judge",
          name: "Judge",
          role: "Judge",
          judge: true,
          pricing: { inputPerMillion: 1, outputPerMillion: 0 },
          tokenLimits: {
            maxCostPerSession: 0.5
          }
        }
      ]
    });

    const events = [];
    for await (const event of runCouncilEvents("Question", group, tmp, { groupPath })) {
      events.push(event);
    }
    const finalEvent = events.find((event) => event.type === "final_decision");

    assert.equal(requestCount, 2);
    assert.match(finalEvent.finalDecision.risks.join("\n"), /final_judge_unavailable:cost_budget_exceeded/);
  } finally {
    await close(server);
  }
});


test("sessions preserve structured artifacts for final synthesis and saved output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    const payload = callCount === 1
      ? {
        status: "speak",
        position: "implemented",
        argument: "I implemented the helper.",
        objections: [],
        suggested_revision: "The artifact contains the canonical code.",
        artifacts: [
          {
            type: "code",
            title: "todoStats.js",
            content: "export function buildTodoStats(todos) { return {}; }"
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      }
      : {
        answer: "Artifact was preserved for review.",
        consensus_score: 0,
        supporting_agents: ["Runtime Agent"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "artifact-runtime",
      name: "Artifact Runtime",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "seat_01",
          name: "Runtime Agent",
          role: "Judge",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-artifact-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session, sessionPath } = await runCouncil("Question", group, tmp);
    const written = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    const finalPrompt = requests[1].messages.at(-1).content;

    assert.equal(session.artifacts.length, 1);
    assert.equal(session.artifacts[0].source_agent_name, "Runtime Agent");
    assert.equal(session.artifacts[0].content, "export function buildTodoStats(todos) { return {}; }");
    assert.deepEqual(session.messages[0].artifacts, session.artifacts);
    assert.equal(written.artifacts[0].title, "todoStats.js");
    assert.match(finalPrompt, /"artifacts"/);
    assert.match(finalPrompt, /buildTodoStats/);
    assert.doesNotMatch(fs.readFileSync(sessionPath, "utf8"), /secret-artifact-key/);
  } finally {
    await close(server);
  }
});

test("group sessions preserve sandboxed file operation proposals without executing them", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-proposals-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    seats: [{ seatId: "runtime", displayName: "Runtime Agent", privateFolder: "members/Runtime" }],
    permissions: { defaultTier: "text", seatTiers: { runtime: "full" } }
  }, null, 2), "utf8");

  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    callCount += 1;
    const payload = callCount === 1
      ? {
        status: "speak",
        argument: "I propose file work for later approval.",
        file_operations: [
          {
            op: "write",
            path: "src/output.js",
            content: "export const ok = true;",
            reason: "Create the requested module after approval.",
            expected_effect: "A module file exists."
          },
          {
            op: "read",
            path: ".env",
            reason: "Try reading secrets.",
            expected_effect: "Should be rejected."
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      }
      : {
        answer: "File operation proposals were captured for later approval.",
        consensus_score: 1,
        supporting_agents: ["Runtime Agent"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: ["Review pending file operation proposals."],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "file-proposals",
      name: "File Proposals",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "runtime",
          name: "Runtime Agent",
          role: "Executor",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 },
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session, sessionPath } = await runCouncil("Propose a file change.", group, tmp, { groupPath });

    assert.equal(session.fileOperationProposals.length, 1);
    assert.equal(session.fileOperationProposals[0].path, "src/output.js");
    assert.equal(session.fileOperationProposals[0].op, "write");
    assert.equal(session.fileOperationProposals[0].source_agent_id, "runtime");
    assert.equal(session.pendingFileOperationProposals.length, 0);
    assert.deepEqual(session.rejectedFileOperationProposals.map((item) => item.code).sort(), [
      "execution_standards_not_approved",
      "forbidden_secret_file"
    ]);
    assert.equal(session.messages[0].fileOperationProposals.length, 1);
    assert.equal(session.messages[0].pendingFileOperationProposals.length, 0);
    assert.equal(fs.existsSync(path.join(groupPath, "src", "output.js")), false);

    const written = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(written.fileOperationProposals[0].path, "src/output.js");
    assert.deepEqual(written.rejectedFileOperationProposals.map((item) => item.code).sort(), [
      "execution_standards_not_approved",
      "forbidden_secret_file"
    ]);
    assert.ok(fs.existsSync(path.join(groupPath, "shared", "logs", "file-ops.jsonl")));
  } finally {
    await close(server);
  }
});


test("workspace round prompts gate file_operations by seat permission tier", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-permission-prompt-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    permissions: {
      defaultTier: "text",
      seatTiers: { executor: "full" }
    },
    seats: [
      { seatId: "architect", displayName: "Architect", currentModel: "runtime-model", privateFolder: "members/Architect", role: "Architect" },
      { seatId: "executor", displayName: "Executor", currentModel: "runtime-model", privateFolder: "members/Executor", role: "Executor" },
      { seatId: "reviewer", displayName: "Reviewer", currentModel: "runtime-model", privateFolder: "members/Reviewer", role: "Reviewer" }
    ]
  }, null, 2), "utf8");

  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    if (callCount <= 3) {
      writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Prompt captured." }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({
      answer: "Done.",
      consensus_score: 1,
      supporting_agents: ["Architect", "Executor"],
      dissenting_agents: [],
      minority_report: "None.",
      risks: [],
      next_actions: [],
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = "http://127.0.0.1:" + address.port + "/v1";

  try {
    const group = validateGroupConfig({
      id: "file-permission-prompt",
      name: "File Permission Prompt",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 1,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        { id: "architect", name: "Architect", role: "Architect", provider: "openai-compatible", apiBaseUrl, allowUnsafePrivateNetwork: true, apiKey: "secret-runtime-key", model: "runtime-model", weight: 1, enabled: true },
        { id: "executor", name: "Executor", role: "Executor", provider: "openai-compatible", apiBaseUrl, allowUnsafePrivateNetwork: true, apiKey: "secret-runtime-key", model: "runtime-model", weight: 1, enabled: true },
        { id: "reviewer", name: "Reviewer", role: "Reviewer", provider: "openai-compatible", apiBaseUrl, allowUnsafePrivateNetwork: true, apiKey: "secret-runtime-key", model: "runtime-model", weight: 1, enabled: true, mandatoryRedTeam: true, judge: true }
      ]
    });

    await runCouncil("Create a file.", group, tmp, { groupPath });

    assert.match(requests[0].messages[0].content, /text-only file permission/);
    assert.doesNotMatch(requests[0].messages[0].content, /MUST propose the change in file_operations/);
    assert.match(requests[1].messages[0].content, /MUST propose the change in file_operations/);
  } finally {
    await close(server);
  }
});

test("full permission executes approved file operation proposals during the round", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-full-round-files-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    permissions: {
      defaultTier: "full",
      seatTiers: { runtime: "full" }
    },
    seats: [
      {
        seatId: "runtime",
        displayName: "Runtime Agent",
        currentModel: "runtime-model",
        privateFolder: "members/RuntimeAgent",
        role: "Executor"
      }
    ]
  }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["add", "--", "."], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: initialize group"], { cwd: groupPath, stdio: "pipe" });
  prepareExecutionStandards({
    groupPath,
    finalAnswer: "Create the requested file.",
    recorderSeatId: "runtime"
  });
  approveExecutionStandards({ groupPath, approvedBy: "test" });
  execFileSync("git", ["add", "--", "."], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: approve standards"], { cwd: groupPath, stdio: "pipe" });

  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    callCount += 1;
    const payload = callCount === 1
      ? {
        status: "speak",
        argument: "I wrote the file.",
        file_operations: [
          {
            op: "write",
            path: "src/output.js",
            content: "export const ok = true;\n",
            reason: "Create the requested module.",
            expected_effect: "A module file exists."
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      }
      : {
        answer: "File created.",
        consensus_score: 1,
        supporting_agents: ["Runtime Agent"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        selected_file_operation_ids: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "full-round-files",
      name: "Full Round Files",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "runtime",
          name: "Runtime Agent",
          role: "Executor",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 },
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session } = await runCouncil("Create a file.", group, tmp, { groupPath });

    assert.equal(fs.readFileSync(path.join(groupPath, "src", "output.js"), "utf8"), "export const ok = true;\n");
    assert.equal(session.fileOperationExecutionResults.some((item) => item.status === "executed" && item.path === "src/output.js"), true);
    assert.equal(session.messages[0].fileOperationExecutionResults.some((item) => item.status === "executed" && item.path === "src/output.js"), true);
    assert.match(execFileSync("git", ["log", "--oneline", "-1"], { cwd: groupPath, encoding: "utf8" }), /files: apply write src\/output\.js/);
  } finally {
    await close(server);
  }
});

test("full permission executes file operations before tool follow-up requests", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-files-before-tools-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    permissions: {
      defaultTier: "full",
      seatTiers: { runtime: "full" }
    },
    seats: [
      {
        seatId: "runtime",
        displayName: "Runtime Agent",
        currentModel: "runtime-model",
        privateFolder: "members/RuntimeAgent",
        role: "Executor"
      }
    ]
  }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["add", "--", "."], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: initialize group"], { cwd: groupPath, stdio: "pipe" });
  prepareExecutionStandards({
    groupPath,
    finalAnswer: "Create the requested file.",
    recorderSeatId: "runtime"
  });
  approveExecutionStandards({ groupPath, approvedBy: "test" });
  execFileSync("git", ["add", "--", "."], { cwd: groupPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: approve standards"], { cwd: groupPath, stdio: "pipe" });

  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request body.
    }
    callCount += 1;
    const payload = callCount === 1
      ? {
        status: "speak",
        argument: "I wrote the file and will inspect the workspace.",
        file_operations: [
          {
            op: "write",
            path: "src/output.js",
            content: "export const ok = true;\n",
            reason: "Create the requested module.",
            expected_effect: "A module file exists."
          }
        ],
        tool_requests: [
          {
            tool: "list_directory",
            path: "src",
            reason: "Confirm the generated source directory exists."
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      }
      : callCount === 2
        ? {
          status: "speak",
          argument: "The file is present.",
          confidence: 0.9,
          memory_candidates: []
        }
        : {
          answer: "File created.",
          consensus_score: 1,
          supporting_agents: ["Runtime Agent"],
          dissenting_agents: [],
          minority_report: "None.",
          risks: [],
          next_actions: [],
          selected_file_operation_ids: [],
          memory_candidates: []
        };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const apiBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "files-before-tools",
      name: "Files Before Tools",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "runtime",
          name: "Runtime Agent",
          role: "Executor",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 },
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session } = await runCouncil("Create a file then inspect it.", group, tmp, { groupPath });

    assert.equal(fs.readFileSync(path.join(groupPath, "src", "output.js"), "utf8"), "export const ok = true;\n");
    assert.equal(session.messages[0].toolRequests.length, 1);
    assert.equal(session.fileOperationExecutionResults.some((item) => item.status === "executed" && item.path === "src/output.js"), true);
    assert.equal(session.messages[0].fileOperationExecutionResults.some((item) => item.status === "executed" && item.path === "src/output.js"), true);
  } finally {
    await close(server);
  }
});

test("ready final state auto-executes safe file proposals for full tier", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-auto-exec-runtime-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    permissions: {
      defaultTier: "full",
      seatTiers: { runtime: "full" }
    },
    seats: [
      {
        seatId: "runtime",
        displayName: "Runtime Agent",
        currentModel: "runtime-model",
        privateFolder: "members/RuntimeAgent",
        role: "Executor"
      }
    ]
  }, null, 2), "utf8");
  git(groupPath, ["init"]);
  git(groupPath, ["config", "user.email", "test@example.com"]);
  git(groupPath, ["config", "user.name", "Test User"]);
  git(groupPath, ["add", "--", "."]);
  git(groupPath, ["commit", "-m", "test: initialize group"]);
  prepareExecutionStandards({
    groupPath,
    finalAnswer: "Create the requested file after final approval.",
    recorderSeatId: "runtime"
  });
  approveExecutionStandards({ groupPath, approvedBy: "user" });
  git(groupPath, ["add", "--", "."]);
  git(groupPath, ["commit", "-m", "test: approve standards"]);

  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    const roundPromptRequiresFileOperations = body.messages?.[0]?.content?.includes("MUST propose the change in file_operations");
    const payload = callCount === 1
      ? roundPromptRequiresFileOperations
        ? {
          status: "speak",
          argument: "I propose the requested file operation.",
          file_operations: [
            {
              op: "write",
              path: "src/auto-created.js",
              content: "export const autoCreated = true;\n",
              reason: "Create the requested module.",
              expected_effect: "The module exists on disk."
            }
          ],
          confidence: 0.9,
          memory_candidates: []
        }
        : {
          status: "speak",
          argument: "I can describe the file, but the prompt did not require file_operations.",
          confidence: 0.5,
          memory_candidates: []
        }
      : {
        answer: "Ready to execute the proposed file operation.",
        consensus_score: 1,
        supporting_agents: ["Runtime Agent"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "auto-exec-runtime",
      name: "Auto Exec Runtime",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "runtime",
          name: "Runtime Agent",
          role: "Executor",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 },
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session, sessionPath } = await runCouncil("Create a tiny module file.", group, tmp, { groupPath });
    const targetPath = path.join(groupPath, "src", "auto-created.js");

    assert.equal(requests.length, 2);
    assert.match(requests[0].messages[0].content, /MUST propose the change in file_operations/);
    assert.equal(session.fileOperationProposals.length, 1);
    assert.equal(session.pendingFileOperationProposals.length, 1);
    assert.equal(fs.readFileSync(targetPath, "utf8"), "export const autoCreated = true;\n");
    assert.equal(session.finalDecision.final_state, "ready_to_execute");
    assert.equal(session.fileOperationExecutionState, "executed");
    assert.equal(session.finalDecision.file_execution_state, "executed");
    assert.equal(session.fileOperationExecutionResults[0].status, "executed");
    assert.match(session.fileOperationExecutionResults[0].commitHash, /^[0-9a-f]{7,}/);
    const show = git(groupPath, ["show", "--name-only", "--format=", session.fileOperationExecutionResults[0].commitHash]);
    assert.match(show, /src\/auto-created\.js/);
    assert.match(show, /shared\/file-ops\/pending\//);
    const written = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(written.finalDecision.file_execution_state, "executed");
  } finally {
    await close(server);
  }
});

test("full permission executes approved round proposals before final selection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-selected-file-runtime-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    permissions: {
      defaultTier: "full",
      seatTiers: { runtime: "full" }
    },
    seats: [
      {
        seatId: "runtime",
        displayName: "Runtime Agent",
        currentModel: "runtime-model",
        privateFolder: "members/RuntimeAgent",
        role: "Executor"
      }
    ]
  }, null, 2), "utf8");
  git(groupPath, ["init"]);
  git(groupPath, ["config", "user.email", "test@example.com"]);
  git(groupPath, ["config", "user.name", "Test User"]);
  git(groupPath, ["add", "--", "."]);
  git(groupPath, ["commit", "-m", "test: initialize group"]);
  prepareExecutionStandards({
    groupPath,
    finalAnswer: "Create only the selected file proposal.",
    recorderSeatId: "runtime"
  });
  approveExecutionStandards({ groupPath, approvedBy: "user" });
  git(groupPath, ["add", "--", "."]);
  git(groupPath, ["commit", "-m", "test: approve standards"]);

  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    if (callCount === 1) {
      const roundPromptRequiresFileOperations = body.messages?.[0]?.content?.includes("MUST propose the change in file_operations");
      writeOpenAiStream(res, JSON.stringify(roundPromptRequiresFileOperations ? {
        status: "speak",
        argument: "I propose one rejected and one selected file operation.",
        file_operations: [
          {
            op: "write",
            path: "src/rejected.js",
            content: "export const rejected = true;\n",
            reason: "This proposal should not be selected.",
            expected_effect: "Rejected module exists."
          },
          {
            op: "write",
            path: "src/selected.js",
            content: "export const selected = true;\n",
            reason: "This proposal should be selected.",
            expected_effect: "Selected module exists."
          }
        ],
        confidence: 0.9,
        memory_candidates: []
      } : {
        status: "speak",
        argument: "I can describe the selected module, but the prompt did not require file_operations.",
        confidence: 0.5,
        memory_candidates: []
      }));
      return;
    }

    const finalPrompt = body.messages.at(-1).content;
    const finalInput = JSON.parse(finalPrompt);
    assert.deepEqual(finalInput.pendingFileOperationProposals, []);
    writeOpenAiStream(res, JSON.stringify({
      answer: "The full-permission file operations already executed.",
      consensus_score: 1,
      supporting_agents: ["Runtime Agent"],
      dissenting_agents: [],
      minority_report: "None.",
      risks: [],
      next_actions: [],
      selected_file_operation_ids: [],
      memory_candidates: []
    }));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "selected-file-runtime",
      name: "Selected File Runtime",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "runtime",
          name: "Runtime Agent",
          role: "Executor",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 },
          weight: 1,
          enabled: true,
          judge: true
        }
      ]
    });

    const { session } = await runCouncil("Create only the selected module.", group, tmp, { groupPath });

    assert.equal(requests.length, 2);
    assert.match(requests[0].messages[0].content, /MUST propose the change in file_operations/);
    assert.equal(session.fileOperationProposals.length, 2);
    assert.equal(session.pendingFileOperationProposals.length, 2);
    assert.equal(fs.existsSync(path.join(groupPath, "src", "selected.js")), true);
    assert.equal(fs.existsSync(path.join(groupPath, "src", "rejected.js")), true);
    assert.deepEqual(session.finalDecision.selected_file_operation_ids, []);
    assert.equal(session.pendingFileOperationProposals.every((proposal) => proposal.status === "executed"), true);
    assert.equal(session.fileOperationExecutionResults.filter((item) => item.status === "executed").length, 2);
  } finally {
    await close(server);
  }
});
test("round prompts use member context sections instead of full transcript replay", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-"));
  const requests = [];
  let callCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    callCount += 1;
    const payloads = [
      {
        status: "speak",
        argument: "Builder delivered artifact.",
        objections: [],
        artifacts: [{ type: "code", title: "impl.js", content: "export const impl = true;" }],
        confidence: 0.8,
        memory_candidates: []
      },
      {
        status: "speak",
        argument: "Red Team keeps a risk.",
        objections: ["Risk must remain visible."],
        objection_items: [
          {
            id: "visible-risk",
            issue: "Risk must remain visible.",
            severity: "blocker",
            blocks_final: true,
            in_scope: true,
            why: "The user needs the risk preserved in later context.",
            suggested_fix: "Keep the risk in member context and final synthesis."
          }
        ],
        confidence: 0.8,
        memory_candidates: []
      },
      {
        status: "speak",
        argument: "Builder sees and addresses the visible risk.",
        objections: [],
        suggested_revision: "Keep Risk must remain visible in the final output.",
        confidence: 0.8,
        memory_candidates: []
      },
      {
        status: "skip",
        reason: "No new objection."
      },
      {
        answer: "Done.",
        consensus_score: 0,
        supporting_agents: ["Builder", "Judge"],
        dissenting_agents: ["Critic"],
        minority_report: "Risk must remain visible.",
        risks: ["Risk must remain visible."],
        next_actions: [],
        memory_candidates: []
      }
    ];
    writeOpenAiStream(res, JSON.stringify(payloads[Math.min(callCount - 1, payloads.length - 1)]));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "context-sections",
      name: "Context Sections",
      settings: {
        maxRounds: 2,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "critic", name: "Critic", role: "Critic", mandatoryRedTeam: true },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", judge: true }
      ]
    });

    await runCouncil("Question", group, tmp);
    const secondRoundBuilderPrompt = requests[2].messages.at(-1).content;
    const finalPrompt = requests.at(-1).messages.at(-1).content;

    assert.match(secondRoundBuilderPrompt, /Member context:/);
    assert.match(secondRoundBuilderPrompt, /Latest artifacts:/);
    assert.match(secondRoundBuilderPrompt, /export const impl = true/);
    assert.match(secondRoundBuilderPrompt, /Unresolved objections:/);
    assert.match(secondRoundBuilderPrompt, /Risk must remain visible/);
    assert.doesNotMatch(secondRoundBuilderPrompt, /Transcript so far:/);
    assert.match(finalPrompt, /"memberContext"/);
    assert.match(finalPrompt, /Latest artifacts:/);
    assert.match(finalPrompt, /export const impl = true/);
    assert.match(finalPrompt, /Risk must remain visible/);
    assert.doesNotMatch(finalPrompt, /"transcript"/);
  } finally {
    await close(server);
  }
});

test("round prompts include persisted member and group summaries", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-summary-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Builder", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const workspaceGroup = {
    seats: [
      {
        seatId: "builder",
        displayName: "Builder",
        currentModel: "runtime-model",
        privateFolder: "members/Builder",
        role: "Builder"
      }
    ]
  };
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
  writeMemberShortSummary(groupPath, workspaceGroup.seats[0], "Builder private summary from cache.");
  writeGroupSharedSummary(groupPath, "Group shared summary from cache.");
  appendCompressedTranscriptChunk(groupPath, {
    fromRound: 1,
    toRound: 4,
    summary: "Earlier transcript compressed into cache."
  });

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const payload = requests.length === 1
      ? {
        status: "speak",
        argument: "I used the cached summaries.",
        objections: [],
        confidence: 0.8,
        memory_candidates: []
      }
      : {
        answer: "Done.",
        consensus_score: 0,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      };
    writeOpenAiStream(res, JSON.stringify(payload));
  });
  await listen(server);
  const address = server.address();
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const group = validateGroupConfig({
      id: "summary-runtime",
      name: "Summary Runtime",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000,
        allowSoloCouncil: true
      },
      agents: [
        {
          id: "builder",
          name: "Builder",
          role: "Builder",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
        }
      ]
    });

    await runCouncil("Question", group, tmp, { groupPath });
    const prompt = requests[0].messages.at(-1).content;

    assert.match(prompt, /Builder private summary from cache/);
    assert.match(prompt, /Group shared summary from cache/);
    assert.match(prompt, /Earlier transcript compressed into cache/);
  } finally {
    await close(server);
  }
});

test("group sessions append deterministic compressed transcript chunks", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-chunk-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "shared", "cache"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({ seats: [] }, null, 2), "utf8");
  const group = validateGroupConfig({
    id: "mock",
    name: "Mock",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "critic",
        name: "Critic",
        role: "Critique",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-critic",
        weight: 1,
        enabled: true,
        mandatoryRedTeam: true
      },
      {
        id: "judge",
        name: "Judge",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const result = await runCouncil("Question", group, tmp, { groupPath });
  const chunkFile = path.join(groupPath, "shared", "cache", "compressed-transcript.jsonl");

  assert.ok(result.transcriptChunk);
  assert.equal(result.transcriptChunk.sourceSessionId, result.session.id);
  assert.ok(fs.existsSync(chunkFile));
  assert.match(fs.readFileSync(chunkFile, "utf8"), /Builder/);
});

test("group sessions update deterministic summaries after completion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-summary-update-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Builder", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  const workspaceGroup = {
    groupPath,
    seats: [
      {
        seatId: "builder",
        displayName: "Builder",
        currentModel: "mock-builder",
        privateFolder: "members/Builder",
        role: "Builder"
      }
    ]
  };
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
  const group = validateGroupConfig({
    id: "summary-update",
    name: "Summary Update",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const result = await runCouncil("Summarize after run.", group, tmp, { groupPath });
  const cache = readSummaryCache(groupPath, { id: "builder", name: "Builder" }, workspaceGroup);

  assert.ok(result.summaryUpdate);
  assert.match(cache.groupSharedSummary, /Question: Summarize after run/);
  assert.match(cache.memberShortSummary, /Member: Builder/);
});

test("group sessions persist usage stats as state, not cache", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-usage-runtime-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Builder", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    seats: [
      {
        seatId: "builder",
        displayName: "Builder",
        currentModel: "mock-builder",
        privateFolder: "members/Builder",
        role: "Builder"
      }
    ]
  }, null, 2), "utf8");
  const group = validateGroupConfig({
    id: "usage-runtime",
    name: "Usage Runtime",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true,
        judge: true
      }
    ]
  });

  const result = await runCouncil("Question", group, tmp, { groupPath });
  const groupUsage = readGroupUsage(groupPath);
  const memberUsagePath = path.join(groupPath, "members", "Builder", "private_memory", "usage.jsonl");

  assert.ok(result.usageRecord);
  assert.equal(groupUsage.length, 1);
  assert.equal(groupUsage[0].sessionId, result.session.id);
  assert.ok(groupUsage[0].totals.estimatedInputTokens > 0);
  assert.ok(fs.existsSync(memberUsagePath));
});

test("private boss messages are visible only to the addressed agent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-context-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "members", "Builder", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "members", "Builder", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "members", "Critic", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "members", "Critic", "private_memory"), { recursive: true });
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    seats: [
      { seatId: "builder", displayName: "Builder", currentModel: "runtime-model", privateFolder: "members/Builder", role: "Builder" },
      { seatId: "critic", displayName: "Critic", currentModel: "runtime-model", privateFolder: "members/Critic", role: "Critic" },
      { seatId: "judge", displayName: "Judge", currentModel: "runtime-model", privateFolder: "members/Builder", role: "Judge" }
    ]
  }, null, 2), "utf8");
  const privateText = "\u53ea\u7ed9 Builder \u7684\u79c1\u804a\u4e0a\u4e0b\u6587";
  fs.appendFileSync(path.join(groupPath, "members", "Builder", "inbox", "private-chat.jsonl"), JSON.stringify({
    id: "pm_test",
    seatId: "builder",
    audience: "builder",
    text: privateText,
    createdAt: "2026-06-21T10:00:00.000Z"
  }) + "\n", "utf8");

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    writeOpenAiStream(res, JSON.stringify({
      status: "skip",
      reason: "No objection.",
      memory_candidates: []
    }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "private-context",
      name: "Private Context",
      settings: {
        maxRounds: 1,
        minConsensusWeight: 0.75,
        stopWhenAllSkip: true,
        agentTimeoutMs: 1000
      },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "critic", name: "Critic", role: "Critic", mandatoryRedTeam: true },
        { ...baseAgent, id: "judge", name: "Judge", role: "Judge", judge: true }
      ]
    });

    await runCouncil("Question", group, tmp, { groupPath });

    const builderPrompt = requests[0].messages.at(-1).content;
    const criticPrompt = requests[1].messages.at(-1).content;
    assert.match(builderPrompt, /Private boss messages/);
    assert.match(builderPrompt, /Builder/);
    assert.doesNotMatch(criticPrompt, /Private boss messages/);
    assert.doesNotMatch(criticPrompt, /Builder \u7684\u79c1\u804a\u4e0a\u4e0b\u6587/);
  } finally {
    await close(server);
  }
});

test("private chat memory reaches the same agent in council for browser-only seats", async () => {
  // \u590d\u73b0\u7528\u6237 bug\uff1a\u524d\u7aef\u5ea7\u4f4d\u53ea\u5b58\u5185\u5b58\uff0cgroup.json \u7684 seats \u4e3a\u7a7a\u3002
  // \u79c1\u804a\u544a\u8bc9 AI \u540d\u5b57\u540e\uff0c\u4f1a\u8bae\u4e2d\u540c\u4e00\u4e2a AI \u5fc5\u987b\u80fd\u8bfb\u5230\u3002
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-private-browser-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  // seats \u4e3a\u7a7a\uff0c\u6a21\u62df\u524d\u7aef\u521b\u5efa\u7684\u5de5\u4f5c\u533a\uff08\u5ea7\u4f4d\u53ea\u5728\u6d4f\u89c8\u5668\u5185\u5b58\u4e2d\uff09
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    seats: []
  }, null, 2), "utf8");

  // \u79c1\u804a\u5199\u5165\uff08POST /api/private-chat \u7684\u8def\u5f84\uff0c\u5e26\u524d\u7aef seat\uff09
  const frontendSeat = { seatId: "seat_01", displayName: "\u82cf\u683c\u62c9\u5e95", role: "\u54f2\u5b66\u5bb6" };
  appendPrivateChatMessage(groupPath, "seat_01", "\u6211\u53eb\u5c0f\u660e\uff0c\u8bf7\u8bb0\u4f4f\u6211\u7684\u540d\u5b57", { from: "boss", seat: frontendSeat });

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "No objection.", memory_candidates: [] }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    // \u4f1a\u8bae agent \u4e0e\u79c1\u804a seat \u540c\u6e90\uff1aid=seat.seatId\uff0cname=displayName
    const group = validateGroupConfig({
      id: "private-browser",
      name: "Private Browser",
      settings: { maxRounds: 1, minConsensusWeight: 0.75, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "seat_01", name: "\u82cf\u683c\u62c9\u5e95", role: "\u54f2\u5b66\u5bb6" },
        { ...baseAgent, id: "seat_02", name: "\u67cf\u62c9\u56fe", role: "\u8d28\u68c0", judge: true, mandatoryRedTeam: true }
      ]
    });

    await runCouncil("\u6211\u53eb\u4ec0\u4e48\uff1f", group, tmp, { groupPath });

    const seat01Prompt = requests[0].messages.at(-1).content;
    // \u4fee\u590d\u524d\uff1a\u5ea7\u4f4d\u8bfb\u53d6\u8d70 fallback \u53ea\u7528 seatId \u547d\u540d\uff0c\u8bfb\u4e0d\u5230\u79c1\u804a \u2192 \u8fd9\u91cc\u4f1a\u62a5\u9519
    assert.match(seat01Prompt, /Private boss messages/);
    assert.match(seat01Prompt, /\u6211\u53eb\u5c0f\u660e/);
  } finally {
    await close(server);
  }
});

test("cleared reviewer flags override stale reviewer role text at provider boundary", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-stale-reviewer-role-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    groupPath,
    seats: [
      {
        seatId: "seat_01",
        displayName: "Former Reviewer",
        privateFolder: "members/Former Reviewer",
        role: "code reviewer",
        reviewer: false,
        mandatoryRedTeam: false,
        judge: false
      }
    ]
  }, null, 2), "utf8");

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "No new point.", memory_candidates: [] }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const group = validateGroupConfig({
      id: "stale-reviewer-role",
      name: "Stale Reviewer Role",
      settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000, allowSoloCouncil: true },
      agents: [
        {
          id: "seat_01",
          name: "Former Reviewer",
          role: "code reviewer",
          reviewer: false,
          mandatoryRedTeam: false,
          judge: false,
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
        }
      ]
    });

    await runCouncil("Are you still a reviewer?", group, tmp, { groupPath });

    const systemPrompt = requests[0].messages[0].content;
    const userPrompt = requests[0].messages.at(-1).content;
    assert.doesNotMatch(systemPrompt, /You are code reviewer\./);
    assert.match(systemPrompt, /Current assignment: ordinary member/);
    assert.match(systemPrompt, /old role text says you were a reviewer, that content is stale/);
    assert.match(userPrompt, /Current assignment: ordinary member/);
    assert.doesNotMatch(userPrompt, /Role: code reviewer/);
  } finally {
    await close(server);
  }
});


test("no explicit judge uses the last effective speaker as fallback finalizer", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-no-judge-"));
  const calls = [];
  const group = validateGroupConfig({
    id: "no-judge",
    name: "No Judge",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      },
      {
        id: "plain-judge-name",
        name: "Judge Name Only",
        role: "Judge",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-judge-name-only",
        weight: 1,
        enabled: true
      }
    ]
  });

  const { session } = await runCouncil("Question", group, tmp, { onModelCall: (call) => calls.push(call) });
  const finalCall = calls.find((call) => call.phase === "final");

  assert.equal(finalCall.agentId, "plain-judge-name");
  assert.equal(session.finalDecision.final_state, "ready_to_execute");
  assert.equal(session.groupSnapshot.agents.find((agent) => agent.id === "plain-judge-name").judge, undefined);
});

test("explicit reviewer skip is forced in round one but ordinary critic may skip", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-reviewer-skip-"));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "No objection." }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "reviewer-skip",
      name: "Reviewer Skip",
      settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "critic-name-only", name: "Critic", role: "Critic" },
        { ...baseAgent, id: "reviewer", name: "Reviewer", role: "Architect", reviewer: true, mandatoryRedTeam: true, reviewIntensity: 1 }
      ]
    });

    const { session } = await runCouncil("Question", group, tmp);
    const critic = session.messages.find((message) => message.agentId === "critic-name-only");
    const reviewer = session.messages.find((message) => message.agentId === "reviewer");

    assert.equal(critic.response.status, "skip");
    assert.equal(reviewer.response.status, "speak");
    assert.equal(reviewer.response.position, "reviewer_required");
    assert.equal(requests.length, 3);
  } finally {
    await close(server);
  }
});

test("cycle continuation context is injected into the next council prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-cycle-continuation-"));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Continuation acknowledged." }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "cycle",
      name: "Cycle",
      settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "finalizer", name: "Finalizer", role: "Finalizer", judge: true }
      ]
    });

    const { session } = await runCouncil("继续细化上一轮方案", group, tmp, {
      continuationContext: {
        previousSessionId: "session_previous",
        previousQuestion: "上一轮问题",
        finalState: "usable_with_risks",
        finalAnswer: "上一轮最终结论",
        summary: "上一轮压缩摘要",
        blockingIssues: [{ id: "risk-1", issue: "阻断问题仍未解决" }],
        risks: ["非阻断风险"],
        nextActions: ["下一步动作"]
      }
    });

    const firstPrompt = requests[0].messages.at(-1).content;
    assert.equal(session.continuationContext.previousSessionId, "session_previous");
    assert.match(firstPrompt, /Cycle continuation/);
    assert.match(firstPrompt, /Previous session: session_previous/);
    assert.match(firstPrompt, /上一轮最终结论/);
    assert.match(firstPrompt, /阻断问题仍未解决/);
    assert.match(firstPrompt, /下一步动作/);
  } finally {
    await close(server);
  }
});

test("public memory reaches model prompts as editable shared memory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-public-memory-runtime-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Memory received.", memory_candidates: [] }));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const workspaceGroup = {
      id: "public-memory-runtime",
      groupFolderName: "Public Memory Runtime",
      seats: [
        { seatId: "builder", displayName: "Builder", privateFolder: "members/Builder" },
        { seatId: "finalizer", displayName: "Finalizer", privateFolder: "members/Finalizer", judge: true }
      ],
      permissions: { defaultTier: "text", seatTiers: {} }
    };
    fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify(workspaceGroup, null, 2), "utf8");
    upsertPublicMemory(groupPath, {
      title: "World rule",
      content: "PUBLIC_MEMORY_RUNTIME_SECRET",
      source: "summarizer",
      sourceSessionId: "session_public"
    });

    const baseAgent = {
      provider: "openai-compatible",
      apiBaseUrl,
      allowUnsafePrivateNetwork: true,
      apiKey: "secret-runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true,
      providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
    };
    const group = validateGroupConfig({
      id: "public-memory-runtime",
      name: "Public Memory Runtime",
      settings: { maxRounds: 1, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000 },
      agents: [
        { ...baseAgent, id: "builder", name: "Builder", role: "Builder" },
        { ...baseAgent, id: "finalizer", name: "Finalizer", role: "Finalizer", judge: true }
      ]
    });

    await runCouncil("Use public memory.", group, tmp, { groupPath });
    const firstPrompt = requests[0].messages.at(-1).content;
    assert.match(firstPrompt, /PUBLIC_MEMORY_RUNTIME_SECRET/);
    assert.match(firstPrompt, /editable summary, not as the original facts/);
    assert.match(firstPrompt, /Source: summarizer/);
  } finally {
    await close(server);
  }
});

test("task state ledger is written after a session and injected into the next run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-task-state-run-"));
  const group = validateGroupConfig({
    id: "task-state-run",
    name: "Task State Run",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Builder",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      }
    ]
  });

  await runCouncil("First task state question.", group, tmp, { groupPath: tmp });
  const taskStatePath = path.join(tmp, "shared", "task_state.json");
  assert.equal(fs.existsSync(taskStatePath), true);
  assert.match(fs.readFileSync(taskStatePath, "utf8"), /Proceed with a CLI-first prototype/);

  const calls = [];
  await runCouncil("Second task state question.", group, tmp, {
    groupPath: tmp,
    onModelCall: (call) => calls.push(call)
  });
  const roundPrompt = calls.find((call) => call.phase === "round").inputMessages.map((message) => message.content).join("\n");
  assert.match(roundPrompt, /Task state ledger/);
  assert.match(roundPrompt, /Proceed with a CLI-first prototype/);
  assert.doesNotMatch(roundPrompt, /private-chat\.jsonl/);
});

test("saved public archive snippets are retrieved and injected into later prompts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-retrieval-run-"));
  const archivedSession = {
    id: "session_archive_runtime_1",
    question: "Earlier retrieval planning.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "builder",
        agentName: "Builder",
        response: { status: "speak", argument: "ARCHIVE_RUNTIME_FACT should be reused when retrieval is mentioned." },
        createdAt: "2026-07-08T10:00:20.000Z"
      }
    ],
    finalDecision: {
      final_state: "ready_to_execute",
      answer: "Archive saved."
    }
  };
  writeContextArchive(archivedSession, tmp);
  fs.mkdirSync(path.join(tmp, "members", "Builder", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "members", "Builder", "inbox", "private-chat.jsonl"), "PRIVATE_ARCHIVE_RUNTIME_FACT", "utf8");

  const group = validateGroupConfig({
    id: "context-retrieval-run",
    name: "Context Retrieval Run",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Builder",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      }
    ]
  });

  const calls = [];
  const result = await runCouncil("Please continue the retrieval work.", group, tmp, {
    groupPath: tmp,
    onModelCall: (call) => calls.push(call)
  });
  const roundPrompt = calls.find((call) => call.phase === "round").inputMessages.map((message) => message.content).join("\n");

  assert.equal(result.session.contextRetrievalResults.length >= 1, true);
  assert.match(roundPrompt, /Relevant archived context/);
  assert.match(roundPrompt, /ARCHIVE_RUNTIME_FACT/);
  assert.match(roundPrompt, /session_archive_runtime_1/);
  assert.doesNotMatch(roundPrompt, /PRIVATE_ARCHIVE_RUNTIME_FACT/);
  assert.doesNotMatch(roundPrompt, /private-chat\.jsonl/);
});

test("archive retrieval injection exposes compression status", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-archive-budget-status-"));
  for (let index = 1; index <= 3; index += 1) {
    writeContextArchive({
      id: `session_archive_budget_${index}`,
      question: "Please continue budgeted archive work.",
      createdAt: `2026-07-08T10:0${index}:00.000Z`,
      completedAt: `2026-07-08T10:0${index}:20.000Z`,
      status: "completed",
      messages: [
        {
          round: 1,
          agentId: "builder",
          agentName: "Builder",
          response: {
            status: "speak",
            argument: `BUDGET_STATUS_ARCHIVE_${index} ${"long archived context ".repeat(160)}`
          },
          createdAt: `2026-07-08T10:0${index}:10.000Z`
        }
      ],
      finalDecision: {
        final_state: "ready_to_execute",
        answer: `Budget archive ${index}.`
      }
    }, tmp);
  }

  const group = validateGroupConfig({
    id: "archive-budget-status",
    name: "Archive Budget Status",
    settings: {
      maxRounds: 1,
      minConsensusWeight: 1,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000,
      allowSoloCouncil: true,
      contextSearchLimit: 3,
      contextArchiveInjectionTokens: 180
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        role: "Builder",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock-builder",
        weight: 1,
        enabled: true
      }
    ]
  });

  const events = [];
  for await (const event of runCouncilEvents("Please continue budgeted archive work.", group, tmp, { groupPath: tmp })) {
    events.push(event);
  }
  const start = events.find((event) => event.type === "agent_start");

  assert.equal(start.contextStatus.archiveContextCompression.applied, true);
  assert.equal(start.contextStatus.archiveContextCompression.maxTokens, 180);
  assert.ok(start.contextStatus.archiveContextCompression.droppedCount > 0);
  assert.ok(start.contextStatus.archiveContextCompression.keptCount > 0);
});

test("read/list file operations are executed and returned in later model context", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-read-list-runtime-"));
  const groupPath = path.join(tmp, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "README.md"), "REAL_READ_RESULT", "utf8");
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    seats: [{ seatId: "builder", displayName: "Builder", privateFolder: "members/Builder" }],
    permissions: { defaultTier: "text", seatTiers: { builder: "tool" } }
  }, null, 2), "utf8");

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const payloads = [
      {
        status: "speak",
        argument: "I need to inspect README.",
        objections: [],
        file_operations: [
          {
            op: "read",
            path: "README.md",
            reason: "Read the project note.",
            expected_effect: "README content is available."
          }
        ],
        confidence: 0.6,
        memory_candidates: []
      },
      { status: "skip", reason: "Read result is now available." },
      {
        answer: "Done.",
        consensus_score: 1,
        supporting_agents: ["Builder"],
        dissenting_agents: [],
        minority_report: "None.",
        risks: [],
        next_actions: [],
        memory_candidates: []
      }
    ];
    writeOpenAiStream(res, JSON.stringify(payloads[Math.min(requests.length - 1, payloads.length - 1)]));
  });
  await listen(server);
  const apiBaseUrl = "http://127.0.0.1:" + server.address().port + "/v1";

  try {
    const group = validateGroupConfig({
      id: "read-list-runtime",
      name: "Read List Runtime",
      settings: { maxRounds: 2, minConsensusWeight: 1, stopWhenAllSkip: true, agentTimeoutMs: 1000, allowSoloCouncil: true },
      agents: [
        {
          id: "builder",
          name: "Builder",
          role: "Builder",
          provider: "openai-compatible",
          apiBaseUrl,
          allowUnsafePrivateNetwork: true,
          apiKey: "secret-runtime-key",
          model: "runtime-model",
          weight: 1,
          enabled: true,
          judge: true,
          consensusParticipant: true,
          providerLimits: { contextWindow: 12000, maxOutputTokens: 1000 }
        }
      ]
    });

    const { session } = await runCouncil("Inspect README then answer.", group, tmp, { groupPath });
    const secondRoundPrompt = requests[1].messages.at(-1).content;

    assert.equal(session.pendingFileOperationProposals.length, 0);
    assert.equal(session.fileOperationExecutionResults.length, 1);
    assert.equal(session.fileOperationExecutionResults[0].status, "completed");
    assert.match(session.fileOperationExecutionResults[0].content, /REAL_READ_RESULT/);
    assert.match(secondRoundPrompt, /File operation execution results/);
    assert.match(secondRoundPrompt, /REAL_READ_RESULT/);
  } finally {
    await close(server);
  }
});

function writeDiscussionFakeMcpPackage(root) {
  const packageDir = path.join(root, `fake-mcp-chain-package-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "fake-mcp-chain-package",
    version: "1.0.0",
    type: "module",
    bin: {
      "fake-mcp": "server.mjs"
    }
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(packageDir, "server.mjs"), [
    "#!/usr/bin/env node",
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "for await (const line of rl) {",
    "  if (!line.trim()) continue;",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'notifications/initialized') continue;",
    "  if (message.method === 'initialize') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fake-chain', version: '1.0.0' } } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'tools/call') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params?.arguments || {}) }], isError: false } });",
    "    continue;",
    "  }",
    "  if (message.method === 'resources/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'memo://chain', name: 'Chain Memo', mimeType: 'text/plain' }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'resources/read') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: message.params?.uri, mimeType: 'text/plain', text: 'MCP_RESOURCE_CHAIN_FACT from ' + message.params?.uri }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'prompts/list') {",
    "    write({ jsonrpc: '2.0', id: message.id, result: { prompts: [{ name: 'brief', description: 'Chain prompt', arguments: [{ name: 'topic' }] }] } });",
    "    continue;",
    "  }",
    "  if (message.method === 'prompts/get') {",
    "    const topic = message.params?.arguments?.topic || 'none';",
    "    write({ jsonrpc: '2.0', id: message.id, result: { description: 'Chain prompt', messages: [{ role: 'user', content: { type: 'text', text: 'Prompt topic: ' + topic } }] } });",
    "    continue;",
    "  }",
    "  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });",
    "}",
    "function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    ""
  ].join("\n"), "utf8");
  return packageDir;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeOpenAiStream(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
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
