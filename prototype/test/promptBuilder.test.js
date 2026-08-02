import test from "node:test";
import assert from "node:assert/strict";
import { buildFinalPrompt, buildRoundPrompt } from "../src/promptBuilder.js";

test("round prompt uses arbitrary user-defined role identity", () => {
  const directorRole = "\u5bfc\u6f14";
  const messages = buildRoundPrompt({
    id: "director",
    name: "gpt-director",
    role: directorRole,
    provider: "mock",
    apiBaseUrl: "mock://local",
    model: "mock",
    weight: 1,
    enabled: true
  }, "Question", { messages: [] }, 1);

  const system = messages[0].content;
  assert.match(system, /\[Role identity\]/);
  assert.match(system, /\[Software protocol\]/);
  assert.ok(system.includes(`You are ${directorRole}.`));
  assert.match(system, /If you agree and have no new information, return skip\./);
  assert.ok(system.includes(`gpt-director${"\u8bf4\uff1a"}`));
});

test("round prompt separates user role instructions from software protocol", () => {
  const messages = buildRoundPrompt({
    id: "student",
    name: "Student",
    role: "\u5b66\u751f",
    instructions: "\u7528\u5b66\u751f\u89c6\u89d2\u63d0\u95ee\u3002"
  }, "Question", { messages: [] }, 1);

  const system = messages[0].content;
  assert.match(system, /\[User role instructions\]\n\u7528\u5b66\u751f\u89c6\u89d2\u63d0\u95ee\u3002/);
  assert.ok(system.indexOf("[User role instructions]") < system.indexOf("[Software protocol]"));
});

test("final prompt constrains memory candidates to durable memories", () => {
  const messages = buildFinalPrompt({
    id: "judge",
    name: "Judge",
    role: "Judge"
  }, {
    question: "Question",
    unresolvedObjections: {},
    messages: []
  }, {
    score: 1,
    supportingAgents: ["Judge"],
    dissentingAgents: []
  });

  const system = messages[0].content;
  assert.match(system, /stable user preferences, durable project rules, or explicit facts/);
  assert.match(system, /Do not put this session's conclusions, risks, next actions/);
  assert.match(system, /empty array/);
  assert.match(system, /Artifacts are the machine-usable deliverables/);
  assert.match(system, /reference the latest relevant artifacts/);
});

test("global requirement is injected into round and final prompts", () => {
  const agent = {
    id: "reviewer",
    name: "Reviewer",
    role: "\u590d\u67e5\u5458",
    provider: "mock",
    apiBaseUrl: "mock://local",
    model: "mock",
    weight: 1,
    enabled: true
  };
  const session = {
    question: "Question",
    unresolvedObjections: {},
    messages: []
  };
  const requirement = "\u6240\u6709\u56de\u7b54\u5fc5\u987b\u7b80\u6d01\uff0c\u5e76\u4fdd\u7559\u98ce\u9669\u3002";
  const options = { globalRequirement: requirement };

  const round = buildRoundPrompt(agent, "Question", session, 1, options);
  const final = buildFinalPrompt(agent, session, { score: 1 }, options);

  assert.ok(round[0].content.includes(`Global requirement from the boss: ${requirement}`));
  assert.ok(final[0].content.includes(`Global requirement from the boss: ${requirement}`));
});

test("round prompt can include a continuation instruction", () => {
  const messages = buildRoundPrompt({
    id: "critic",
    name: "Critic",
    role: "\u590d\u67e5\u5458"
  }, "Question", { messages: [] }, 1, {
    resumeInstruction: "Continue from the interrupted output."
  });

  assert.match(messages[0].content, /Continuation instruction: Continue from the interrupted output\./);
});

test("round prompt includes suggested revisions in transcript", () => {
  const messages = buildRoundPrompt({
    id: "reviewer",
    name: "Reviewer",
    role: "Reviewer"
  }, "Question", {
    messages: [
      {
        round: 1,
        agentId: "executor",
        agentName: "Executor",
        response: {
          status: "speak",
          argument: "I implemented the helper.",
          suggested_revision: "function buildTodoStats(todos) { return {}; }"
        }
      }
    ]
  }, 2);

  assert.match(messages[1].content, /Executor: speak: I implemented the helper\./);
  assert.match(messages[1].content, /suggested_revision:\nfunction buildTodoStats/);
});

test("round prompt can use member context sections instead of full transcript", () => {
  const messages = buildRoundPrompt({
    id: "reviewer",
    name: "Reviewer",
    role: "Reviewer"
  }, "Question", {
    messages: [
      {
        round: 1,
        agentId: "old",
        agentName: "Old Agent",
        response: {
          status: "speak",
          argument: "This old transcript should not appear."
        }
      }
    ]
  }, 2, {
    contextSections: [
      { title: "Non-compressible core", content: "Latest artifacts: []\nUnresolved objections: {}" },
      { title: "Recent transcript", content: "Round 2 / Reviewer: useful recent note" }
    ]
  });

  assert.match(messages[1].content, /Member context:/);
  assert.match(messages[1].content, /## Non-compressible core/);
  assert.match(messages[1].content, /useful recent note/);
  assert.doesNotMatch(messages[1].content, /old transcript should not appear/);
});
test("final prompt includes session artifacts", () => {
  const messages = buildFinalPrompt({
    id: "judge",
    name: "Judge",
    role: "Judge"
  }, {
    question: "Question",
    unresolvedObjections: {},
    artifacts: [
      {
        id: "executor-r1-a1",
        type: "code",
        source_agent_name: "Executor",
        content: "function buildTodoStats(todos) { return {}; }"
      }
    ],
    messages: []
  }, {
    score: 1,
    supportingAgents: ["Judge"],
    dissentingAgents: []
  });

  assert.match(messages[1].content, /"artifacts"/);
  assert.match(messages[1].content, /buildTodoStats/);
});

test("final prompt can use member context sections instead of full transcript", () => {
  const messages = buildFinalPrompt({
    id: "judge",
    name: "Judge",
    role: "Judge"
  }, {
    question: "Question",
    unresolvedObjections: { critic: ["Keep this risk."] },
    artifacts: [
      {
        id: "executor-r1-a1",
        type: "code",
        content: "export const canonical = true;"
      }
    ],
    messages: [
      {
        round: 1,
        agentName: "Old Agent",
        displayText: "This old full transcript should not be replayed.",
        response: { status: "speak", argument: "old" }
      }
    ]
  }, {
    score: 0.8,
    supportingAgents: ["Builder"],
    dissentingAgents: ["Critic"]
  }, {
    contextSections: [
      { title: "Non-compressible core", content: "Latest artifacts: canonical\nUnresolved objections: Keep this risk." },
      { title: "Recent transcript", content: "Round 2 / Judge: short recent note" }
    ]
  });

  assert.match(messages[1].content, /"memberContext"/);
  assert.match(messages[1].content, /## Non-compressible core/);
  assert.match(messages[1].content, /export const canonical = true/);
  assert.doesNotMatch(messages[1].content, /old full transcript should not be replayed/);
});

test("completion skip guidance applies to non-reviewers only", () => {
  const nonReviewer = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Question", { messages: [] }, 2);
  const reviewer = buildRoundPrompt({
    id: "critic",
    name: "Critic",
    role: "Critic",
    reviewer: true,
    mandatoryRedTeam: true
  }, "Question", { messages: [] }, 2);

  assert.match(nonReviewer[0].content, /For non-reviewer roles/);
  assert.match(nonReviewer[0].content, /return skip instead of repeating yourself/);
  assert.doesNotMatch(reviewer[0].content, /For non-reviewer roles/);
  assert.match(reviewer[0].content, /Do not use completion-only agreement as a reason to skip/);
});

test("stale reviewer role text is overridden for ordinary members", () => {
  const messages = buildRoundPrompt({
    id: "former-reviewer",
    name: "Former Reviewer",
    role: "code reviewer",
    reviewer: false,
    mandatoryRedTeam: false
  }, "Question", {
    messages: [
      {
        round: 1,
        agentName: "Former Reviewer",
        response: {
          status: "speak",
          argument: "I used to say I was a reviewer."
        }
      }
    ]
  }, 2);

  assert.doesNotMatch(messages[0].content, /You are code reviewer\./);
  assert.match(messages[0].content, /Current assignment: ordinary member/);
  assert.match(messages[0].content, /old role text says you were a reviewer, that content is stale/);
  assert.match(messages[0].content, /For non-reviewer roles/);
  assert.doesNotMatch(messages[0].content, /Review intensity/);
});

test("round prompt advertises artifacts in speak schema", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Question", { messages: [] }, 1);

  assert.match(messages[0].content, /suggested_revision, artifacts, file_operations, tool_requests, task_contract, task_delegations, delegation_handoff, confidence/);
  assert.match(messages[0].content, /runtime already created a provisional contract/);
  assert.match(messages[0].content, /optional, never blocks other authorized tools/);
  assert.match(messages[0].content, /\[Execution owner\] must use delegate_task/);
  assert.match(messages[0].content, /Do not put full source code/);
  assert.match(messages[0].content, /Never invent tool results/);
  assert.match(messages[0].content, /op, path, reason, expected_effect/);
  assert.match(messages[0].content, /write\/append also require content/);
  assert.ok(messages[0].content.length < 5000, `system prompt is ${messages[0].content.length} chars`);
  assert.doesNotMatch(messages[0].content, /mcp_search_npm for real npm registry search/);
});

test("full-permission workspace prompt requires real complete tool writes", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Create src/sumNumbers.js", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full"
  });

  assert.match(messages[0].content, /Use workspace_edit for file mutations/);
  assert.match(messages[0].content, /Prefer one complete workspace_edit per file/);
  assert.match(messages[0].content, /finish and verify every chunk/);
  assert.doesNotMatch(messages[0].content, /exactly one write or append/);
  assert.doesNotMatch(messages[0].content, /under 1400 characters/);
});

test("final prompt requires evidence ids for workspace deliverable claims", () => {
  const messages = buildFinalPrompt({
    id: "judge",
    name: "Judge",
    role: "Finalizer",
    judge: true
  }, {
    question: "Build a package.",
    messages: [],
    artifacts: [],
    unresolvedObjections: {}
  }, { score: 1, supportingAgents: [], dissentingAgents: [] });

  assert.match(messages[0].content, /also include deliverables/);
  assert.match(messages[0].content, /evidence_ids/);
  assert.match(messages[0].content, /failed, timed-out, or background tool calls/);
});

test("text-only workspace round prompt does not ask the member to propose file_operations", () => {
  const messages = buildRoundPrompt({
    id: "architect",
    name: "Architect",
    role: "Architect"
  }, "Create src/sumNumbers.js", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "text"
  });

  assert.match(messages[0].content, /text-only file permission/);
  assert.match(messages[0].content, /Text-only seats may use search_context\/load_context plus tool_search\/tool_inspect/);
  assert.match(messages[0].content, /tool_invoke still enforces the underlying permission/);
  assert.match(messages[0].content, /do not propose file_operations yourself/);
  assert.doesNotMatch(messages[0].content, /MUST propose the change in file_operations/);
});

test("tool prompts defer the long tool catalog to native schemas", () => {
  const full = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Extract docs.zip", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full"
  });
  const tool = buildRoundPrompt({
    id: "reader",
    name: "Reader",
    role: "Reader"
  }, "Extract docs.zip", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "tool"
  });

  for (const prompt of [full[0].content, tool[0].content]) {
    assert.match(prompt, /Native schemas are the tool contract/);
    assert.match(prompt, /tool_search[\s\S]*tool_inspect[\s\S]*tool_invoke/);
    assert.doesNotMatch(prompt, /mcp_search_npm for real npm registry search/);
    assert.ok(prompt.length < 5000, `system prompt is ${prompt.length} chars`);
  }
});

test("round prompt overrides the generic catalog with globally disabled tools", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Inspect and edit the workspace", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full",
    appSettings: {
      capabilities: {
        toolAccess: { web: false, files: false, automation: false }
      }
    }
  });

  assert.match(messages[0].content, /Global settings have disabled file tools/);
  assert.match(messages[0].content, /disabled and unavailable/);
  assert.match(messages[0].content, /web_search/);
  assert.match(messages[0].content, /read_file/);
  assert.match(messages[0].content, /execute_command/);
  assert.doesNotMatch(messages[0].content, /MUST propose the change in file_operations/);
});

test("round prompt tells members the real tool runtime environment", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Run build tools", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full"
  });

  assert.match(messages[0].content, /Tool runtime:/);
  if (process.platform === "win32") {
    assert.match(messages[0].content, /Windows/);
    assert.match(messages[0].content, /system\/cmd\/PowerShell syntax/);
    assert.match(messages[0].content, /pass PowerShell scripts directly/);
  }
});

test("round prompt accepts a discovered local runtime summary", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Run build tools", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full",
    runtimeEnvironment: "Detected tool runtime (real local discovery): java=C:/jdk/bin/java.exe; managed Gradle=F:/tools/gradle/bin/gradle.bat."
  });

  assert.match(messages[0].content, /Detected tool runtime \(real local discovery\)/);
  assert.match(messages[0].content, /managed Gradle/);
});

test("reviewer prompt includes intensity, scope gate, duplicate gate, and open ledger", () => {
  const messages = buildRoundPrompt({
    id: "reviewer",
    name: "Reviewer",
    role: "Reviewer",
    reviewer: true,
    reviewIntensity: 1
  }, "Question", {
    messages: [],
    objectionLedger: {
      reviewer: {
        "risk-1": {
          id: "risk-1",
          issue: "Code does not run.",
          severity: "blocker",
          blocks_final: true,
          in_scope: true,
          status: "open",
          source_agent_name: "Reviewer"
        }
      }
    }
  }, 2);

  assert.match(messages[0].content, /Review intensity: 1/);
  assert.match(messages[0].content, /Scope gate/);
  assert.match(messages[0].content, /Duplicate gate/);
  assert.match(messages[0].content, /objection_items/);
  assert.match(messages[0].content, /resolved_ids/);
  assert.match(messages[1].content, /Open objection ledger/);
  assert.match(messages[1].content, /risk-1/);
});
test("final prompt includes pending file operation proposal summaries", () => {
  const messages = buildFinalPrompt({
    id: "judge",
    name: "Judge",
    role: "Judge"
  }, {
    question: "Question",
    unresolvedObjections: {},
    artifacts: [],
    pendingFileOperationProposals: [
      {
        id: "fop_selected",
        op: "write",
        path: "src/selected.js",
        content: "export const secretContent = true;",
        source_agent_id: "executor",
        source_agent_name: "Executor",
        round: 1,
        reason: "Create selected module.",
        expected_effect: "Selected module exists.",
        status: "pending_user_approval"
      }
    ],
    messages: []
  }, {
    score: 1,
    supportingAgents: ["Executor"],
    dissentingAgents: []
  });

  assert.match(messages[0].content, /selected_file_operation_ids/);
  assert.match(messages[1].content, /pendingFileOperationProposals/);
  assert.match(messages[1].content, /fop_selected/);
  assert.match(messages[1].content, /src\/selected\.js/);
  assert.match(messages[1].content, /Create selected module/);
  assert.doesNotMatch(messages[1].content, /secretContent/);
});
