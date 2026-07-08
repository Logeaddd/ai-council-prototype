import { isReviewerLike, reviewIntensityRules } from "./objectionLedger.js";

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
        "Return only JSON.",
        `Your visible utterance will be rendered as "${agent.name}\u8bf4\uff1a...". Put the speakable content in argument or reason.`,
        "Allowed round statuses are speak or skip.",
        "If you agree with the prior context and have no new objection, return skip.",
        nonReviewerObjectionLine(agent),
        completionSkipLine(agent),
        redTeamDutyLine(agent, round),
        independentAnswerModeLine(options),
        reviewProtocolLine(agent, options),
        fileOperationProtocolLine(options),
        toolRequestProtocolLine(options),
        "If speaking, use keys: status, position, argument, objections, objection_items, resolved_ids, suggested_revision, artifacts, file_operations, tool_requests, confidence, memory_candidates.",
        "Use file_operations only to request file work. The app validates every path; read/list can be executed by the app and returned in later context, while write/append/delete require approval before execution. You do not have direct filesystem access.",
        "Each file_operations item must include op, path, reason, expected_effect; write/append also require content. Allowed op values: read, list, write, append, delete.",
        "Use tool_requests only when you need the app to fetch a web page, search the web, call an HTTP API, list/read workspace files, search file names, grep file content, search saved public group history, load a saved public archive round, extract a zip archive, run a shell command, run a code snippet, install a package, run tests, or perform Git work before you can answer. Do not invent tool results; wait for the app to return them in later context.",
        "Each tool_requests item must include tool and reason. For web_search/search_context include query. For load_context include sessionId and optional round. For fetch_url/api_request include url. For api_request include method and optional headers, json, or body. For list_directory/read_file/extract_archive include path. For extract_archive include destination when you want a specific output folder. For search_files/grep_content include query and optional path. For execute_command include command, optional cwd, optional shell (system, powershell, cmd, bash, sh), optional timeoutMs, and optional background. For run_code include language and code. For install_package include manager (npm or pip) and packageName. For run_tests include runner (npm, pytest, cargo, or custom), optional cwd, and command for custom. For git_operation include action (status, init, branch, create_branch, switch_branch, commit, pull, push), optional branch, remote, message, paths, cwd, and timeoutMs. Allowed tool values: web_search, fetch_url, api_request, list_directory, read_file, search_files, grep_content, search_context, load_context, extract_archive, execute_command, run_code, install_package, run_tests, git_operation.",
        "If skipping, use keys: status, reason.",
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
        "The answer field must be a substantive final summary. Never set answer to skip, and never output a round-style skip response in the final call.",
        "Use answer for a user-facing synthesis. Do not treat answer as the executable source of truth.",
        "If session artifacts contain runnable code, plans, or durable deliverables, reference the latest relevant artifacts in answer instead of rewriting or inventing them.",
        "Artifacts are the machine-usable deliverables; preserve their meaning and do not replace them with prose.",
        "Preserve unresolved Red Team dissent. Do not hide minority concerns.",
        "If pending file operation proposals are listed, set selected_file_operation_ids to the exact proposal ids you adopt for execution. Use an empty array when no file operation should execute.",
        globalRequirement ? `[Boss global requirement]\n${globalRequirement}` : "",
        "memory_candidates must contain only stable user preferences, durable project rules, or explicit facts worth remembering across future sessions.",
        "Do not put this session's conclusions, risks, next actions, minority reports, or generic advice into memory_candidates.",
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


function fileOperationProtocolLine(options = {}) {
  if (!options.fileOperationContext) return "";
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "You have text-only file permission for this workspace. If the task requires creating or modifying files, do not propose file_operations yourself; discuss requirements and leave file proposals to a member with tool or full file permission.";
  return "If this task requires inspecting workspace files, request read/list in file_operations. If it requires creating or modifying workspace files, you MUST propose the change in file_operations with the full file content for write/append. Do not put complete file content only in argument, suggested_revision, or artifacts; those fields may summarize it.";
}

function toolRequestProtocolLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "You have text-only tool permission. Do not request web_search, fetch_url, api_request, list_directory, read_file, search_files, grep_content, search_context, load_context, extract_archive, execute_command, run_code, install_package, run_tests, or git_operation; explain what information would be needed.";
  if (tier === "full") return "You may request built-in tools with tool_requests. Available tools: web_search for live search when configured, fetch_url for reading a public https page, api_request for real HTTP API calls with method, headers, json, or body, list_directory/read_file for allowed workspace files, search_files for file names, grep_content for file text, search_context for saved public group history, load_context for a saved public archive session or round, extract_archive for zip files inside the group workspace, execute_command for real shell commands in the group workspace, including pipes, redirection, curl | bash, package managers, tests, and background processes, run_code for real JavaScript/Node, Python, PowerShell, or shell snippets saved and executed inside the group workspace, install_package for real npm or pip installs into managed group-workspace environments, run_tests for real npm, pytest, cargo, or custom test commands, and git_operation for real Git status, init, branch, switch, commit, pull, and push inside the group workspace. Tool results will be returned by the app in later context.";
  return "You may request built-in tools with tool_requests. Available tools: web_search for live search when configured, fetch_url for reading a public https page, api_request for real HTTP API calls, list_directory/read_file for allowed workspace files, search_files for file names, grep_content for file text, search_context for saved public group history, and load_context for a saved public archive session or round. Tool results will be returned by the app in later context. extract_archive, execute_command, run_code, install_package, run_tests, and git_operation require full permission.";
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
  return proposals.map((proposal) => ({
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
