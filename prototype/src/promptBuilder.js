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
        "If speaking, use keys: status, position, argument, objections, objection_items, resolved_ids, suggested_revision, artifacts, file_operations, tool_requests, task_contract, confidence, memory_candidates.",
        "When the context labels you [Task intake owner], include task_contract exactly once before delegating or repeating work. Its mode is delivery when the user wants work performed or an outcome produced, or discussion when they want analysis, advice, or an answer without carrying out work. Include objective, requires_workspace, requires_verification, deliverables, completion_criteria, and next_action. requires_workspace means the task needs a workspace mutation, build, package, or other local output; merely reading a workspace file does not make it true. Decide from the user's actual meaning in any language; do not classify by keywords. A delivery contract does not prove completion and does not replace real tool or artifact evidence.",
        "Independently decide from the user's meaning whether they communicated a preference, rule, identity fact, correction, or instruction that should remain relevant in future sessions. This is semantic classification, not keyword matching; handle any language, punctuation, spelling variation, transliteration, or indirect wording.",
        "For memory_candidates, copy the smallest complete verbatim span from the original Question. Never translate, paraphrase, normalize, or invent it. Do not store a one-off task request, quoted example, question about memory, session result, plan, risk, or next action.",
        "Return memory_candidates on both speak and skip responses. Use an empty array when the user communicated no durable information.",
        durableFileContentLine(options),
        completeFileWriteLine(options),
        "Keep going until the deliverable is actually produced and verified. Do not stop after writing a partial file. There is no per-turn limit on how many tools you may call or how much you may write.",
        "If your JSON is truncated or invalid, no file writes will run; make sure each JSON response is complete and valid.",
        "Keep argument short. Do not put full source code, build scripts, manifests, generated files, or long patches in argument, reason, suggested_revision, or artifacts.",
        fileOperationUsageLine(options),
        "Each file_operations item must include op, path, reason, expected_effect; write/append also require content. Allowed op values: read, list, write, append, delete.",
        "Use tool_requests only when you need the app to fetch a web page, search the web, call an HTTP API, list/read workspace files, search file names, grep file content, search saved public group history, load a saved public archive round, read an enabled skill pack, manage installed skill packs, create or extract a zip archive, run a shell command, manage a background process, run a code snippet, install a language package, provision a missing runtime or CLI, run tests, perform Git work, control a real browser, query a SQLite database, search for installable MCP tools, install or remove a configured MCP server, list or call configured MCP tools, read configured MCP resources, or get configured MCP prompts before you can answer. Do not invent tool results; wait for the app to return them in later context.",
        "Use fetch_url only for text/html/json pages. Do not use fetch_url to download zip, jar, exe, images, or other binary files; use provision_tool for a missing CLI/runtime download, including its publisher SHA-256 when available. Use execute_command only when a project-specific binary download is itself the required work.",
        toolRuntimeEnvironmentLine(options.runtimeEnvironment),
        "With shell=powershell, provide the PowerShell script directly; do not wrap it in another powershell -Command call because execute_command already supplies that shell.",
        "Each tool_requests item must include tool and reason. For workspace_edit include action (mkdir, write, append, replace, move), path, and content in code for write/append; replace uses oldText/newText; move uses destination. workspace_edit supports up to 256KB per write and append chunks, so use it instead of long file_operations JSON. For web_search/mcp_search_npm/skill_search include query. search_context can use query and filters eventType, actorId, taskId, file, commit, toolFilter, statusFilter, fromTime, and toTime. For load_context include sessionId and optional round, include eventId from search_context to load one exact retained public event, or include commit with optional eventId/offset/maxBytes to page the exact Git diff and linked verification events. For skill_read include skillId and optional offset/maxBytes; when truncated is true, read again from nextOffset. For skill_enable/skill_disable/skill_remove include skillId. For skill_install include skillId for a built-in skill, skillUrl for a public SKILL.md URL, or skillMarkdown for direct Markdown. For fetch_url/api_request/browser_control include url. For api_request include method and optional headers, json, or body. For list_directory/read_file/extract_archive/create_archive/database_query include path. For create_archive include paths (or files) with the workspace files/directories to package. For database_query include sql and optional params, mode (query or execute), create, and maxRows. For extract_archive include destination when you want a specific output folder. For search_files/grep_content include query and optional path. For execute_command include command, optional cwd, optional shell (system, powershell, cmd, bash, sh), optional timeoutMs, and optional background. A background command only proves startup; use process_control with action list, status, output, or stop and processId to observe and control it. For process_control output, optionally include stream (stdout or stderr), offset, and maxBytes. For run_code include language and code. For install_package include manager (npm, pip, cargo, go, or gem) and packageName. For provision_tool include toolName and commandName, then either manager/packageId, installCommand, or an HTTPS downloadUrl. For a tool not in the known runtime map, first use web_search to find a publisher or official platform package listing and include its URL as discoverySourceUrl plus the search terms as discoveryQuery. Discovery evidence is not a trust guarantee: supply the publisher SHA-256 in sha256 whenever available; a download without it remains explicitly unverified. Use executablePath and verifyCommand when discovery needs help. For run_tests include runner (npm, pytest, cargo, or custom), optional cwd, and command for custom. For git_operation include action (status, init, clone, branch, create_branch, switch_branch, commit, pull, push), optional url/repository/repo for clone, optional destination for clone, optional branch, remote, message, paths, cwd, and timeoutMs. For browser_control include optional steps with action open, navigate, click, type, evaluate, screenshot, wait, or wait_for_selector. For mcp_install_npm include packageSpec or catalogId, optional serverId, binName, and args. For mcp_uninstall include serverId. For mcp_list_tools, mcp_list_resources, and mcp_list_prompts include optional serverId. For mcp_call include mcpToolName and arguments; include serverId only after choosing a specific server or when the same tool name appears on more than one MCP server. For mcp_read_resource include serverId when needed and uri. For mcp_get_prompt include serverId when needed, promptName, and optional arguments. Allowed tool values include workspace_edit plus the listed read, web, command, package, provisioning, test, Git, browser, database, skill, and MCP tools.",
        disabledCapabilitiesLine(options.appSettings),
        "If skipping, use keys: status, reason, memory_candidates.",
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
    return "Do not use proposed_files, source_files, patches, markdown code blocks, or file_operations placeholders for durable file contents. Put complete contents in real workspace_edit native/tool requests or create them through a real command.";
  }
  return "Do not use proposed_files, source_files, patches, or markdown code blocks for durable file contents. Durable file contents must be in file_operations.content for write/append, or created by a real execute_command/tool request.";
}

function completeFileWriteLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "full") {
    return "Write each complete file in a single workspace_edit operation when the provider can return it. workspace_edit accepts up to 256KB per content chunk. Only split into append chunks when a provider or real tool constraint requires it, and keep calling tools until the file is complete. You may include any number of tool requests needed for the task.";
  }
  return "Write each complete file in a single operation. Only split into append chunks when a real provider or tool constraint requires it.";
}

function fileOperationUsageLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "full") {
    return "Use workspace_edit through native tools or tool_requests for file mutations so execution results return to you immediately. file_operations is a compatibility fallback and must not be used as a placeholder. You do not have direct filesystem access outside real tools.";
  }
  return "Use file_operations only to request file work. The app validates every path; read/list can be executed by the app and returned in later context. Tool-permission writes remain pending for user approval. You do not have direct filesystem access.";
}


function fileOperationProtocolLine(options = {}) {
  if (!options.fileOperationContext) return "";
  if (disabledToolNames(options.appSettings).includes("read_file")) {
    return "Global settings have disabled file tools. Do not request file_operations or claim workspace files were read, written, appended, or deleted.";
  }
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "You have text-only file permission for this workspace. If the task requires creating or modifying files, do not propose file_operations yourself; discuss requirements and leave file proposals to a member with tool or full file permission.";
  if (tier === "full") {
    return "You have full permission: real workspace tools execute immediately and are audited. For code or configuration work, use native workspace_edit tool calls (or tool_requests fallback) to write complete durable files, then run the real build or tests. You may perform multiple writes and commands in one response. Do not answer with a plan, promise, repeated directory listing, or file_operations placeholder while a required file is still missing. Split content only when the provider cannot return one complete tool call; continue with append calls until the file is complete, then verify it.";
  }
  return "If this task requires inspecting workspace files, request read/list in file_operations. If it requires creating or modifying workspace files, you MUST propose the change in file_operations with the full file content for write/append. Do not put complete file content only in argument, suggested_revision, or artifacts; those fields may summarize it. Never paste large source files, scripts, Gradle files, manifests, or other durable file contents into argument; put durable file contents only in file_operations.content so the app can write them.";
}

function disabledCapabilitiesLine(appSettings) {
  const tools = disabledToolNames(appSettings);
  if (!tools.length) return "";
  const fileOverride = tools.includes("read_file") ? " file_operations are also disabled." : "";
  return `Global settings override every generic tool statement above. These tools are disabled and unavailable; do not request them: ${tools.join(", ")}.${fileOverride}`;
}

function toolRequestProtocolLine(options = {}) {
  const tier = options.fileOperationPermissionTier || "text";
  if (tier === "text") return "You have text-only external tool permission. You may still use search_context and load_context because they read this group's own public discussion history. Do not request web_search, fetch_url, api_request, list_directory, read_file, search_files, grep_content, skill_read, skill_list, skill_search, skill_install, skill_enable, skill_disable, skill_remove, extract_archive, create_archive, execute_command, process_control, run_code, install_package, provision_tool, run_tests, git_operation, browser_control, database_query, mcp_search_npm, mcp_install_npm, mcp_uninstall, mcp_list_tools, mcp_call, mcp_list_resources, mcp_read_resource, mcp_list_prompts, mcp_get_prompt, or workspace_edit; explain what external information would be needed.";
  if (tier === "full") return "You may request built-in tools with tool_requests and they execute autonomously without per-action user approval. Available tools: workspace_edit for real mkdir, atomic write, append chunks, exact replace, and move operations up to 256KB per content chunk, web_search for live web search, fetch_url for reading a public https page, api_request for real HTTP API calls with method, headers, json, or body, list_directory/read_file for allowed workspace files, search_files for file names, grep_content for file text, search_context for saved public group history, load_context for a saved public archive session or round, skill_read for loading the full instructions of a skill enabled for this group, skill_list for installed skill state, skill_search for real GitHub repository candidates, skill_install for validated text-only SKILL.md installation, skill_enable/skill_disable for group use, skill_remove for deleting an installed skill, extract_archive for zip files inside the group workspace, create_archive for packaging workspace files/directories into a real zip, execute_command for real shell commands in the group workspace, including pipes, redirection, curl | bash, package managers, tests, and background processes, process_control for listing background processes, checking status, reading bounded stdout/stderr, and stopping a process tree, run_code for real JavaScript/Node, Python, PowerShell, or shell snippets saved and executed inside the group workspace, install_package for real npm, pip, cargo, go, or gem installs into managed group-workspace environments, provision_tool for detecting and acquiring missing runtimes or CLIs through platform package managers, explicit install commands, or downloadable archives and then verifying them, run_tests for real npm, pytest, cargo, or custom test commands, git_operation for real Git status, init, clone, branch, switch, commit, pull, and push inside the group workspace, browser_control for opening a real browser page, clicking, typing, evaluating page state, and saving screenshots, database_query for reading or writing SQLite databases inside the group workspace, mcp_search_npm for real npm registry search before adding MCP tools, mcp_install_npm for built-in or npm MCP servers, mcp_uninstall for configured MCP servers, mcp_list_tools and mcp_call for configured MCP tools, mcp_list_resources and mcp_read_resource for configured MCP resources, and mcp_list_prompts and mcp_get_prompt for configured MCP prompts. Installing a skill stores instructions and never executes downloaded scripts implicitly. A background execute_command result means started, not completed; inspect it with process_control before relying on its output. If a command fails because its executable is missing, use provision_tool and retry instead of stopping at a plan. mcp_call can infer the server when the tool name is unique; include serverId for ambiguous tool names. Tool results will be returned by the app in later context.";
  return "You may request built-in tools with tool_requests. Available tools: web_search for live web search, fetch_url for reading a public https page, api_request for real HTTP API calls, list_directory/read_file for allowed workspace files, search_files for file names, grep_content for file text, search_context for saved public group history, load_context for a saved public archive session or round, skill_read for loading an enabled skill's instructions, and database_query for read-only SQLite SELECT queries inside the group workspace. Tool results will be returned by the app in later context. skill_list, skill_search, skill_install, skill_enable, skill_disable, skill_remove, extract_archive, create_archive, execute_command, process_control, run_code, install_package, provision_tool, run_tests, git_operation, browser_control, mcp_search_npm, mcp_install_npm, mcp_uninstall, mcp_list_tools, mcp_call, mcp_list_resources, mcp_read_resource, mcp_list_prompts, and mcp_get_prompt require full permission. database_query write operations require full permission. workspace_edit requires full permission.";
}

function toolRuntimeEnvironmentLine(runtimeEnvironment) {
  if (runtimeEnvironment) return runtimeEnvironment;
  if (process.platform === "win32") {
    return "Tool runtime environment: Windows. Prefer shell=system, shell=cmd, or shell=powershell for execute_command. Use bash/sh only after a real tool result proves that bash/sh works in this workspace; Linux-only commands such as apt-get or mkdir -p are not valid unless the tool result proves a Linux shell is available. For directory creation on Windows, use PowerShell New-Item -ItemType Directory -Force or cmd mkdir.";
  }
  return `Tool runtime environment: ${process.platform}. Prefer shell=system unless a task requires a specific shell.`;
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
