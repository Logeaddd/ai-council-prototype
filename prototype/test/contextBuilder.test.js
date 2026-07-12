import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPromptSections, buildMemberContext } from "../src/contextBuilder.js";

const agent = {
  id: "critic",
  name: "Critic",
  role: "Red Team",
  instructions: "Find concrete risks.",
  mandatoryRedTeam: true,
  providerLimits: {
    contextWindow: 12000,
    maxOutputTokens: 1000
  },
  tokenLimits: {
    maxInputTokensPerCall: 8000
  }
};

test("member context preserves non-compressible core for red team", () => {
  const context = buildMemberContext(agent, {
    question: "Build a todo helper.",
    unresolvedObjections: {
      critic: ["Rounding behavior is unclear."]
    },
    artifacts: [
      { id: "old", round: 1, type: "code", title: "todo.js", content: "old" },
      { id: "new", round: 2, type: "code", title: "todo.js", content: "new" }
    ],
    messages: [
      { round: 1, agentName: "Builder", response: { status: "speak", argument: "Initial code." } },
      { round: 2, agentName: "Critic", response: { status: "speak", argument: "Risk found." } }
    ]
  }, {
    latestBossInstruction: "Keep risks visible.",
    executionStandard: "Use tests.",
    verificationStandard: "Run assertions.",
    globalRequirement: "Be concise.",
    memberShortSummary: "Critic tracks edge cases.",
    groupSharedSummary: "The helper is nearly complete."
  });

  assert.equal(context.mandatoryRedTeam, true);
  assert.equal(context.core.originalQuestion, "Build a todo helper.");
  assert.equal(context.core.latestBossInstruction, "Keep risks visible.");
  assert.deepEqual(context.core.unresolvedObjections.critic, ["Rounding behavior is unclear."]);
  assert.equal(context.core.latestArtifacts.length, 1);
  assert.equal(context.core.latestArtifacts[0].content, "new");
  assert.equal(context.providerCacheBreakpoint, "after_original_question");
});

test("member context flags non-compressible core overflow", () => {
  const tightAgent = {
    ...agent,
    providerLimits: {
      contextWindow: 120,
      maxOutputTokens: 50
    },
    tokenLimits: {
      maxInputTokensPerCall: 60
    }
  };
  const context = buildMemberContext(tightAgent, {
    question: "这是一个非常长的老板问题，用来触发不可压缩核心超过小模型上下文限制。",
    unresolvedObjections: { critic: ["必须保留这个异议，不能压缩掉。"] },
    artifacts: [{ round: 1, type: "code", title: "artifact.js", content: "export const value = 1;" }],
    messages: []
  });

  assert.equal(context.coreOverflow, true);
  assert.ok(context.tokenEstimate.nonCompressibleCore > context.limits.effectiveInputLimit);
});

test("context prompt sections keep stable and core before transcript", () => {
  const context = buildMemberContext(agent, {
    question: "Question",
    unresolvedObjections: {},
    artifacts: [],
    messages: [
      { round: 1, agentName: "A", response: { status: "speak", argument: "one" } },
      { round: 2, agentName: "B", response: { status: "unavailable", reason: "429" } }
    ]
  });
  const sections = buildContextPromptSections(context);

  assert.deepEqual(sections.map((section) => section.title), [
    "Stable context",
    "Non-compressible core",
    "Recent transcript"
  ]);
  assert.match(sections[1].content, /Original question: Question/);
  assert.match(sections[2].content, /unavailable: 429/);
});

test("member context marks stale reviewer history as overridden for ordinary members", () => {
  const context = buildMemberContext({
    id: "seat_01",
    name: "Former Reviewer",
    role: "code reviewer",
    reviewer: false,
    mandatoryRedTeam: false
  }, {
    question: "Question",
    unresolvedObjections: {},
    artifacts: [],
    messages: [
      {
        round: 1,
        agentId: "seat_01",
        agentName: "Former Reviewer",
        response: {
          status: "speak",
          argument: "Earlier I claimed I was a reviewer."
        }
      }
    ]
  });
  const stable = buildContextPromptSections(context).find((section) => section.title === "Stable context")?.content || "";

  assert.equal(context.stable.roleIdentity, "Former Reviewer");
  assert.match(stable, /Current assignment: ordinary member/);
  assert.match(stable, /old role text claiming reviewer status is stale/);
  assert.doesNotMatch(stable, /Role: code reviewer/);
});

test("member context trims transcript before protected artifacts and objections", () => {
  const tightAgent = {
    ...agent,
    providerLimits: {
      contextWindow: 2200,
      maxOutputTokens: 200
    },
    tokenLimits: {
      maxInputTokensPerCall: 1800,
      compressionThreshold: 0.45
    }
  };
  const context = buildMemberContext(tightAgent, {
    question: "Implement the latest plan.",
    unresolvedObjections: {
      critic: ["The final code still needs a boundary test."]
    },
    artifacts: [
      { id: "latest-code", round: 4, type: "code", title: "answer.js", content: "export function answer() { return 42; }" }
    ],
    messages: Array.from({ length: 12 }, (_, index) => ({
      round: index + 1,
      agentName: index % 2 ? "Builder" : "Critic",
      response: {
        status: "speak",
        argument: `Verbose historical transcript item-${index + 1}: ${"details ".repeat(80)}`
      }
    }))
  }, {
    recentMessageLimit: 12,
    groupSharedSummary: "Earlier history has been summarized."
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";
  const transcript = sections.find((section) => section.title === "Recent transcript")?.content || "";

  assert.equal(context.compression.applied, true);
  assert.ok(context.compression.droppedRecentMessages > 0);
  assert.match(core, /latest-code/);
  assert.match(core, /boundary test/);
  assert.doesNotMatch(transcript, /item-1:/);
});

test("member context uses group recent message limit", () => {
  const context = buildMemberContext(agent, {
    question: "No recent transcript by setting.",
    unresolvedObjections: {},
    artifacts: [],
    messages: [
      { round: 1, agentName: "Builder", response: { status: "speak", argument: "SHOULD_NOT_BE_INCLUDED" } }
    ]
  }, {
    groupSettings: {
      recentMessageLimit: 0
    }
  });
  const sections = buildContextPromptSections(context);

  assert.equal(context.recentTranscript.length, 0);
  assert.equal(sections.some((section) => section.title === "Recent transcript"), false);
});

test("context prompt sections include file operation execution results", () => {
  const context = buildMemberContext(agent, {
    question: "Continue after file execution.",
    unresolvedObjections: {},
    artifacts: [],
    fileOperationExecutionResults: [
      {
        proposalId: "fop_1",
        path: "src/auto-created.js",
        op: "write",
        status: "executed",
        commitHash: "abc1234"
      },
      {
        proposalId: "fop_2",
        path: "src/risky.js",
        op: "write",
        status: "skipped_policy",
        reason: "overwrite_requires_confirmation"
      }
    ],
    messages: []
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /File operation execution results/);
  assert.match(core, /src\/auto-created\.js/);
  assert.match(core, /abc1234/);
  assert.match(core, /overwrite_requires_confirmation/);
});

test("context prompt sections keep only the latest repeated file operation result", () => {
  const context = buildMemberContext(agent, {
    question: "Continue after reading files.",
    unresolvedObjections: {},
    artifacts: [],
    fileOperationExecutionResults: [
      {
        op: "read",
        path: "forge_mod/build.gradle",
        status: "completed",
        source_agent_id: "critic",
        content: "OLD_BUILD_GRADLE_SHOULD_DROP"
      },
      {
        op: "read",
        path: "forge_mod/build.gradle",
        status: "completed",
        source_agent_id: "critic",
        content: "LATEST_BUILD_GRADLE_SHOULD_STAY"
      }
    ],
    messages: []
  });
  const core = buildContextPromptSections(context).find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /LATEST_BUILD_GRADLE_SHOULD_STAY/);
  assert.doesNotMatch(core, /OLD_BUILD_GRADLE_SHOULD_DROP/);
  assert.equal(context.core.fileOperationExecutionResults.length, 1);
});

test("context prompt sections compact large file operation results", () => {
  const largeRead = `${"F".repeat(12000)}FILE_TAIL_FACT`;
  const context = buildMemberContext(agent, {
    question: "Use read file output.",
    unresolvedObjections: {},
    artifacts: [],
    fileOperationExecutionResults: [
      {
        op: "read",
        path: "forge_mod/src/main/java/ExampleMod.java",
        status: "completed",
        source_agent_id: "critic",
        content: largeRead
      }
    ],
    messages: []
  });
  const core = buildContextPromptSections(context).find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /tool output truncated/);
  assert.match(core, /FILE_TAIL_FACT/);
  assert.ok(core.length < largeRead.length);
});

test("context prompt sections include web tool execution results", () => {
  const context = buildMemberContext(agent, {
    question: "Check current sources.",
    unresolvedObjections: {},
    artifacts: [],
    toolExecutionResults: [
      {
        id: "tool_1",
        tool: "web_search",
        status: "completed",
        query: "AI Council",
        result: { ok: true, results: [{ title: "AI Council", url: "https://example.com" }] },
        source_agent_id: "critic",
        source_agent_name: "Critic"
      }
    ],
    messages: []
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /Tool execution results/);
  assert.match(core, /AI Council/);
  assert.match(core, /https:\/\/example\.com/);
});

test("context prompt sections compact large tool outputs", () => {
  const largeStdout = `${"A".repeat(12000)}TAIL_FACT`;
  const context = buildMemberContext(agent, {
    question: "Use command output.",
    unresolvedObjections: {},
    artifacts: [],
    toolExecutionResults: [
      {
        tool: "execute_command",
        status: "completed",
        source_agent_id: "critic",
        source_agent_name: "Critic",
        result: {
          command: "dir /s",
          stdout: largeStdout,
          stderr: ""
        }
      }
    ],
    messages: []
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /tool output truncated/);
  assert.match(core, /TAIL_FACT/);
  assert.ok(core.length < largeStdout.length);
});

test("execution evidence uses one dynamic budget without mutating complete stored results", () => {
  const storedToolResults = Array.from({ length: 12 }, (_, index) => ({
    id: `tool_${index}`,
    tool: index === 10 || index === 11 ? "execute_command" : "read_file",
    status: index === 10 ? "failed" : "completed",
    code: index === 10 ? "command_exit_nonzero" : undefined,
    source_agent_id: "builder",
    source_agent_name: "Builder",
    round: 1,
    path: index < 10 ? `src/file-${index}.txt` : undefined,
    command: index >= 10 ? `build-tool attempt-${index}` : undefined,
    query: "",
    url: "",
    result: index < 10
      ? { ok: true, path: `src/file-${index}.txt`, content: `FILE_${index}_HEAD ${"detail ".repeat(1800)} FILE_${index}_TAIL` }
      : {
          ok: index === 11,
          command: `build-tool attempt-${index}`,
          exitCode: index === 10 ? 1 : 0,
          stdout: index === 11 ? `BUILD_SUCCESS_FACT ${"build detail ".repeat(1200)}` : "",
          stderr: index === 10 ? `BUILD_FAILURE_FACT ${"failure detail ".repeat(1200)}` : ""
        }
  }));
  const storedSnapshot = JSON.stringify(storedToolResults);
  const context = buildMemberContext({
    ...agent,
    id: "finalizer",
    name: "Finalizer",
    role: "Finalizer",
    mandatoryRedTeam: false,
    providerLimits: { contextWindow: 9000, maxOutputTokens: 1000 },
    tokenLimits: { maxInputTokensPerCall: 8000 }
  }, {
    question: "Synthesize verified execution evidence.",
    unresolvedObjections: {},
    artifacts: [],
    toolExecutionResults: storedToolResults,
    messages: []
  });
  const core = buildContextPromptSections(context).find((section) => section.title === "Non-compressible core")?.content || "";

  assert.equal(JSON.stringify(storedToolResults), storedSnapshot);
  assert.equal(context.coreOverflow, false);
  assert.equal(context.executionEvidenceCompression.originalCount, 12);
  assert.ok(context.executionEvidenceCompression.keptCount < 12);
  assert.ok(context.executionEvidenceCompression.omittedCount > 0);
  assert.ok(context.executionEvidenceCompression.shortenedCount > 0);
  assert.ok(context.executionEvidenceCompression.estimatedTokens <= context.executionEvidenceCompression.maxTokens);
  assert.match(core, /Execution evidence pack/);
  assert.match(core, /Complete raw results remain in session storage/);
  assert.match(core, /BUILD_SUCCESS_FACT/);
  assert.match(core, /BUILD_FAILURE_FACT/);
  assert.match(core, /command_exit_nonzero/);
  assert.doesNotMatch(core, /"query":""/);
  assert.doesNotMatch(core, /"url":""/);
});

test("context prompt sections keep only the latest repeated tool result", () => {
  const context = buildMemberContext(agent, {
    question: "Use the latest file read.",
    unresolvedObjections: {},
    artifacts: [],
    toolExecutionResults: [
      {
        tool: "read_file",
        status: "completed",
        source_agent_id: "critic",
        source_agent_name: "Critic",
        path: "build.gradle",
        result: { content: "OLD_BUILD_CONTENT_SHOULD_DROP" }
      },
      {
        tool: "read_file",
        status: "completed",
        source_agent_id: "critic",
        source_agent_name: "Critic",
        path: "build.gradle",
        result: { content: "LATEST_BUILD_CONTENT_SHOULD_STAY" }
      }
    ],
    messages: []
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /LATEST_BUILD_CONTENT_SHOULD_STAY/);
  assert.doesNotMatch(core, /OLD_BUILD_CONTENT_SHOULD_DROP/);
  assert.equal(context.core.toolExecutionResults.length, 1);
});

test("context prompt sections include rejected tool request reasons", () => {
  const context = buildMemberContext(agent, {
    question: "Use tools only when allowed.",
    unresolvedObjections: {},
    artifacts: [],
    rejectedToolRequests: [
      {
        id: "tool_rejected_1",
        tool: "execute_command",
        status: "rejected",
        code: "permission_denied",
        error: "execute_command requires full permission.",
        source_agent_id: "critic",
        source_agent_name: "Critic"
      }
    ],
    messages: []
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.match(core, /Rejected tool requests/);
  assert.match(core, /execute_command/);
  assert.match(core, /permission_denied/);
  assert.match(core, /requires full permission/);
});

test("context prompt sections include user attached text files in protected core", () => {
  const context = buildMemberContext(agent, {
    question: "Review attached project notes.",
    unresolvedObjections: {},
    artifacts: [],
    messages: [
      { round: 1, agentName: "Builder", response: { status: "speak", argument: "old transcript" } }
    ]
  }, {
    attachments: [
      {
        name: "PROJECT_NOTES.md",
        type: "text/markdown",
        sizeBytes: 42,
        content: "ATTACHMENT_SECRET: context plan goes here."
      }
    ]
  });
  const sections = buildContextPromptSections(context);
  const core = sections.find((section) => section.title === "Non-compressible core")?.content || "";

  assert.equal(context.core.attachedFiles.length, 1);
  assert.match(core, /User attached files/);
  assert.match(core, /PROJECT_NOTES\.md/);
  assert.match(core, /ATTACHMENT_SECRET/);
});

test("independent member context hides other ordinary members' answers", () => {
  const context = buildMemberContext({
    ...agent,
    id: "alpha",
    name: "Alpha",
    mandatoryRedTeam: false
  }, {
    question: "Answer independently.",
    unresolvedObjections: {
      beta: ["BETA_LEDGER_SECRET"],
      alpha: ["ALPHA_LEDGER_SECRET"]
    },
    artifacts: [
      { id: "a1", round: 1, type: "note", source_agent_id: "alpha", content: "ALPHA_ARTIFACT_SECRET" },
      { id: "b1", round: 1, type: "note", source_agent_id: "beta", content: "BETA_ARTIFACT_SECRET" }
    ],
    messages: [
      { round: 1, agentId: "alpha", agentName: "Alpha", response: { status: "speak", argument: "ALPHA_MESSAGE_SECRET" } },
      { round: 1, agentId: "beta", agentName: "Beta", response: { status: "speak", argument: "BETA_MESSAGE_SECRET" } }
    ],
    fileOperationExecutionResults: [
      { source_agent_id: "alpha", path: "alpha.js", status: "executed" },
      { source_agent_id: "beta", path: "beta.js", status: "executed" }
    ],
    toolExecutionResults: [
      { source_agent_id: "alpha", tool: "web_search", result: { results: [{ title: "ALPHA_TOOL_SECRET" }] } },
      { source_agent_id: "beta", tool: "web_search", result: { results: [{ title: "BETA_TOOL_SECRET" }] } }
    ],
    rejectedToolRequests: [
      { source_agent_id: "alpha", tool: "execute_command", error: "ALPHA_REJECTED_TOOL_SECRET" },
      { source_agent_id: "beta", tool: "execute_command", error: "BETA_REJECTED_TOOL_SECRET" }
    ]
  }, {
    transcriptVisibility: "own",
    recentMessageLimit: 10
  });
  const sections = buildContextPromptSections(context);
  const combined = sections.map((section) => section.content).join("\n");

  assert.equal(context.transcriptVisibility, "own");
  assert.match(combined, /ALPHA_MESSAGE_SECRET/);
  assert.match(combined, /ALPHA_ARTIFACT_SECRET/);
  assert.match(combined, /ALPHA_LEDGER_SECRET/);
  assert.match(combined, /alpha\.js/);
  assert.match(combined, /ALPHA_TOOL_SECRET/);
  assert.match(combined, /ALPHA_REJECTED_TOOL_SECRET/);
  assert.doesNotMatch(combined, /BETA_MESSAGE_SECRET/);
  assert.doesNotMatch(combined, /BETA_ARTIFACT_SECRET/);
  assert.doesNotMatch(combined, /BETA_LEDGER_SECRET/);
  assert.doesNotMatch(combined, /beta\.js/);
  assert.doesNotMatch(combined, /BETA_TOOL_SECRET/);
  assert.doesNotMatch(combined, /BETA_REJECTED_TOOL_SECRET/);
});


test("context prompt sections include private boss messages for the addressed member", () => {
  const context = buildMemberContext(agent, {
    question: "Use private instruction.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    privateBossMessages: [
      {
        createdAt: "2026-06-21T10:00:00.000Z",
        text: "\u53ea\u7ed9\u8fd9\u4e2a\u6210\u5458\u770b\u7684\u8865\u5145\u8981\u6c42\u3002"
      }
    ]
  });
  const sections = buildContextPromptSections(context);
  const privateSection = sections.find((section) => section.title === "Private boss messages")?.content || "";

  assert.match(privateSection, /Private from boss to you/);
  assert.match(privateSection, /\u53ea\u7ed9\u8fd9\u4e2a\u6210\u5458\u770b\u7684\u8865\u5145\u8981\u6c42/);
});

test("context prompt sections include cycle continuation memory", () => {
  const context = buildMemberContext(agent, {
    question: "Continue with the next revision.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    continuationContext: {
      previousSessionId: "session_prev",
      previousQuestion: "Design the first version.",
      finalState: "usable_with_risks",
      finalAnswer: "Use the simpler API shape.",
      summary: "Builder proposed API v1; reviewer kept timeout risk visible.",
      blockingIssues: [{ id: "risk-1", issue: "Timeout policy still ambiguous." }],
      risks: ["Latency could spike."],
      nextActions: ["Define timeout defaults."],
      sourcePath: "sessions/session_prev.json",
      previousStatus: "running",
      participantMessages: [{ round: 2, agentName: "Builder", status: "speak", text: "BUILDER_LATEST_CONTEXT" }],
      recentMessages: [{ round: 2, agentName: "Reviewer", status: "speak", text: "REVIEWER_RECENT_CONTEXT" }],
      recentActivity: ["tool: run_tests status=completed"]
    }
  });
  const sections = buildContextPromptSections(context);
  const continuation = sections.find((section) => section.title === "Cycle continuation")?.content || "";

  assert.match(continuation, /Previous session: session_prev/);
  assert.match(continuation, /Previous final state: usable_with_risks/);
  assert.match(continuation, /Use the simpler API shape/);
  assert.match(continuation, /Timeout policy still ambiguous/);
  assert.match(continuation, /Define timeout defaults/);
  assert.match(continuation, /sessions\/session_prev\.json/);
  assert.match(continuation, /BUILDER_LATEST_CONTEXT/);
  assert.match(continuation, /REVIEWER_RECENT_CONTEXT/);
  assert.match(continuation, /run_tests status=completed/);
  assert.match(continuation, /load_context with sessionId=session_prev/);
});

test("context prompt sections expose enabled skill metadata without loading skill instructions", () => {
  const context = buildMemberContext(agent, {
    question: "Use a relevant skill.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    enabledSkills: "Enabled skill packs (metadata only):\n- code-agent: 代码助手 - 工程任务\nUse skill_read for full instructions."
  });
  const section = buildContextPromptSections(context).find((item) => item.title === "Enabled skills")?.content || "";

  assert.match(section, /code-agent/);
  assert.match(section, /skill_read/);
  assert.doesNotMatch(section, /FULL_SKILL_BODY_SHOULD_NOT_LOAD/);
  assert.ok(context.tokenEstimate.summaries > 0);
});

test("context prompt sections include retrieved archive snippets with source pointers", () => {
  const context = buildMemberContext(agent, {
    question: "Use the saved archive.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    retrievedContext: [
      {
        source: "local_context_archive",
        sourceType: "round_summary",
        sessionId: "session_archive_1",
        round: 2,
        question: "Earlier archive question",
        finalState: "ready_to_execute",
        snippet: "ARCHIVE_SNIPPET_FACT",
        sourcePath: "sessions/session_archive_1/round_2_summary.json",
        score: 17
      }
    ]
  });
  const sections = buildContextPromptSections(context);
  const archived = sections.find((section) => section.title === "Relevant archived context")?.content || "";

  assert.match(archived, /local keyword search/);
  assert.match(archived, /session=session_archive_1 round=2/);
  assert.match(archived, /ARCHIVE_SNIPPET_FACT/);
  assert.match(archived, /round_2_summary\.json/);
});

test("context prompt sections expose a bounded public group history catalogue", () => {
  const context = buildMemberContext(agent, {
    question: "Continue prior work.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    historyCatalogue: [{
      sessionId: "session_prior_work_1",
      question: "Build the Minecraft artifact.",
      roundCount: 12,
      finalState: "needs_revision",
      completedAt: "2026-07-08T10:00:00.000Z"
    }]
  });
  const catalogue = buildContextPromptSections(context).find((section) => section.title === "Group history catalogue")?.content || "";

  assert.match(catalogue, /session=session_prior_work_1/);
  assert.match(catalogue, /Build the Minecraft artifact/);
  assert.match(catalogue, /load_context/);
});

test("context prompt sections include a rebuildable recent public event cache with exact pointers", () => {
  const context = buildMemberContext(agent, {
    question: "Continue retained work.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    publicEventHotCache: {
      sourceJournalPath: "shared/memory/events/public-events.jsonl",
      events: [{
        eventId: "session_1:message:0",
        sequence: 7,
        type: "member_message",
        actorName: "Builder",
        status: "speak",
        occurredAt: "2026-07-12T10:00:00.000Z",
        text: "HOT_CACHE_PUBLIC_FACT",
        sourcePath: "shared/memory/events/public-events.jsonl#event=session_1:message:0"
      }]
    }
  });
  const section = buildContextPromptSections(context).find((item) => item.title === "Recent public activity cache")?.content || "";
  assert.match(section, /HOT_CACHE_PUBLIC_FACT/);
  assert.match(section, /session_1:message:0/);
  assert.match(section, /load_context with eventId/);
});

test("retrieved archive context is budgeted and keeps load pointers", () => {
  const context = buildMemberContext(agent, {
    question: "Use compact archive context.",
    unresolvedObjections: {},
    artifacts: [],
    messages: []
  }, {
    groupSettings: {
      contextArchiveInjectionLimit: 4,
      contextArchiveInjectionTokens: 180
    },
    retrievedContext: [
      {
        sourceType: "round_summary",
        sessionId: "session_budget_1",
        round: 2,
        question: "Budgeted archive question",
        finalState: "ready_to_execute",
        snippet: `HIGH_VALUE_ARCHIVE_SNIPPET ${"important detail ".repeat(200)}`,
        sourcePath: "sessions/session_budget_1/round_2_summary.json",
        score: 100,
        completedAt: "2026-07-08T10:00:00.000Z"
      },
      {
        sourceType: "round_summary",
        sessionId: "session_budget_1",
        round: 2,
        question: "Duplicate should be removed",
        snippet: "DUPLICATE_SHOULD_NOT_APPEAR",
        sourcePath: "sessions/session_budget_1/round_2_summary.json",
        score: 100
      },
      {
        sourceType: "session_final",
        sessionId: "session_budget_2",
        question: "Lower score archive question",
        snippet: `LOW_VALUE_ARCHIVE_SNIPPET ${"less useful ".repeat(200)}`,
        sourcePath: "sessions/session_budget_2.json",
        score: 1
      }
    ]
  });
  const archived = buildContextPromptSections(context).find((section) => section.title === "Relevant archived context")?.content || "";

  assert.equal(context.archiveContextCompression.applied, true);
  assert.equal(context.archiveContextCompression.dedupedCount, 2);
  assert.equal(context.archiveContextCompression.keptCount, 1);
  assert.equal(context.archiveContextCompression.droppedCount, 1);
  assert.match(archived, /request load_context with sessionId and optional round/);
  assert.match(archived, /session=session_budget_1 round=2/);
  assert.match(archived, /Source path: sessions\/session_budget_1\/round_2_summary\.json/);
  assert.match(archived, /HIGH_VALUE_ARCHIVE_SNIPPET/);
  assert.doesNotMatch(archived, /DUPLICATE_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(archived, /LOW_VALUE_ARCHIVE_SNIPPET/);
});
