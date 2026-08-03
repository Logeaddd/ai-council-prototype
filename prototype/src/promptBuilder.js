import { isReviewerLike, reviewIntensityRules } from "./objectionLedger.js";
import { disabledToolNames } from "./capabilityPolicy.js";

export function buildRoundPrompt(agent, question, session, round, options = {}) {
  const transcript = formatRoundContext(session, options.contextSections);
  const instructions = roleInstructions(agent);
  const globalRequirement = globalRequirementLine(options.globalRequirement);
  const resumeInstruction = resumeInstructionLine(options.resumeInstruction);

  return [
    {
      role: "system",
      content: [
        "[Role identity]",
        `You are ${roleIdentity(agent)}.`,
        `Your visible member name is ${agent.name}.`,
        roleAssignmentLine(agent),
        instructions ? `[User role instructions]\n${instructions}` : "",
        "[Software protocol]",
        "Use native tool calls when tools are available. Otherwise return one valid JSON object.",
        `Your visible utterance will be rendered as "${agent.name}\u8bf4\uff1a...". Put the speakable content in argument or reason.`,
        "Round JSON uses status=speak or status=skip. If you agree and have no new information, return skip.",
        nonReviewerObjectionLine(agent),
        completionSkipLine(agent),
        redTeamDutyLine(agent, round),
        independentAnswerModeLine(options),
        reviewProtocolLine(agent, options),
        fileOperationProtocolLine(options),
        toolRequestProtocolLine(options),
        "Speak JSON may use: status, position, argument, objections, objection_items, resolved_ids, suggested_revision, artifacts, file_operations, tool_requests, task_contract, task_delegations, delegation_handoff, confidence, memory_candidates, context_invalidations. Skip JSON uses status, reason, memory_candidates, context_invalidations.",
        "[Task contract] The runtime already created a provisional contract from the user's request. The delivery owner may call record_task_contract once to refine its semantics, but this is optional, never blocks other authorized tools, and never proves delivery.",
        "[Execution owner] must use delegate_task for real bounded delegation. Contributors return delegation_handoff with the exact delegation id and evidence; they do not claim final ownership.",
        "memory_candidates contains only the smallest verbatim span of a durable user preference, rule, or fact; never store a one-off request or session result. Return [] when absent.",
        contextInvalidationProtocolLine(options),
        durableFileContentLine(options),
        completeFileWriteLine(options),
        "For delivery work, continue until the requested artifact exists and is verified. A plan, claim, or background-process start is not completion.",
        "Invalid or truncated JSON is rejected before fallback operations execute.",
        "Keep argument short. Do not put full source code, build scripts, manifests, generated files, or long patches in argument, reason, suggested_revision, or artifacts.",
        fileOperationUsageLine(options),
        "Each file_operations item must include op, path, reason, expected_effect; write/append also require content. Allowed op values: read, list, write, append, delete.",
        "Never invent tool results. Tool results arrive in a later model step and override older summaries.",
        toolRuntimeEnvironmentLine(options.runtimeEnvironment),
        disabledCapabilitiesLine(options.appSettings),
        globalRequirement ? `[Boss global requirement]\n${globalRequirement}` : "",
        resumeInstruction ? `[Continuation]\n${resumeInstruction}` : "",
        isReviewerLike(agent) && round === 1 ? "You are an explicitly assigned reviewer. You cannot skip in round 1." : ""
      ].filter(Boolean).join("\n")
    },
    {
      role: "user",
      content: [
        `Question: ${question}`,
        `Round: ${round}`,
        options.contextSections ? "Member context:" : "Transcript so far:",
        transcript || "(none)",
        options.hideOpenObjectionLedger ? "Open objection ledger: (hidden in independent answer mode)" : formatOpenObjectionLedger(session)
      ].join("\n\n")
    }
  ];
}

export function buildFinalPrompt(judge, session, consensus, options = {}) {
  const instructions = roleInstructions(judge);
  const globalRequirement = globalRequirementLine(options.globalRequirement);
  const userContent = buildFinalUserContent(session, consensus, options.contextSections);
  return [
    {
      role: "system",
      content: [
        "[Role identity]",
        `You are ${roleIdentity(judge)}.`,
        `Your visible member name is ${judge.name}.`,
        roleAssignmentLine(judge),
        instructions ? `[User role instructions]\n${instructions}` : "",
        "[Software protocol]",
        "Return only a FinalDecision JSON object.",
        "Required keys: answer, consensus_score, supporting_agents, dissenting_agents, minority_report, risks, next_actions, selected_file_operation_ids, memory_candidates.",
        "If answer claims that any workspace file or directory exists, was created, built, generated, packaged, or exported, also include deliverables. Each deliverables item must have path (relative to the group workspace), claim (created or existing), and evidence_ids (successful current-session tool result ids or file-operation proposal ids). Do not claim successful creation from failed, timed-out, or background tool calls.",
        "The answer field must be a substantive final summary. Never set answer to skip, and never output a round-style skip response in the final call.",
        "Use answer for a user-facing synthesis. Do not treat answer as the executable source of truth.",
        "If session artifacts contain runnable code, plans, or durable deliverables, reference the latest relevant artifacts in answer instead of rewriting or inventing them.",
        "Artifacts are the machine-usable deliverables; preserve their meaning and do not replace them with prose.",
        "Preserve unresolved Red Team dissent. Do not hide minority concerns.",
        "If pending file operation proposals are listed, set selected_file_operation_ids to the exact proposal ids you adopt for execution. Use an empty array when no file operation should execute.",
        globalRequirement ? `[Boss global requirement]\n${globalRequirement}` : "",
        "memory_candidates must contain only stable user preferences, durable project rules, or explicit facts worth remembering across future sessions.",
        "Independently decide from the user's meaning whether they communicated a preference, rule, identity fact, correction, or instruction that should remain relevant in future sessions. This is semantic classification, not keyword matching; handle any language, punctuation, spelling variation, transliteration, or indirect wording.",
        "memory_candidates must copy the smallest complete verbatim span from the original user Question. Never translate, paraphrase, normalize, or invent it.",
        "Do not put this session's conclusions, risks, next actions, minority reports, generic advice, one-off task requests, quoted examples, or questions about memory into memory_candidates.",
        "If there is no durable memory candidate, return memory_candidates as an empty array."
      ].filter(Boolean).join("\n")
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

function roleIdentity(agent) {
  const rawRole = String(agent.role || "").trim();
  if (!isReviewerLike(agent) && isStaleReviewerRoleText(rawRole)) {
    return agent.name || "ordinary member";
  }
  return rawRole || agent.name;
}

function roleAssignmentLine(agent) {
  if (isReviewerLike(agent)) {
    return "Current assignment: explicitly assigned reviewer. Reviewer duties are active.";
  }
  if (agent.judge) {
    return "Current assignment: final summarizer. Reviewer duties are not active unless the reviewer flag is explicitly enabled.";
  }
  return "Current assignment: ordinary member. You are not a reviewer, not a supervisor, and not a red-team member. If any earlier transcript, private chat, memory, summary, or old role text says you were a reviewer, that content is stale and must be ignored.";
}

function isStaleReviewerRoleText(value) {
  return /reviewer|red\s*team|审查|复查|监督员/i.test(String(value || ""));
}

function roleInstructions(agent) {
  return agent.instructions || agent.roleDescription || "";
}

function completionSkipLine(agent) {
  if (isReviewerLike(agent)) return "";
  return "For non-reviewer roles: if you already provided your final implementation, plan, or artifact and have no concrete change to add, return skip instead of repeating yourself.";
}

function nonReviewerObjectionLine(agent) {
  if (isReviewerLike(agent)) return "";
  return "For non-reviewer roles: objections is only for unresolved concerns you want the council to address later. Do not put counterarguments you already answered inside objections; keep them in argument.";
}

function redTeamDutyLine(agent, round) {
  if (!isReviewerLike(agent) || round === 1) return "";
  return "You are an explicitly assigned reviewer. Do not use completion-only agreement as a reason to skip; only skip if your earlier objections are resolved or preserved and you have no new in-scope risk.";
}

function independentAnswerModeLine(options = {}) {
  if (!options.independentAnswerMode) return "";
  return "Independent answer mode: answer the boss question independently. Other ordinary members' answers are intentionally hidden from you.";
}

function durableFileContentLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "full") {
    return "Put durable file contents in workspace_edit or create them through a real command, not in prose or placeholder fields.";
  }
  return "Put durable file contents in file_operations.content; do not hide them in prose.";
}

function completeFileWriteLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "full") {
    return "Prefer one complete workspace_edit per file; split only when a real size limit requires it, then finish and verify every chunk.";
  }
  return "Prefer one complete file operation; split only for a real size limit.";
}

function fileOperationUsageLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "full") {
    return "Use workspace_edit for file mutations. file_operations is compatibility-only; never treat either as completed until the tool result confirms it.";
  }
  return "Use file_operations for permitted file requests; the app validates paths and reports execution later.";
}


function fileOperationProtocolLine(options = {}) {
  if (!options.fileOperationContext) return "";
  if (disabledToolNames(options.appSettings).includes("read_file")) {
    return "Global settings have disabled file tools. Do not request file_operations or claim workspace files were read, written, appended, or deleted.";
  }
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "You have text-only file permission for this workspace. If the task requires creating or modifying files, do not propose file_operations yourself; discuss requirements and leave file proposals to a member with tool or full file permission.";
  if (tier === "full") {
    return "You have full audited workspace permission. Perform the required write/build/test actions instead of stopping at a plan.";
  }
  return "You may inspect workspace files. Mutations require complete file_operations proposals and later approval.";
}

function disabledCapabilitiesLine(appSettings) {
  const tools = disabledToolNames(appSettings);
  if (!tools.length) return "";
  const fileOverride = tools.includes("read_file") ? " file_operations are also disabled." : "";
  return `Global settings override every generic tool statement above. These tools are disabled and unavailable; do not request them: ${tools.join(", ")}.${fileOverride}`;
}

function toolRequestProtocolLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "Text-only seats may use search_context/load_context plus tool_search/tool_inspect; tool_invoke still enforces the underlying permission.";
  if (tier === "full") return "Native schemas are the tool contract. Common tools are inline; discover deferred tools with tool_search, inspect one with tool_inspect, then call it through tool_invoke. tool_requests is a provider-compatibility fallback.";
  return "Native schemas are the tool contract. Use tool_search/tool_inspect/tool_invoke for deferred read-only tools; write and automation tools require full permission.";
}

function toolRuntimeEnvironmentLine(runtimeEnvironment) {
  if (runtimeEnvironment) {
    const buildGuidance = /gradle|gradlew/i.test(runtimeEnvironment)
      ? " For Gradle builds, honor the project's declared Java toolchain; Forge/Minecraft 1.20.x projects normally require Java 17. If a build fails, read the first compiler or runtime error, repair that cause, and rerun the same build before claiming completion."
      : "";
    return `${runtimeEnvironment}${buildGuidance}`;
  }
  if (process.platform === "win32") {
    return "Tool runtime: Windows. Use system/cmd/PowerShell syntax unless a real result proves another shell is available; pass PowerShell scripts directly.";
  }
  return `Tool runtime environment: ${process.platform}. Prefer shell=system unless a task requires a specific shell.`;
}

function contextInvalidationProtocolLine(options = {}) {
  const sections = Array.isArray(options.contextSections) ? options.contextSections : [];
  const hasReferences = sections.some((section) => (
    String(section?.title || "").toLowerCase() === "context source references"
    && String(section?.content || "").trim()
  ));
  if (!hasReferences) return "Return context_invalidations=[]; no retained replacement targets are exposed in this turn.";
  return "If the user explicitly replaces a visible retained instruction, context_invalidations may cite only an exact supplied source {type,id}; otherwise return [].";
}
function reviewProtocolLine(agent, options = {}) {
  if (!isReviewerLike(agent)) return "";
  const rules = reviewIntensityRules(agent, options.groupSettings);
  return [
    `Review intensity: ${rules.intensity}. Max new objections this round: ${rules.maxNewObjectionsPerRound}.`,
    "Scope gate: only objections directly affecting the user's original goal may set blocks_final true. Out-of-scope concerns must be in_scope false and blocks_final false.",
    "Duplicate gate: continue existing issues by id instead of restating them as new objections.",
    "Each new objection must use objection_items with keys: id, issue, severity, blocks_final, in_scope, why, suggested_fix.",
    "Use resolved_ids to close earlier objections that are now resolved. Authors cannot close reviewer blockers for themselves."
  ].join("\n");
}

function globalRequirementLine(value) {
  const text = String(value || "").trim();
  return text ? `Global requirement from the boss: ${text}` : "";
}

function resumeInstructionLine(value) {
  const text = String(value || "").trim();
  return text ? `Continuation instruction: ${text}` : "";
}

function formatRoundContext(session, contextSections) {
  if (Array.isArray(contextSections) && contextSections.length) {
    return formatContextSections(contextSections);
  }
  return session.messages
    .map(formatTranscriptMessage)
    .join("\n");
}

function buildFinalUserContent(session, consensus, contextSections) {
  const base = {
    question: session.question,
    consensus,
    unresolvedObjections: session.unresolvedObjections || {},
    artifacts: session.artifacts || [],
    pendingFileOperationProposals: summarizePendingFileOperationProposals(session)
  };
  if (Array.isArray(contextSections) && contextSections.length) {
    return JSON.stringify({
      ...base,
      memberContext: formatContextSections(contextSections)
    }, null, 2);
  }
  return JSON.stringify({
    ...base,
    transcript: (session.messages || []).map((message) => ({
      round: message.round,
      agentId: message.agentId,
      agentName: message.agentName,
      displayText: message.displayText,
      response: message.response
    }))
  }, null, 2);
}

function summarizePendingFileOperationProposals(session) {
  const proposals = Array.isArray(session.pendingFileOperationProposals) ? session.pendingFileOperationProposals : [];
  return proposals.filter((proposal) => (proposal.status || "pending_user_approval") === "pending_user_approval").map((proposal) => ({
    id: proposal.id,
    op: proposal.op,
    path: proposal.path,
    source_agent_id: proposal.source_agent_id || proposal.proposedBy?.seatId || "",
    source_agent_name: proposal.source_agent_name || proposal.proposedBy?.name || "",
    round: proposal.round,
    reason: proposal.reason || "",
    expected_effect: proposal.expected_effect || "",
    status: proposal.status || ""
  })).filter((proposal) => proposal.id && proposal.path);
}
function formatContextSections(contextSections) {
  return contextSections
    .map((section) => `## ${section.title}\n${section.content}`)
    .join("\n\n");
}

function formatTranscriptMessage(message) {
  const response = message.response || {};
  const label = `Round ${message.round} / ${message.agentName || message.agentId}`;
  if (response.status === "skip") return `${label}: skip: ${response.reason}`;

  const parts = [`speak: ${response.argument || ""}`];
  if (response.suggested_revision) {
    parts.push(`suggested_revision:\n${response.suggested_revision}`);
  }
  return `${label}: ${parts.join("\n")}`;
}

function formatOpenObjectionLedger(session) {
  const items = Object.values(session.objectionLedger || {})
    .flatMap((byId) => Object.values(byId))
    .filter((item) => item.status !== "resolved");
  if (!items.length) return "Open objection ledger: (none)";
  return `Open objection ledger:\n${JSON.stringify(items.map((item) => ({
    id: item.id,
    issue: item.issue,
    severity: item.severity,
    blocks_final: item.blocks_final,
    in_scope: item.in_scope,
    source_agent_name: item.source_agent_name
  })), null, 2)}`;
}
