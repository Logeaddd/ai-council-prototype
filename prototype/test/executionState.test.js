import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advanceExecutionState, collaborationRequirementStatus, createExecutionState, executionInstruction, gateDeliveryRecoveryToolRequests, isDeliveryTask, selectExecutionAgents } from "../src/executionState.js";
import { markNativeModelSource } from "../src/nativeToolProvenance.js";

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

test("every non-empty task starts with one highest-permission intake owner", () => {
  const state = createExecutionState({ question: "Build a real project.", agents, workspaceGroup });
  assert.equal(state.active, true);
  assert.equal(state.executorId, "builder");
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
  assert.equal(state.phase, "intake");
  assert.match(executionInstruction(state, agents[1]), /Task intake owner/);
});

test("an explicit collaborative delivery request cannot be downgraded to a single-owner contract", () => {
  const pair = [
    { id: "owner", name: "Owner", enabled: true },
    { id: "contributor", name: "Contributor", enabled: true }
  ];
  const state = createExecutionState({
    question: "\u4f60\u4eec\u5408\u4f5c\u64b0\u5199\u62a5\u544a\u5e76\u5236\u4f5c PDF\u3002",
    agents: pair,
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", contributor: "text" } } },
    workMode: "collab"
  });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: pair } },
    agent: pair[0],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery", objective: "Create the requested PDF.", requires_workspace: true, requires_verification: true,
        deliverables: ["PDF"], completion_criteria: ["PDF exists"], next_action: "Draft the report.",
        collaboration: { required: false }
      }
    }
  });
  const collaboration = collaborationRequirementStatus(state);
  assert.equal(collaboration.required, true);
  assert.equal(collaboration.pending, true);
  assert.equal(state.taskContract.collaboration.beforeFirstMutation, true);
  assert.equal(state.ownership.delegations.length, 0);
  assert.equal(state.participation.participants[0].agentId, "contributor");
  assert.deepEqual(selectExecutionAgents(state, pair).map((agent) => agent.id), ["contributor"]);
  assert.match(executionInstruction(state, pair[1]), /Collaborative deliberation/);
});

test("system collaboration scheduling prefers an explicitly named enabled member", () => {
  const pair = [
    { id: "owner", name: "洪帝", enabled: true },
    { id: "dog", name: "狗", enabled: true },
    { id: "other", name: "其他成员", enabled: true }
  ];
  const state = createExecutionState({
    question: "你们合作写论文，狗必须参与讨论，讨论好了再制作 PDF。",
    agents: pair,
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full" } } },
    workMode: "collab"
  });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: pair } },
    agent: pair[0],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery", objective: "Collaboratively create the requested PDF.", requires_workspace: true, requires_verification: true,
        deliverables: ["PDF"], completion_criteria: ["PDF exists"], next_action: "Discuss, then create it.",
        collaboration: { required: true, before_first_mutation: false, minimum_delegations: 1 }
      }
    }
  });
  assert.equal(state.taskContract.collaboration.beforeFirstMutation, true);
  assert.deepEqual(selectExecutionAgents(state, pair).map((agent) => agent.id), ["dog", "other"]);
});

test("collab delivery collects attributable member input and then returns integration to the durable owner", () => {
  const owner = { id: "owner", name: "Owner", role: "Builder", enabled: true };
  const designer = { id: "designer", name: "Designer", role: "Designer", enabled: true };
  const state = createExecutionState({
    question: "Create the requested project.",
    agents: [owner, designer],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full" } } },
    workMode: "collab"
  });
  const session = { id: "session-collab", toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, designer] } };
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", task_contract: {
    mode: "delivery", objective: "Create the project.", requires_workspace: true, requires_verification: true, deliverables: ["project"], completion_criteria: ["Project exists.", "Tests pass."], next_action: "Design and implement the project."
  } } });

  assert.equal(state.phase, "deliberation");
  assert.deepEqual(selectExecutionAgents(state, [owner, designer]).map((agent) => agent.id), ["designer"]);
  assert.match(executionInstruction(state, designer), /Collaborative deliberation/);
  advanceExecutionState({ state, session, agent: designer, response: { status: "speak", argument: "Separate the parser from the CLI and test both boundaries." } });

  assert.equal(state.phase, "inspect");
  assert.equal(state.participation.ownerIntegrationStatus, "pending");
  assert.deepEqual(selectExecutionAgents(state, [owner, designer]).map((agent) => agent.id), ["owner"]);
  assert.match(executionInstruction(state, owner), /Separate the parser from the CLI/);
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", argument: "I integrated the separation into the execution plan." } });
  assert.equal(state.participation.ownerIntegrationStatus, "completed");
});

test("independent delivery collects isolated first passes before owner integration", () => {
  const owner = { id: "owner", name: "Owner", enabled: true };
  const analyst = { id: "analyst", name: "Analyst", enabled: true };
  const state = createExecutionState({
    question: "Create the requested comparison.",
    agents: [owner, analyst],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full" } } },
    workMode: "independent"
  });
  const session = { id: "session-independent", toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, analyst] } };
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", task_contract: {
    mode: "delivery", objective: "Create the comparison.", requires_workspace: true, requires_verification: true, deliverables: ["comparison"], completion_criteria: ["Comparison exists."], next_action: "Draft and verify it."
  } } });

  assert.deepEqual(selectExecutionAgents(state, [owner, analyst]).map((agent) => agent.id), ["analyst"]);
  assert.match(executionInstruction(state, analyst), /Independent first pass/);
  advanceExecutionState({ state, session, agent: analyst, response: { status: "speak", argument: "Compare operational cost and failure recovery separately." } });
  assert.equal(state.participation.ownerIntegrationStatus, "pending");
  assert.match(executionInstruction(state, owner), /Compare operational cost/);
});

test("explicit rerun and verification requests remain delivery work after recovery", () => {
  const english = "Run the current deliverable once more to verify its current state after recovery.";
  const chinese = "恢复后请运行当前产物并验证其当前状态。";
  assert.equal(isDeliveryTask(english), true);
  assert.equal(isDeliveryTask(chinese), true);
  const state = createExecutionState({ question: english, agents, workspaceGroup });
  assert.equal(state.active, true);
  assert.equal(state.executorId, "builder");
  assert.match(state.nextAction, /task contract/);
});

test("a semantic task contract, rather than task wording, activates delivery execution", () => {
  const state = createExecutionState({ question: "Сделай это и положи результат туда, где я попросил.", agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[1],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Produce the requested result.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["requested output"],
        completion_criteria: ["verify the output"],
        next_action: "Create the required workspace output."
      }
    }
  });
  assert.equal(state.active, true);
  assert.equal(state.phase, "inspect");
  assert.equal(state.taskContract.mode, "delivery");
  assert.equal(state.taskContract.requiresWorkspace, true);
  assert.equal(state.taskContract.source, "model_task_contract");
  const instruction = executionInstruction(state, agents[1]);
  assert.match(instruction, /Recorded task contract/);
  assert.match(instruction, /Produce the requested result/);
  assert.match(instruction, /requested output/);
  assert.match(instruction, /verify the output/);
});

test("an explicit Chinese PPT request cannot be downgraded to a non-workspace contract", () => {
  const question = "你们两谁更狗，讨论一下，做一个PPT出来";
  assert.equal(isDeliveryTask(question), true);
  const state = createExecutionState({ question, agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents } },
    agent: agents[1],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Discuss the topic.",
        requires_workspace: false,
        requires_verification: false,
        deliverables: ["debate notes"],
        completion_criteria: ["The discussion is complete."],
        next_action: "Discuss the topic."
      }
    }
  });

  assert.equal(state.taskContract.mode, "delivery");
  assert.equal(state.taskContract.requiresWorkspace, true);
  assert.equal(state.taskContract.requiresVerification, true);
  assert.equal(state.taskContract.artifacts.some((item) => item.extension === ".pptx"), true);
  assert.equal(state.artifactStatus, "not_checked");
  assert.notEqual(state.phase, "complete");
});

test("an explicit PPT request can create a durable contract even when the provider omits one", () => {
  const question = "做一个PPT出来";
  const state = createExecutionState({ question, agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents } },
    agent: agents[1],
    response: { status: "speak" }
  });

  assert.equal(state.taskContract.requiresWorkspace, true);
  assert.equal(state.taskContract.requiresVerification, true);
  assert.match(state.taskContract.nextAction, /Create and verify|deliverable/i);
});

test("a successful direct package install is acquisition evidence, never verification evidence", () => {
  const question = "做一个PPT出来";
  const state = createExecutionState({ question, agents, workspaceGroup });
  const session = {
    toolExecutionResults: [{
      id: "pip-install",
      tool: "execute_command",
      command: "python -m pip install python-pptx",
      reason: "Install the dependency and verify the environment.",
      status: "completed",
      result: { ok: true, exitCode: 0, command: "python -m pip install python-pptx" }
    }],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({ state, session, agent: agents[1], question });

  assert.equal(state.artifactStatus, "not_checked");
  assert.notEqual(state.phase, "review");
  assert.notEqual(state.phase, "complete");
  assert.equal(state.recovery.pendingCapabilities[0].acquisitionId, "pip-install");
  assert.match(state.lastAction, /capability_acquired/);
});

test("a complete provider contract survives equivalent object and scalar field shapes", () => {
  const state = createExecutionState({ question: "Create the requested report.", agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[1],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create the requested illustrated report.",
        requiresWorkspace: true,
        requiresVerification: true,
        deliverables: [{ path: "deliverables/report.pdf", requirements: "At least two pages." }],
        artifacts: [{ path: "deliverables/report.pdf", artifact_type: "generated_file", minimumPages: 2, requiresImages: true }],
        completionCriteria: "The report parses as a multi-page illustrated PDF.",
        nextAction: "Read the source material and generate the report."
      }
    }
  });

  assert.equal(state.phase, "inspect");
  assert.deepEqual(state.taskContract.deliverables, ["deliverables/report.pdf: At least two pages."]);
  assert.deepEqual(state.taskContract.completionCriteria, ["The report parses as a multi-page illustrated PDF."]);
  assert.deepEqual(state.taskContract.artifacts, [{
    path: "deliverables/report.pdf",
    extension: ".pdf",
    requiresImages: true,
    minimumPages: 2
  }]);
});

test("a required collaboration contract blocks material work until a real handoff is integrated", () => {
  const owner = { id: "owner", name: "Owner", enabled: true };
  const researcher = { id: "researcher", name: "Researcher", enabled: true };
  const state = createExecutionState({
    question: "Create the requested file, but first have another member research one fact and hand it back.",
    agents: [owner, researcher],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", researcher: "tool" } } }
  });
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, researcher] } };
  const contract = {
    mode: "delivery",
    objective: "Create the requested file using an independently researched fact.",
    requires_workspace: true,
    requires_verification: true,
    deliverables: ["shared/result.txt"],
    completion_criteria: ["Use the delegated fact.", "Run a real validation."],
    next_action: "Delegate the required fact research.",
    collaboration: { required: true, before_first_mutation: true, minimum_delegations: 1, types: ["research"], reason: "The user requires a researcher handoff." }
  };

  advanceExecutionState({ state, session, agent: owner, question: state.taskQuestion, response: { status: "speak", task_contract: contract } });
  assert.equal(collaborationRequirementStatus(state).pending, true);
  assert.match(executionInstruction(state, owner), /Collaboration required before completion/);
  session.toolExecutionResults.push({ id: "premature-verification", tool: "run_tests", status: "completed", result: { ok: true, exitCode: 0 } });
  advanceExecutionState({ state, session, agent: owner, question: state.taskQuestion, response: { status: "speak" } });
  assert.equal(state.phase, "repair");
  assert.equal(state.lastAction, "collaboration_prerequisite_pending");
  const blocked = gateDeliveryRecoveryToolRequests(state, owner, [{ tool: "workspace_edit", action: "write", path: "shared/result.txt", code: "premature" }]);
  assert.equal(blocked.accepted.length, 0);
  assert.equal(blocked.rejected[0].code, "collaboration_prerequisite_pending");
  assert.equal(gateDeliveryRecoveryToolRequests(state, owner, [{ tool: "delegate_task", delegationType: "research" }]).accepted.length, 1);

  const nativeDelegation = markNativeModelSource({
    type: "research", assignee_id: "researcher", task: "Find the required fact.", expected_evidence: ["Observed source fact"], allowed_tools: ["read_file"], allow_workspace_mutation: false
  });
  const nativeDelegationResponse = {
    status: "speak",
    task_delegations: [nativeDelegation]
  };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: nativeDelegationResponse
  });
  const delegation = state.ownership.delegations.find((item) => item.type === "research");
  assert.equal(delegation.native, true);
  session.toolExecutionResults.push(
    { id: "old-research", tool: "read_file", source_agent_id: "researcher", status: "completed", createdAt: new Date(Date.parse(delegation.createdAt) - 1_000).toISOString(), result: { ok: true, content: "STALE" } },
    { id: "research-read", tool: "read_file", source_agent_id: "researcher", status: "completed", createdAt: new Date(Date.parse(delegation.createdAt) + 1_000).toISOString(), result: { ok: true, content: "FACT" } }
  );
  advanceExecutionState({ state, session, agent: researcher, response: { status: "speak", delegation_handoff: { delegation_id: delegation.id, summary: "Found FACT.", evidence: ["read_file#research-read"] } } });
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", argument: "I will integrate the handoff." } });

  assert.equal(collaborationRequirementStatus(state).pending, false);
  assert.equal(delegation.ownerAcknowledged, true);
  assert.equal(delegation.handoffEvidence.some((item) => item.detail.includes("old-research")), false);
  assert.equal(gateDeliveryRecoveryToolRequests(state, owner, [{ tool: "workspace_edit", action: "write", path: "shared/result.txt", code: "FACT" }]).accepted.length, 1);
});

test("a bounded review delegation is scheduled as durable work before ordinary checkpoint review", () => {
  const owner = { id: "owner", name: "Owner", enabled: true };
  const reviewer = { id: "reviewer", name: "Reviewer", role: "Reviewer", enabled: true };
  const state = createExecutionState({
    question: "Create a release note after another member reviews the source.",
    agents: [owner, reviewer],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", reviewer: "tool" } } }
  });
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, reviewer] } };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create a reviewed release note.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["shared/release.txt"],
        completion_criteria: ["Use the review findings.", "Validate the release note."],
        next_action: "Delegate the source review.",
        collaboration: { required: true, before_first_mutation: true, minimum_delegations: 1, types: ["review"], reason: "A review handoff is required." }
      },
      task_delegations: [markNativeModelSource({
        type: "review",
        assignee_id: "reviewer",
        task: "Inspect shared/source.txt and report unsupported release claims.",
        expected_evidence: ["Read source evidence", "Review finding"],
        allowed_tools: ["read_file"],
        allow_workspace_mutation: false
      })]
    }
  });

  const delegation = state.ownership.delegations.find((item) => item.type === "review");
  assert.ok(delegation);
  assert.deepEqual(selectExecutionAgents(state, [owner, reviewer]).map((agent) => agent.id), ["reviewer"]);
  assert.match(executionInstruction(state, reviewer), /Delegated review work/);
  session.toolExecutionResults.push({
    id: "review-source",
    tool: "read_file",
    source_agent_id: "reviewer",
    status: "completed",
    createdAt: new Date(Date.parse(delegation.createdAt) + 1_000).toISOString(),
    result: { ok: true, content: "release=1.2" }
  });
  advanceExecutionState({
    state,
    session,
    agent: reviewer,
    response: { status: "speak", delegation_handoff: { delegation_id: delegation.id, summary: "One claim needs removal.", evidence: ["read_file#review-source"] } }
  });
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", argument: "I will correct the release note from the review." } });

  assert.equal(delegation.status, "completed");
  assert.equal(delegation.ownerAcknowledged, true);
  assert.equal(collaborationRequirementStatus(state).pending, false);
});

test("an unblocker can receive managed runtime authority without receiving workspace write authority", () => {
  const owner = { id: "owner", name: "Owner", enabled: true };
  const unblocker = { id: "unblocker", name: "Unblocker", enabled: true };
  const state = createExecutionState({
    question: "Create a report after the missing runtime is acquired.",
    agents: [owner, unblocker],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", unblocker: "full" } } }
  });
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, unblocker] } };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create the report after acquiring its missing runtime.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["shared/report.pdf"],
        completion_criteria: ["Use the acquired runtime.", "Verify the report."],
        next_action: "Delegate the runtime acquisition."
      },
      task_delegations: [markNativeModelSource({
        type: "unblocker",
        assignee_id: "unblocker",
        task: "Acquire the missing report runtime and return its verified command.",
        expected_evidence: ["Verified runtime command"],
        allowed_tools: ["provision_tool"],
        allow_workspace_mutation: false,
        allow_runtime_mutation: true
      })]
    }
  });

  const delegation = state.ownership.delegations.find((item) => item.type === "unblocker");
  assert.equal(delegation.allowRuntimeMutation, true);
  assert.equal(delegation.allowWorkspaceMutation, false);
  assert.match(executionInstruction(state, unblocker), /no workspace-mutation delegation/i);
  assert.match(executionInstruction(state, unblocker), /managed runtime, package, Skill, or MCP capability/i);
});

test("a delegation handoff cannot reuse evidence from before that delegation existed", () => {
  const owner = { id: "owner", name: "Owner", enabled: true };
  const researcher = { id: "researcher", name: "Researcher", enabled: true };
  const state = createExecutionState({
    question: "Create a document with one bounded research handoff.",
    agents: [owner, researcher],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", researcher: "tool" } } }
  });
  const session = {
    groupSnapshot: { agents: [owner, researcher] },
    toolExecutionResults: [{ id: "old-source", tool: "read_file", source_agent_id: "researcher", status: "completed", createdAt: "2020-01-01T00:00:00.000Z", result: { ok: true } }],
    fileOperationExecutionResults: []
  };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create the document.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["shared/output.txt"],
        completion_criteria: ["Use the delegated source.", "Verify the output."],
        next_action: "Delegate one source lookup."
      }
    }
  });
  const delegationRequest = markNativeModelSource({
    type: "research",
    assignee_id: "researcher",
    task: "Read the current source.",
    expected_evidence: ["Source fact"],
    allowed_tools: ["read_file"],
    allow_workspace_mutation: false
  });
  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", task_delegations: [delegationRequest] } });
  const delegation = state.ownership.delegations.find((item) => item.assigneeId === "researcher");
  advanceExecutionState({
    state,
    session,
    agent: researcher,
    response: {
      status: "speak",
      delegation_handoff: { delegation_id: delegation.id, summary: "The old result proves it.", evidence: ["read_file#old-source"] }
    }
  });

  assert.equal(delegation.status, "failed");
  assert.equal(delegation.result, "missing_current_delegation_evidence");
  assert.equal(delegation.handoffEvidence.some((item) => item.detail.includes("old-source")), true);
});

test("a discussion contract releases the normal group without pretending it is delivery", () => {
  const state = createExecutionState({ question: "この設計の長所と短所を説明してください。", agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[1],
    response: {
      status: "speak",
      task_contract: {
        mode: "discussion",
        objective: "Explain the design tradeoffs.",
        requires_workspace: false,
        requires_verification: false,
        deliverables: [],
        completion_criteria: ["answer the question"],
        next_action: "Discuss the tradeoffs."
      }
    }
  });
  assert.equal(state.active, false);
  assert.equal(state.phase, "discussion");
  assert.equal(state.taskContract.mode, "discussion");
});

test("a missing intake contract keeps the single owner in intake instead of releasing the group", () => {
  const state = createExecutionState({ question: "Create the requested result in the requested location.", agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[1],
    response: { status: "speak", argument: "I will investigate this request first." }
  });
  assert.equal(state.active, true);
  assert.equal(state.phase, "intake");
  assert.equal(state.executorId, "builder");
  assert.equal(state.taskContract, undefined);
  assert.equal(state.intakeAttempts, 1);
  assert.equal(state.lastAction, "task_contract_missing");
  assert.match(state.lastError, /without a valid task contract/i);
  assert.match(state.nextAction, /complete task_contract/i);
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
});

test("runtime prebuilds a non-blocking delivery contract and schedules collaborators immediately", () => {
  const state = createExecutionState({
    question: "Create the requested project.",
    agents,
    workspaceGroup,
    workMode: "collab",
    prebuildContract: true
  });

  assert.equal(state.taskContract.mode, "delivery");
  assert.match(state.taskContract.source, /deterministic_request_default/);
  assert.equal(state.phase, "deliberation");
  assert.notDeepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), [state.executorId]);
});

test("runtime prebuilds a discussion contract without requiring intake", () => {
  const state = createExecutionState({
    question: "Explain the tradeoffs without changing files.",
    agents,
    workspaceGroup,
    workMode: "collab",
    prebuildContract: true
  });

  assert.equal(state.taskContract.mode, "discussion");
  assert.equal(state.phase, "discussion");
  assert.equal(state.active, false);
});

test("an incomplete task contract is not enough to release intake ownership", () => {
  const state = createExecutionState({ question: "Do the requested task.", agents, workspaceGroup });
  advanceExecutionState({
    state,
    session: { toolExecutionResults: [], fileOperationExecutionResults: [] },
    agent: agents[1],
    response: { status: "speak", task_contract: { mode: "delivery", objective: "Do it." } }
  });
  assert.equal(state.active, true);
  assert.equal(state.phase, "intake");
  assert.equal(state.intakeAttempts, 1);
  assert.equal(state.taskContract, undefined);
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
  assert.equal(state.repair.requiredMaterialChange, true);
  assert.equal(state.repair.checkpointVersion, 2);
  assert.match(state.lastError, /integration test/);
  assert.match(executionInstruction(state, agents[1]), /Blocking repair gate/);
  assert.deepEqual(selectExecutionAgents(state, agents).map((agent) => agent.id), ["builder"]);
});

test("a blocking review rejects unchanged verification until the owner records a real repair", () => {
  const state = createExecutionState({ question: "Update and validate the current JSON artifact.", agents, workspaceGroup });
  state.phase = "review";
  state.checkpointVersion = 4;
  state.artifactStatus = "not_requested";
  const session = {
    toolExecutionResults: [],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };

  advanceExecutionState({
    state,
    session,
    agent: agents[2],
    response: {
      status: "speak",
      objection_items: [{ id: "wrong-status", issue: "The artifact is still draft instead of review.", blocks_final: true, in_scope: true }]
    }
  });

  session.toolExecutionResults.push({
    id: "unchanged-json-parse",
    tool: "run_code",
    reason: "Validate the current JSON artifact.",
    status: "completed",
    result: { ok: true, exitCode: 0, verificationIntent: true }
  });
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });

  assert.equal(state.phase, "repair");
  assert.equal(state.checkpointVersion, 4);
  assert.equal(state.repair.requiredMaterialChange, true);
  assert.equal(state.repair.unproductiveVerificationAttempts, 1);
  assert.equal(state.lastAction, "repair_verification_without_material_change");
  assert.match(state.nextAction, /Do not create another review checkpoint/);

  session.toolExecutionResults.push(
    {
      id: "status-repair",
      tool: "workspace_edit",
      status: "completed",
      result: { ok: true, workspaceChanges: { totalChanges: 1, modified: [{ path: "deliverables/brief.json" }] } }
    },
    {
      id: "status-review-verified",
      tool: "run_code",
      reason: "Validate the repaired JSON artifact.",
      status: "completed",
      result: { ok: true, exitCode: 0, verificationIntent: true }
    }
  );
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion });

  assert.equal(state.phase, "repair");
  assert.equal(state.checkpointVersion, 5);
  assert.equal(state.repair.requiredMaterialChange, false);
  assert.equal(state.repair.unproductiveVerificationAttempts, 0);
  assert.equal(state.lastAction, "verification_passed:status-review-verified");
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

test("an explicit continuation reopens a completed checkpoint without drifting its durable finalizer", () => {
  const priorAgents = [
    { id: "builder", name: "Builder", role: "Builder", enabled: true },
    { id: "critic", name: "Critic", role: "Critic", enabled: true },
    { id: "judge", name: "Judge", role: "Finalizer", judge: true, enabled: true }
  ];
  const previousState = createExecutionState({ question: "Create the shared artifact.", agents: priorAgents, workspaceGroup, workMode: "collab" });
  previousState.phase = "complete";
  previousState.checkpointVersion = 5;
  previousState.reviewedCheckpointVersion = 5;
  previousState.finalizerId = "judge";
  previousState.artifactStatus = "verified";
  const mutatedAgents = [
    { id: "critic", name: "Critic", role: "Summarizer", judge: true, enabled: true },
    { id: "builder", name: "Builder", role: "Builder", enabled: true },
    { id: "judge", name: "Judge", role: "Finalizer", judge: true, enabled: true }
  ];

  const resumed = createExecutionState({
    question: "continue",
    agents: mutatedAgents,
    workspaceGroup,
    workMode: "collab",
    previousState,
    resumeCompleted: true
  });

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.phase, "inspect");
  assert.equal(resumed.finalizerId, "judge");
  assert.equal(resumed.executorId, "builder");
  assert.equal(resumed.artifactStatus, "not_checked");
  assert.equal(resumed.lastAction, "resumed_completed_checkpoint");
  assert.match(resumed.nextAction, /durable owner or finalizer/);
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

test("delivery ownership transfers explicitly when the previous owner is unavailable on resume", () => {
  const initial = createExecutionState({
    question: "Create a PDF report.",
    agents: [{ id: "builder", name: "Builder", role: "Builder", enabled: true }],
    workspaceGroup
  });
  const resumed = createExecutionState({
    question: "Continue the current requested file.",
    agents: [{ id: "replacement", name: "Replacement", role: "Builder", enabled: true }],
    workspaceGroup: {
      permissions: { defaultTier: "text", seatTiers: { replacement: "full" } }
    },
    previousState: initial
  });

  assert.equal(resumed.executorId, "replacement");
  assert.equal(resumed.ownership.ownerId, "replacement");
  assert.equal(resumed.ownership.version, 2);
  assert.deepEqual(resumed.ownership.transfers[0], {
    fromId: "builder",
    fromName: "Builder",
    toId: "replacement",
    toName: "Replacement",
    reason: "previous_owner_unavailable_during_resume",
    version: 2
  });
});

test("checkpoint reviews are durable delegated work and complete only after every assigned reviewer responds", () => {
  const executor = { id: "builder", name: "Builder", role: "Builder", enabled: true };
  const reviewerA = { id: "reviewer-a", name: "Reviewer A", role: "Red Team", mandatoryRedTeam: true, enabled: true };
  const reviewerB = { id: "reviewer-b", name: "Reviewer B", role: "Red Team", mandatoryRedTeam: true, enabled: true };
  const state = createExecutionState({
    question: "Create a PDF report.",
    agents: [executor, reviewerA, reviewerB],
    workspaceGroup: {
      permissions: { defaultTier: "text", seatTiers: { builder: "full", "reviewer-a": "tool", "reviewer-b": "tool" } }
    }
  });
  state.phase = "review";
  state.checkpointVersion = 1;
  state.artifactStatus = "verified";

  const selected = selectExecutionAgents(state, [executor, reviewerA, reviewerB]);
  assert.deepEqual(selected.map((agent) => agent.id), ["reviewer-a", "reviewer-b"]);
  assert.equal(state.ownership.delegations.filter((item) => item.status === "pending").length, 2);
  assert.match(executionInstruction(state, reviewerA), /Delegated checkpoint review/);

  advanceExecutionState({
    state,
    session: { groupSnapshot: { agents: [executor, reviewerA, reviewerB] } },
    agent: reviewerA,
    response: { status: "speak", objection_items: [] }
  });
  assert.equal(state.phase, "review");
  assert.equal(state.ownership.delegations.find((item) => item.assigneeId === "reviewer-a").status, "completed");

  advanceExecutionState({
    state,
    session: { groupSnapshot: { agents: [executor, reviewerA, reviewerB] } },
    agent: reviewerB,
    response: { status: "speak", objection_items: [] }
  });
  assert.equal(state.phase, "complete");
  assert.equal(state.reviewedCheckpointVersion, 1);
});

test("checkpoint review failures become explicit terminal outcomes instead of pending forever", () => {
  const executor = { id: "builder", name: "Builder", role: "Builder", enabled: true };
  const reviewer = { id: "reviewer", name: "Reviewer", role: "Red Team", mandatoryRedTeam: true, enabled: true };
  const state = createExecutionState({
    question: "Create and verify a report.",
    agents: [executor, reviewer],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { builder: "full", reviewer: "tool" } } }
  });
  state.phase = "review";
  state.checkpointVersion = 1;
  state.artifactStatus = "verified";
  selectExecutionAgents(state, [executor, reviewer]);

  advanceExecutionState({
    state,
    session: { groupSnapshot: { agents: [executor, reviewer] } },
    agent: reviewer,
    response: { status: "timed_out", reason: "provider deadline", objection_items: [] }
  });

  const delegation = state.ownership.delegations.find((item) => item.assigneeId === reviewer.id);
  assert.equal(delegation.status, "timed_out");
  assert.equal(state.phase, "complete");
  assert.match(state.lastError, /ended timed_out/);
  assert.match(state.nextAction, /non-passing outcome/);
  assert.deepEqual(selectExecutionAgents(state, [executor, reviewer]), []);
});

test("delivery owner delegates bounded work, receives a durable handoff, and remains the only final executor", () => {
  const owner = { id: "owner", name: "Owner", role: "Builder", enabled: true };
  const researcher = { id: "researcher", name: "Researcher", role: "Research", enabled: true };
  const state = createExecutionState({
    question: "Create and verify the requested document.",
    agents: [owner, researcher],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", researcher: "full" } } }
  });
  const session = { groupSnapshot: { agents: [owner, researcher] }, toolExecutionResults: [], fileOperationExecutionResults: [] };

  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create and verify the requested document.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["shared/document.txt"],
        completion_criteria: ["The document is written.", "A local check verifies it."],
        next_action: "Collect one source fact before writing the document."
      },
      task_delegations: [{
        type: "research",
        assignee_id: "researcher",
        task: "Find the one required source fact.",
        expected_evidence: ["Source URL", "The fact to use"],
        allowed_tools: ["web_search"],
        allow_workspace_mutation: false
      }]
    }
  });

  const delegation = state.ownership.delegations.find((item) => item.type === "research");
  assert.ok(delegation);
  assert.deepEqual(selectExecutionAgents(state, [owner, researcher]).map((agent) => agent.id), ["researcher"]);
  assert.match(executionInstruction(state, researcher), /Find the one required source fact/);
  assert.match(executionInstruction(state, researcher), /no workspace-mutation delegation/);

  session.toolExecutionResults.push({
    id: "delegated-source-read",
    tool: "web_search",
    source_agent_id: "researcher",
    status: "completed",
    createdAt: new Date(Date.parse(delegation.createdAt) + 1_000).toISOString(),
    result: { ok: true }
  });

  advanceExecutionState({
    state,
    session,
    agent: researcher,
    response: {
      status: "speak",
      delegation_handoff: {
        delegation_id: delegation.id,
        summary: "The source confirms the required fact.",
        evidence: ["https://example.test/source", "Required fact: verified"]
      }
    }
  });
  assert.equal(delegation.status, "completed");
  assert.equal(delegation.ownerAcknowledged, false);
  assert.deepEqual(selectExecutionAgents(state, [owner, researcher]).map((agent) => agent.id), ["owner"]);

  advanceExecutionState({ state, session, agent: owner, response: { status: "speak", argument: "I will use the returned source fact." } });
  assert.equal(delegation.ownerAcknowledged, true);
  assert.match(executionInstruction(state, owner), /Durable delegated handoffs/);
  assert.equal(state.executorId, "owner");
});

test("read-only delegations cannot advertise tools that their permission scope will always reject", () => {
  const owner = { id: "owner", name: "Owner", role: "Builder", enabled: true };
  const reviewer = { id: "reviewer", name: "Reviewer", role: "Reviewer", enabled: true };
  const state = createExecutionState({
    question: "Create and review an artifact.",
    agents: [owner, reviewer],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { owner: "full", reviewer: "tool" } } }
  });
  state.phase = "inspect";
  state.taskContract = {
    mode: "delivery",
    objective: "Create and review an artifact.",
    requiresWorkspace: true,
    requiresVerification: true,
    deliverables: ["artifact.json"],
    completionCriteria: ["A reviewer inspects it."],
    nextAction: "Delegate review."
  };
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, reviewer] } };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_delegations: [{
        type: "review",
        assignee_id: "reviewer",
        task: "Inspect the artifact without mutating it.",
        expected_evidence: ["Read evidence"],
        allowed_tools: ["read_file", "execute_command", "run_code", "workspace_edit", "install_package"],
        allow_workspace_mutation: false,
        allow_runtime_mutation: false
      }]
    }
  });

  const delegation = state.ownership.delegations.find((item) => item.assigneeId === "reviewer");
  assert.deepEqual(delegation.allowedTools, ["read_file"]);
  assert.match(executionInstruction(state, reviewer), /Allowed tools: read_file/);
  assert.doesNotMatch(executionInstruction(state, reviewer), /execute_command|run_code|workspace_edit|install_package/);
});

test("delegation assignees resolve from a unique current display name after member mutation", () => {
  const owner = { id: "builder", name: "Builder 0731", role: "Builder", enabled: true };
  const critic = { id: "critic", name: "Critic", role: "Reviewer", enabled: true, judge: true };
  const state = createExecutionState({
    question: "Continue the collaborative review.",
    agents: [owner, critic],
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { builder: "full", critic: "tool" } } }
  });
  state.phase = "inspect";
  state.taskContract = {
    mode: "delivery",
    objective: "Continue the collaborative review.",
    requiresWorkspace: true,
    requiresVerification: true,
    deliverables: ["artifact.json"],
    completionCriteria: ["The current reviewer contributes."],
    nextAction: "Delegate the review."
  };
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: [owner, critic] } };
  advanceExecutionState({
    state,
    session,
    agent: owner,
    response: {
      status: "speak",
      task_delegations: [{
        type: "review",
        assignee_id: "Critic",
        task: "Inspect the current artifact.",
        expected_evidence: ["Read evidence"],
        allowed_tools: ["read_file"]
      }]
    }
  });

  const delegation = state.ownership.delegations.find((item) => item.type === "review");
  assert.equal(delegation.assigneeId, "critic");
  assert.equal(delegation.status, "pending");
  assert.deepEqual(selectExecutionAgents(state, [owner, critic]).map((agent) => agent.id), ["critic"]);
});

test("a durable finalizer does not drift when another member becomes judge and the seats are reordered", () => {
  const initialAgents = [
    { id: "builder", name: "Builder", role: "Builder", enabled: true },
    { id: "critic", name: "Critic", role: "Critic", enabled: true, mandatoryRedTeam: true },
    { id: "judge", name: "Judge", role: "Finalizer", enabled: true, judge: true }
  ];
  const state = createExecutionState({
    question: "Work together to update the artifact.",
    agents: initialAgents,
    workspaceGroup: { permissions: { defaultTier: "text", seatTiers: { builder: "full" } } },
    workMode: "collab"
  });
  const mutatedAndReorderedAgents = [
    { id: "critic", name: "Critic", role: "Summarizer", enabled: true, judge: true },
    { id: "builder", name: "Builder 0731", role: "Builder", enabled: true },
    { id: "judge", name: "Judge", role: "Finalizer", enabled: true, judge: true }
  ];
  const session = { toolExecutionResults: [], fileOperationExecutionResults: [], groupSnapshot: { agents: mutatedAndReorderedAgents } };
  advanceExecutionState({
    state,
    session,
    agent: mutatedAndReorderedAgents[1],
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Update the artifact collaboratively.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["artifact.json"],
        completion_criteria: ["A non-owner contribution is integrated."],
        next_action: "Collect a contribution, then update the artifact."
      }
    }
  });

  assert.equal(state.executorId, "builder");
  assert.equal(state.finalizerId, "judge");
  assert.deepEqual(state.participation.participants.map((item) => item.agentId), ["critic"]);
  assert.deepEqual(selectExecutionAgents(state, mutatedAndReorderedAgents).map((agent) => agent.id), ["critic"]);
  assert.equal(state.participation.participants.some((item) => item.agentId === "judge"), false);
});

test("delivery recovery persists failed acquisition strategies, blocks exact retries, and requires real use after an alternative succeeds", () => {
  const state = createExecutionState({ question: "Create the requested project artifact.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };
  const contract = {
    mode: "delivery",
    objective: "Create the requested project artifact.",
    requires_workspace: true,
    requires_verification: true,
    deliverables: ["shared/out/result.txt"],
    completion_criteria: ["Run a real validation."],
    next_action: "Create the project artifact."
  };
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion, response: { status: "speak", task_contract: contract } });

  session.toolExecutionResults.push({
    id: "failed-first-manager",
    tool: "install_package",
    manager: "first-manager",
    packageName: "chosen-package",
    status: "failed",
    error: "first manager is unavailable",
    result: { ok: false, manager: "first-manager", packageName: "chosen-package", error: "first manager is unavailable" }
  });
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion, response: { status: "speak" } });

  assert.equal(state.phase, "repair");
  assert.equal(state.recovery.failures.length, 1);
  assert.match(executionInstruction(state, agents[1]), /Failed strategy/);
  const firstGate = gateDeliveryRecoveryToolRequests(state, agents[1], [
    { tool: "install_package", manager: "first-manager", packageName: "chosen-package" },
    { tool: "install_package", manager: "npm", packageName: "chosen-package" }
  ]);
  assert.equal(firstGate.rejected.length, 1);
  assert.equal(firstGate.rejected[0].code, "recovery_strategy_repeated");
  assert.deepEqual(firstGate.accepted.map((item) => item.manager), ["npm"]);

  session.toolExecutionResults.push({
    id: "installed-alternative",
    tool: "install_package",
    manager: "npm",
    packageName: "chosen-package",
    status: "completed",
    result: { ok: true, manager: "npm", packageName: "chosen-package" }
  });
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion, response: { status: "speak" } });

  assert.equal(state.recovery.failures[0].resolvedBy, "installed-alternative");
  assert.deepEqual(state.recovery.pendingCapabilities.map((item) => item.acquisitionId), ["installed-alternative"]);
  assert.match(executionInstruction(state, agents[1]), /Acquired but not yet used/);
  const pendingGate = gateDeliveryRecoveryToolRequests(state, agents[1], [
    { tool: "web_search", query: "another package instead" },
    { tool: "workspace_edit", action: "write", path: "shared/out/app.js", code: "require('chosen-package');" },
    { tool: "run_code", language: "node", code: "require('chosen-package');" }
  ]);
  assert.equal(pendingGate.rejected[0].code, "acquired_capability_must_be_used");
  assert.deepEqual(pendingGate.accepted.map((item) => item.tool), ["workspace_edit", "run_code"]);

  session.toolExecutionResults.push({
    id: "use-installed-package",
    tool: "run_code",
    status: "completed",
    result: { ok: true, exitCode: 0 },
    capabilityUsage: [{ acquisitionId: "installed-alternative", acquisitionTool: "install_package", kind: "installed_package", references: ["chosen-package"] }]
  });
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion, response: { status: "speak" } });

  assert.equal(state.recovery.pendingCapabilities.length, 0);
  assert.equal(state.recovery.usage[0].usedBy, "use-installed-package");
  const resumed = createExecutionState({ question: "continue", agents, workspaceGroup, previousState: state });
  assert.equal(resumed.recovery.failures[0].fingerprint, state.recovery.failures[0].fingerprint);
  assert.equal(gateDeliveryRecoveryToolRequests(resumed, agents[1], [{ tool: "install_package", manager: "first-manager", packageName: "chosen-package" }]).rejected[0].code, "recovery_strategy_repeated");
});

test("failed Skill reads survive collaborator turns and block the same nonexistent Skill retry", () => {
  const state = createExecutionState({ question: "Create the requested report.", agents, workspaceGroup });
  const session = {
    toolExecutionResults: [],
    fileOperationExecutionResults: [],
    groupSnapshot: { agents }
  };
  advanceExecutionState({
    state,
    session,
    agent: agents[1],
    question: state.taskQuestion,
    response: {
      status: "speak",
      task_contract: {
        mode: "delivery",
        objective: "Create the requested report.",
        requires_workspace: true,
        requires_verification: true,
        deliverables: ["report.pdf"],
        completion_criteria: ["The report exists and passes validation."],
        next_action: "Create and validate the report."
      }
    }
  });
  session.toolExecutionResults.push({
    id: "missing-skill-read",
    tool: "skill_read",
    skillId: "missing-document-skill",
    status: "failed",
    error: "Skill not found",
    result: { ok: false, skillId: "missing-document-skill", error: "Skill not found" }
  });
  advanceExecutionState({ state, session, agent: agents[1], question: state.taskQuestion, response: { status: "speak" } });

  assert.match(executionInstruction(state, agents[1]), /Failed strategy \(do not repeat unchanged\): skill instructions for missing-document-skill/);
  const gate = gateDeliveryRecoveryToolRequests(state, agents[1], [
    { tool: "skill_read", skillId: "missing-document-skill" },
    { tool: "skill_list" },
    { tool: "workspace_edit", action: "write", path: "report.pdf", code: "%PDF-1.4" }
  ]);
  assert.equal(gate.rejected.length, 1);
  assert.equal(gate.rejected[0].code, "recovery_strategy_repeated");
  assert.deepEqual(gate.accepted.map((item) => item.tool), ["skill_list", "workspace_edit"]);
});
