import test from "node:test";
import assert from "node:assert/strict";
import { parseFinalDecision, parseRoundModelResult, parseRoundResponse } from "../src/responseParser.js";

test("round response parser preserves structured artifacts", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "speak",
    position: "done",
    argument: "Implemented the helper.",
    objections: [],
    suggested_revision: "Use the artifact as the canonical code.",
    artifacts: [
      {
        type: "code",
        title: "todoStats.js",
        content: "export function buildTodoStats(todos) { return {}; }"
      },
      {
        type: "note",
        content: "Review edge cases."
      },
      {
        type: "empty",
        content: ""
      }
    ],
    confidence: 0.8,
    memory_candidates: []
  }));

  assert.equal(parsed.status, "speak");
  assert.deepEqual(parsed.artifacts, [
    {
      type: "code",
      title: "todoStats.js",
      content: "export function buildTodoStats(todos) { return {}; }"
    },
    {
      type: "note",
      title: undefined,
      content: "Review edge cases."
    }
  ]);
});

test("round response parser preserves file operation proposals without executing them", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "speak",
    argument: "I propose a file change.",
    file_operations: [
      {
        op: "write",
        path: "src/output.js",
        content: "export const ok = true;",
        reason: "Implement the requested module.",
        expected_effect: "Module exists for later approval."
      }
    ]
  }));

  assert.equal(parsed.file_operations.length, 1);
  assert.equal(parsed.file_operations[0].op, "write");
  assert.equal(parsed.file_operations[0].path, "src/output.js");
});

test("round response parser normalizes a semantic task contract", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "speak",
    argument: "I will carry out the requested work.",
    task_contract: {
      mode: "delivery",
      objective: "Create the requested local output.",
      requiresWorkspace: true,
      requires_verification: true,
      deliverables: ["shared/result.txt", "", 7],
      completionCriteria: ["file exists", "content is verified"],
      nextAction: "Write the file and run the check."
    }
  }));

  assert.deepEqual(parsed.task_contract, {
    mode: "delivery",
    objective: "Create the requested local output.",
    requires_workspace: true,
    requires_verification: true,
    deliverables: ["shared/result.txt"],
    completion_criteria: ["file exists", "content is verified"],
    next_action: "Write the file and run the check."
  });
});

test("round response parser preserves unavailable status", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "unavailable",
    reason: "rate_limited",
    retryable: true
  }));

  assert.deepEqual(parsed, {
    status: "unavailable",
    reason: "rate_limited",
    retryable: true
  });
});

test("round response parser does not truncate tool requests above eight", () => {
  const toolRequests = Array.from({ length: 12 }, (_, index) => ({
    tool: "read_file",
    path: `file-${index + 1}.txt`,
    reason: `Read file ${index + 1}.`
  }));
  const parsed = parseRoundResponse(JSON.stringify({
    status: "speak",
    argument: "Inspect all files.",
    tool_requests: toolRequests,
    objections: []
  }));

  assert.equal(parsed.tool_requests.length, 12);
  assert.equal(parsed.tool_requests.at(-1).path, "file-12.txt");
});

test("native tool calls remain actionable even when the provider returns no JSON text", () => {
  const parsed = parseRoundModelResult("", [{
    id: "call_1",
    name: "ai_council_tool",
    arguments: JSON.stringify({ tool: "read_file", path: "README.md", reason: "Inspect" })
  }]);
  assert.equal(parsed.status, "speak");
  assert.equal(parsed.tool_requests[0].tool, "read_file");
  assert.equal(parsed.tool_requests[0].path, "README.md");
});

test("round response parser does not treat non-json provider output as a normal speech", () => {
  const parsed = parseRoundResponse("用户洪:我的2 question question 0: 0: 0");

  assert.equal(parsed.status, "unavailable");
  assert.equal(parsed.retryable, true);
  assert.match(parsed.reason, /invalid_json_response/);
  assert.match(parsed.reason, /question question/);
});

test("round response parser preserves structured objection items and resolved ids", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "speak",
    argument: "Review note.",
    objection_items: [
      {
        id: "risk-1",
        issue: "Budget reserve can leak.",
        severity: "major",
        blocks_final: true,
        in_scope: true,
        why: "Budget reliability is required.",
        suggested_fix: "Add timeout release."
      }
    ],
    resolved_ids: ["old-risk"]
  }));

  assert.equal(parsed.objection_items[0].id, "risk-1");
  assert.equal(parsed.objection_items[0].blocks_final, true);
  assert.deepEqual(parsed.resolved_ids, ["old-risk"]);
});

test("round response parser preserves resolved ids on skip", () => {
  const parsed = parseRoundResponse(JSON.stringify({
    status: "skip",
    reason: "Earlier blocker is fixed.",
    resolved_ids: ["risk-1"],
    memory_candidates: ["私は検証可能な証拠を好みます。"]
  }));

  assert.equal(parsed.status, "skip");
  assert.deepEqual(parsed.resolved_ids, ["risk-1"]);
  assert.deepEqual(parsed.memory_candidates, ["私は検証可能な証拠を好みます。"]);
});

test("final parser rejects skip as the final answer", () => {
  const fallback = {
    answer: "Fallback final summary.",
    consensus_score: 1,
    minority_report: "No minority report."
  };
  const parsed = parseFinalDecision(JSON.stringify({
    answer: "skip",
    consensus_score: 1,
    supporting_agents: ["Judge"],
    dissenting_agents: [],
    minority_report: "",
    risks: [],
    next_actions: [],
    memory_candidates: []
  }), fallback);

  assert.equal(parsed.answer, "Fallback final summary.");
});

test("final parser preserves final state compatibility fields", () => {
  const fallback = {
    answer: "Fallback.",
    consensus_score: 0,
    minority_report: "Fallback minority."
  };
  const parsed = parseFinalDecision(JSON.stringify({
    answer: "Done.",
    consensus_score: 1,
    final_state: "ready_to_execute",
    blocking_issues: [
      {
        id: "risk-1",
        issue: "Still blocked.",
        severity: "blocker",
        blocks_final: true,
        in_scope: true
      }
    ],
    unresolved_risks: []
  }), fallback);

  assert.equal(parsed.final_state, "ready_to_execute");
  assert.equal(parsed.blocking_issues[0].id, "risk-1");
});
test("final parser preserves selected file operation ids", () => {
  const fallback = {
    answer: "Fallback.",
    consensus_score: 0,
    minority_report: "Fallback minority."
  };
  const parsed = parseFinalDecision(JSON.stringify({
    answer: "Execute selected proposal.",
    consensus_score: 1,
    supporting_agents: ["Judge"],
    dissenting_agents: [],
    minority_report: "None.",
    risks: [],
    next_actions: [],
    selected_file_operation_ids: ["fop_1", "", 42, "fop_2"],
    memory_candidates: []
  }), fallback);

  assert.deepEqual(parsed.selected_file_operation_ids, ["fop_1", "fop_2"]);
});
test("final parser leaves absent selected file operation ids undefined", () => {
  const fallback = {
    answer: "Fallback.",
    consensus_score: 0,
    minority_report: "Fallback minority."
  };
  const parsed = parseFinalDecision(JSON.stringify({
    answer: "No file selection field from legacy judge.",
    consensus_score: 1,
    supporting_agents: ["Judge"],
    dissenting_agents: [],
    minority_report: "None.",
    risks: [],
    next_actions: [],
    memory_candidates: []
  }), fallback);

  assert.equal(parsed.selected_file_operation_ids, undefined);
});

test("final parser preserves structured deliverable claims and evidence ids", () => {
  const parsed = parseFinalDecision(JSON.stringify({
    answer: "Built the artifact.",
    consensus_score: 1,
    supporting_agents: ["Builder"],
    dissenting_agents: [],
    minority_report: "None.",
    risks: [],
    next_actions: [],
    deliverables: [
      { path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build"] }
    ],
    memory_candidates: []
  }), { answer: "Fallback.", consensus_score: 0, minority_report: "Fallback." });

  assert.deepEqual(parsed.deliverables, [
    { path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build"] }
  ]);
});
