import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advanceExecutionState, createExecutionState, executionInstruction, isDeliveryTask, selectExecutionAgents } from "../src/executionState.js";

const agents = [
  { id: "designer", name: "Designer", enabled: true },
  { id: "builder", name: "Builder", enabled: true },
  { id: "reviewer", name: "Reviewer", enabled: true, mandatoryRedTeam: true },
  { id: "judge", name: "Judge", enabled: true, judge: true }
];
const workspaceGroup = {
  permissions: {
    defaultTier: "text",
    seatTiers: { designer: "tool", builder: "full", reviewer: "tool" }
  }
};

test("delivery tasks choose one highest-permission executor", () => {
  const state = createExecutionState({ question: "Build a real project.", agents, workspaceGroup });
  assert.equal(state.active, true);
  assert.equal(state.executorId, "builder");
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
  assert.match(executionInstruction(state, agents[1]), /primary executor/);
});

test("Chinese report requests are delivery work owned by one full-permission executor", () => {
  const question = "帮我做一个关于我的世界兔子模组的调查报告，要完整全面，图文并茂，编辑在1个pdf文件里面，放在桌面上";
  const state = createExecutionState({ question, agents, workspaceGroup });
  assert.equal(isDeliveryTask(question), true);
  assert.equal(state.active, true);
  assert.equal(state.executorId, "builder");
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
});

test("reviewers join only after a real checkpoint and own the review phase", () => {
  const state = createExecutionState({ question: "Create the project files.", agents, workspaceGroup });
  state.phase = "verify";
  state.checkpointVersion = 1;
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder", "reviewer"]);
  state.phase = "review";
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["reviewer"]);
});

test("workspace mutation advances the executor to verification", () => {
  const state = createExecutionState({ question: "Create a source file.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "command-write",
      tool: "execute_command",
      status: "completed",
      result: { ok: true, workspaceChanges: { totalChanges: 1, created: [{ path: "src/App.java" }] } }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };
  advanceExecutionState({ state, session, agent: agents[1], question: "Create a source file." });
  assert.equal(state.phase, "verify");
  assert.equal(state.checkpointVersion, 1);
  assert.match(state.nextAction, /build or test/);
});

test("failed build transitions to repair with exact error evidence", () => {
  const state = createExecutionState({ question: "Build a JAR.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "gradle-build",
      tool: "execute_command",
      command: ".\\gradlew.bat build",
      status: "failed",
      error: "Java compilation failed",
      result: { ok: false, exitCode: 1, stderr: "cannot find symbol" }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };
  advanceExecutionState({ state, session, agent: agents[1], question: "Build a JAR." });
  assert.equal(state.phase, "repair");
  assert.match(state.lastError, /Java compilation failed/);
  assert.match(state.nextAction, /patch/);
});

test("a failed artifact command after a workspace write enters repair even without a verification reason", () => {
  const state = createExecutionState({ question: "Create a PDF report.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [
      {
        id: "write-generator",
        tool: "workspace_edit",
        status: "completed",
        result: { ok: true, workspaceChanges: { totalChanges: 1, created: [{ path: "generate_report.py" }] } }
      },
      {
        id: "run-generator",
        tool: "execute_command",
        command: "python generate_report.py",
        status: "failed",
        error: "Command exited with code 1.",
        result: { ok: false, exitCode: 1, stderr: "FileNotFoundError: wrong output directory" }
      }
    ],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });
  assert.equal(state.phase, "repair");
  assert.equal(state.lastAction, "verification_failed:run-generator");
  assert.match(state.lastError, /Command exited with code 1/);
  assert.match(state.lastError, /wrong output directory/);
  assert.match(state.nextAction, /patch/);
});

test("the latest verification wins after an in-loop repair", () => {
  const state = createExecutionState({ question: "Create and test a source project.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [
      { id: "test-failed", tool: "run_tests", status: "failed", error: "first failure", result: { ok: false, exitCode: 1 } },
      { id: "patch", tool: "workspace_edit", status: "completed", result: { workspaceChanges: { totalChanges: 1, modified: [{ path: "src/app.js" }] } } },
      { id: "test-passed", tool: "run_tests", status: "completed", result: { ok: true, passed: true, exitCode: 0 } }
    ],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents: agents.filter((agent) => agent.id !== "reviewer") }
  };
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });
  assert.equal(state.phase, "complete");
  assert.equal(state.lastAction, "verification_passed:test-passed");
  assert.equal(state.lastError, "");
});

test("successful verification enters review and a clean reviewer closes the checkpoint", () => {
  const state = createExecutionState({ question: "Create and test a source project.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "npm-test",
      tool: "run_tests",
      status: "completed",
      result: { ok: true, passed: true, exitCode: 0 }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });
  assert.equal(state.phase, "review");
  assert.equal(state.artifactStatus, "not_requested");
  advanceExecutionState({ state, session, agent: agents[2], response: { status: "skip", objection_items: [] } });
  assert.equal(state.phase, "complete");
  assert.equal(state.reviewedCheckpointVersion, state.checkpointVersion);
});

test("an explicit generic validation command is a real verification checkpoint", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-generic-validation-"));
  fs.mkdirSync(path.join(groupPath, "deliverables"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "deliverables", "catalog.json"), '{"items":[]}\n', "utf8");
  const state = createExecutionState({ question: "Create deliverables/catalog.json and validate the JSON.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [
      {
        id: "catalog-observation",
        tool: "read_file",
        path: "deliverables/catalog.json",
        status: "completed",
        result: { ok: true, path: "deliverables/catalog.json", content: '{"items":[]}' }
      },
      {
        id: "catalog-parse",
        tool: "execute_command",
        command: "node -e \"JSON.parse(require('node:fs').readFileSync('deliverables/catalog.json', 'utf8'))\"",
        reason: "Validate the generated catalog JSON parses.",
        status: "completed",
        result: { ok: true, exitCode: 0 }
      }
    ],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], groupPath, question: state.taskQuestion });
  assert.equal(state.phase, "review");
  assert.equal(state.artifactStatus, "verified");
  assert.equal(state.lastAction, "verification_passed:catalog-parse");
  assert.equal(state.checkpointEvidence.some((item) => item.id === "catalog-parse" && item.outcome === "exit=0"), true);
  assert.match(executionInstruction(state, agents[2]), /catalog-parse/);
});

test("a successful validation script is a checkpoint even when the model omits a reason", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-script-validation-"));
  fs.mkdirSync(path.join(groupPath, "deliverables"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "deliverables", "catalog.json"), '{"items":[]}\n', "utf8");
  const state = createExecutionState({ question: "Create deliverables/catalog.json and validate the JSON.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [
      {
        id: "catalog-observation",
        tool: "read_file",
        path: "deliverables/catalog.json",
        status: "completed",
        result: { ok: true, path: "deliverables/catalog.json", content: '{"items":[]}' }
      },
      {
        id: "catalog-validation-script",
        tool: "execute_command",
        command: "python deliverables/validate_catalog.py",
        reason: "",
        status: "completed",
        result: { ok: true, exitCode: 0 }
      }
    ],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], groupPath, question: state.taskQuestion });
  assert.equal(state.phase, "review");
  assert.equal(state.artifactStatus, "verified");
  assert.equal(state.lastAction, "verification_passed:catalog-validation-script");
});

test("assertion-bearing run_code results create a verification checkpoint without retaining source code", () => {
  const state = createExecutionState({ question: "Create and validate a source project.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "inline-assertion",
      tool: "run_code",
      status: "completed",
      result: { ok: true, exitCode: 0, verificationIntent: true }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });
  assert.equal(state.phase, "review");
  assert.equal(state.lastAction, "verification_passed:inline-assertion");
});

test("explicit verification reasons make successful run_code a checkpoint without a private intent flag", () => {
  const state = createExecutionState({ question: "Create and validate a source project.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "reason-labeled-validation",
      tool: "run_code",
      reason: "Verify the generated document content.",
      status: "completed",
      result: { ok: true, exitCode: 0 }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });
  assert.equal(state.phase, "review");
  assert.equal(state.lastAction, "verification_passed:reason-labeled-validation");
});

test("reviewer blocking evidence sends the same executor back to repair", () => {
  const state = createExecutionState({ question: "Create and test a source project.", agents, workspaceGroup });
  state.phase = "review";
  state.checkpointVersion = 2;
  state.artifactStatus = "not_requested";

  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[2],
    response: {
      status: "speak",
      objection_items: [{ id: "missing-test", issue: "The required integration test is missing.", blocks_final: true, in_scope: true }]
    }
  });

  assert.equal(state.phase, "repair");
  assert.match(state.lastError, /integration test/);
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
});

test("an interrupted continuation resumes the execution owner and pending phase", () => {
  const previousState = createExecutionState({ question: "构建一个真实项目并打包。", agents, workspaceGroup });
  previousState.phase = "repair";
  previousState.checkpointVersion = 3;
  previousState.lastError = "Compilation failed";
  previousState.processedToolResults = 9;

  const resumed = createExecutionState({
    question: "构建一个真实项目并打包。",
    agents,
    workspaceGroup,
    previousState
  });

  assert.equal(resumed.active, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.phase, "repair");
  assert.equal(resumed.executorId, "builder");
  assert.equal(resumed.taskQuestion, "构建一个真实项目并打包。");
  assert.equal(resumed.processedToolResults, 0);
});

test("Chinese project requests activate delivery execution", () => {
  const state = createExecutionState({ question: "做一个模组，写完代码后构建成 jar 包。", agents, workspaceGroup });
  assert.equal(state.active, true);
  assert.equal(state.executorId, "builder");
});

test("delivery classification ignores review nouns and path mentions", () => {
  assert.equal(isDeliveryTask("Review this code and file: D:\\work\\MASTER_PLAN.md. Give suggestions only."), false);
  assert.equal(isDeliveryTask("审查这个项目里的代码和文件，只给建议，不要改动。"), false);
});

test("review directive is not overridden by delivery words inside the supplied project description", () => {
  const question = [
    "帮我看看这个项目怎么样：# AI Alex 项目完整介绍",
    "",
    "The roadmap repeatedly says build, create, implement, fix, package and install.",
    "项目内部计划包含构建、生成、制作、开发、实现、编写、修改、修复、打包和安装。",
    "",
    "对应 Git 版本是 4b813f3。"
  ].join("\n");

  assert.equal(isDeliveryTask(question), false);
});

test("inspect-then-continue instructions for a current artifact remain delivery work", () => {
  assert.equal(isDeliveryTask("Inspect the retained API task context and current deliverables/catalog-6.json, then continue from the newest requirement without creating a replacement artifact."), true);
  assert.equal(isDeliveryTask("Inspect current output.json only; do not modify or change the file."), false);
  assert.equal(isDeliveryTask("检查现有 output.json，然后继续处理最新要求，不要创建替代文件。"), true);
  assert.equal(isDeliveryTask("只检查现有 output.json，不要修改文件。"), false);
});

test("delivery classification requires an explicit delivery action", () => {
  assert.equal(isDeliveryTask("Fix the code and build the JAR."), true);
  assert.equal(isDeliveryTask("Update the existing catalog JSON to preserve every collected item."), true);
  assert.equal(isDeliveryTask("Make the final requested catalog update without inventing or dropping API records. Preserve response order and validate the current JSON artifact."), true);
  assert.equal(isDeliveryTask("Should we update the existing catalog JSON?"), false);
  const followUp = "Use the latest requirements only: the final JSON must have source set to api_collection and an items array with id, title, priority and active for every collected item. Validate it.";
  assert.equal(isDeliveryTask(followUp), true);
  assert.equal(createExecutionState({ question: followUp, agents, workspaceGroup }).active, true);
  assert.equal(isDeliveryTask("Analyze whether the final JSON must include active fields."), false);
  assert.equal(isDeliveryTask("请修改代码并构建 jar 包。"), true);
});
