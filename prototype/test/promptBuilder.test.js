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
  assert.match(system, /If you agree with the prior context and have no new objection, return skip\./);
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

  assert.match(messages[0].content, /suggested_revision, artifacts, file_operations, tool_requests, confidence/);
  assert.match(messages[0].content, /only to request file work/);
  assert.match(messages[0].content, /Do not invent tool results/);
  assert.match(messages[0].content, /api_request/);
  assert.match(messages[0].content, /search saved public group history/);
  assert.match(messages[0].content, /search_context/);
  assert.match(messages[0].content, /load_context/);
  assert.match(messages[0].content, /extract_archive/);
  assert.match(messages[0].content, /execute_command/);
  assert.match(messages[0].content, /run_code/);
  assert.match(messages[0].content, /install_package/);
  assert.match(messages[0].content, /run_tests/);
  assert.match(messages[0].content, /git_operation/);
  assert.match(messages[0].content, /browser_control/);
  assert.match(messages[0].content, /database_query/);
  assert.match(messages[0].content, /sessionId and optional round/);
  assert.match(messages[0].content, /read\/list can be executed by the app/);
  assert.match(messages[0].content, /op, path, reason, expected_effect/);
  assert.match(messages[0].content, /write\/append also require content/);
});

test("workspace round prompt requires file_operations for file-writing tasks", () => {
  const messages = buildRoundPrompt({
    id: "executor",
    name: "Executor",
    role: "Executor"
  }, "Create src/sumNumbers.js", { messages: [] }, 1, {
    fileOperationContext: true,
    fileOperationPermissionTier: "full"
  });

  assert.match(messages[0].content, /MUST propose the change in file_operations/);
  assert.match(messages[0].content, /full file content for write\/append/);
  assert.match(messages[0].content, /Do not put complete file content only in argument/);
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
  assert.match(messages[0].content, /Do not request .*api_request.*search_context.*load_context.*extract_archive.*execute_command.*run_code.*install_package.*run_tests.*git_operation.*browser_control.*database_query.*mcp_install_npm.*mcp_uninstall.*mcp_list_tools.*mcp_call.*mcp_list_resources.*mcp_read_resource.*mcp_list_prompts.*mcp_get_prompt/);
  assert.match(messages[0].content, /do not propose file_operations yourself/);
  assert.doesNotMatch(messages[0].content, /MUST propose the change in file_operations/);
});

test("full tool prompt advertises full-only tools while tool tier does not", () => {
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

  assert.match(full[0].content, /extract_archive for zip files/);
  assert.match(full[0].content, /execute_command for real shell commands/);
  assert.match(full[0].content, /api_request for real HTTP API calls/);
  assert.match(full[0].content, /pipes, redirection, curl \| bash/);
  assert.match(full[0].content, /run_code for real JavaScript\/Node, Python, PowerShell, or shell snippets/);
  assert.match(full[0].content, /install_package for real npm, pip, cargo, go, or gem installs/);
  assert.match(full[0].content, /run_tests for real npm, pytest, cargo, or custom test commands/);
  assert.match(full[0].content, /git_operation for real Git status/);
  assert.match(full[0].content, /browser_control for opening a real browser page/);
  assert.match(full[0].content, /database_query for reading or writing SQLite/);
  assert.match(full[0].content, /mcp_install_npm and mcp_uninstall for managed npm MCP servers/);
  assert.match(full[0].content, /mcp_list_tools and mcp_call for configured external MCP tools/);
  assert.match(full[0].content, /mcp_list_resources and mcp_read_resource for configured external MCP resources/);
  assert.match(full[0].content, /mcp_list_prompts and mcp_get_prompt for configured external MCP prompts/);
  assert.match(tool[0].content, /database_query for read-only SQLite SELECT queries/);
  assert.match(tool[0].content, /database_query write operations require full permission/);
  assert.match(tool[0].content, /extract_archive, execute_command, run_code, install_package, run_tests, git_operation, browser_control, mcp_install_npm, mcp_uninstall, mcp_list_tools, mcp_call, mcp_list_resources, mcp_read_resource, mcp_list_prompts, and mcp_get_prompt require full permission/);
  assert.doesNotMatch(tool[0].content, /extract_archive for zip files/);
  assert.doesNotMatch(tool[0].content, /execute_command for real shell commands/);
  assert.doesNotMatch(tool[0].content, /run_code for real/);
  assert.doesNotMatch(tool[0].content, /install_package for real/);
  assert.doesNotMatch(tool[0].content, /run_tests for real/);
  assert.doesNotMatch(tool[0].content, /git_operation for real Git/);
  assert.doesNotMatch(tool[0].content, /browser_control for opening/);
  assert.doesNotMatch(tool[0].content, /database_query for reading or writing/);
  assert.doesNotMatch(tool[0].content, /mcp_install_npm and mcp_uninstall/);
  assert.doesNotMatch(tool[0].content, /mcp_call for calling/);
  assert.doesNotMatch(tool[0].content, /mcp_read_resource for configured/);
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
