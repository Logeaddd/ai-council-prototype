import { isReviewerLike } from "./objectionLedger.js";
import { hasMaterialWorkspaceChange } from "./observationCache.js";
import { verifyRequestedArtifactProgress } from "./deliverableVerification.js";

export function createExecutionState({ question, agents = [], workspaceGroup, previousState } = {}) {
  if (previousState?.active && previousState.phase !== "complete") {
    const executor = agents.find((agent) => agent.id === previousState.executorId && agent.enabled !== false)
      || chooseExecutor(agents, workspaceGroup);
    if (executor) {
      const ownership = resumeOwnership(previousState.ownership, previousState, executor);
      return {
        ...previousState,
        active: true,
        executorId: executor.id,
        executorName: executor.name,
        ownership,
        taskQuestion: String(previousState.taskQuestion || question || ""),
        processedToolResults: 0,
        processedFileResults: 0,
        noActionCalls: 0,
        resumed: true
      };
    }
  }
  if (!isDeliveryTask(question)) return { active: false };
  const executor = chooseExecutor(agents, workspaceGroup);
  if (!executor) return { active: false };
  return {
    active: true,
    executorId: executor.id,
    executorName: executor.name,
    ownership: initialOwnership(executor),
    taskQuestion: String(question || ""),
    phase: "inspect",
    nextAction: "Inspect only the minimum files required, then perform a real workspace mutation.",
    checkpointVersion: 0,
    reviewedCheckpointVersion: 0,
    processedToolResults: 0,
    processedFileResults: 0,
    noActionCalls: 0,
    artifactStatus: "not_checked",
    lastAction: "",
    lastError: "",
    checkpointEvidence: []
  };
}

export function selectExecutionAgents(state, agents = []) {
  if (!state?.active) return null;
  if (state.phase === "complete") return [];
  const executor = agents.find((agent) => agent.id === state.executorId && agent.enabled !== false);
  if (!executor) return null;
  const reviewers = agents.filter((agent) => (
    agent.id !== executor.id && agent.enabled !== false && !agent.judge && isReviewerLike(agent)
  ));
  if (state.phase === "review") {
    const pendingReviewers = pendingReviewersForCheckpoint(state, reviewers);
    if (pendingReviewers.length) return pendingReviewers;
    return [];
  }
  if (state.phase === "repair") return [executor];
  const selected = [executor];
  if (state.checkpointVersion > state.reviewedCheckpointVersion) selected.push(...reviewers);
  return selected;
}

export function executionInstruction(state, agent) {
  if (!state?.active) return "";
  if (agent.id === state.executorId) {
    return [
      `[Execution owner] You are the primary executor for this delivery task. Current phase: ${state.phase}.`,
      `Required next action: ${state.nextAction}`,
      formatCheckpointEvidence(state.checkpointEvidence),
      "Do not restart broad planning. Continue from the recorded checkpoint and use a real file, command, build, or test action now.",
      state.lastError ? `Last verification error: ${state.lastError}` : ""
    ].filter(Boolean).join("\n");
  }
  if (isReviewerLike(agent)) {
    const delegation = reviewDelegationFor(state, agent, true);
    return [
      `[Delegated checkpoint review] You are reviewing checkpoint ${state.checkpointVersion} for delivery owner ${state.ownership?.ownerName || state.executorName}. Delegation: ${delegation?.id || "review"}. Use the recorded diff, command, test, or artifact evidence. Do not repeat an unchanged objection without new evidence.`,
      formatCheckpointEvidence(state.checkpointEvidence)
    ].filter(Boolean).join("\n");
  }
  return "";
}

export function advanceExecutionState({ state, session, agent, groupPath, question, response } = {}) {
  if (!state?.active) return state;
  if (agent.id !== state.executorId) {
    if (isReviewerLike(agent)) {
      const delegation = reviewDelegationFor(state, agent, true);
      if (delegation) {
        delegation.status = "completed";
        delegation.result = response?.status || "reviewed";
      }
      state.lastAction = `checkpoint_reviewed_by:${agent.id}`;
      const blockingItems = (response?.objection_items || []).filter((item) => item?.blocks_final !== false && item?.in_scope !== false);
      if (blockingItems.length) {
        state.phase = "repair";
        state.lastError = blockingItems.map((item) => item.issue || item.id).filter(Boolean).join("; ").slice(0, 1200);
        state.nextAction = "A reviewer found a blocking issue. Inspect its evidence, patch the responsible files, and rerun verification.";
      } else if (state.phase === "review" && state.artifactStatus !== "missing_or_invalid" && reviewCheckpointComplete(state)) {
        state.reviewedCheckpointVersion = state.checkpointVersion;
        state.phase = "complete";
        state.nextAction = "All execution and review gates are complete; proceed to final synthesis.";
      }
    }
    return state;
  }

  const toolResults = (session.toolExecutionResults || []).slice(state.processedToolResults);
  const fileResults = (session.fileOperationExecutionResults || []).slice(state.processedFileResults);
  state.processedToolResults = (session.toolExecutionResults || []).length;
  state.processedFileResults = (session.fileOperationExecutionResults || []).length;
  state.checkpointEvidence = mergeCheckpointEvidence(state.checkpointEvidence, [...fileResults, ...toolResults]);
  const material = [...toolResults, ...fileResults].some(hasMaterialWorkspaceChange);
  const verificationResults = toolResults.filter(isVerificationResult);
  const latestVerification = verificationResults.at(-1);
  const latestExecution = toolResults.filter((item) => ["execute_command", "run_code", "run_tests"].includes(item.tool)).at(-1);
  const latestFailedExecution = latestExecution
    && (latestExecution.status !== "completed" || latestExecution.result?.ok === false || Number(latestExecution.result?.exitCode ?? 0) !== 0)
    ? latestExecution
    : undefined;
  const failedVerification = latestVerification && (latestVerification.status !== "completed" || latestVerification.result?.ok === false || Number(latestVerification.result?.exitCode ?? 0) !== 0)
    ? latestVerification
    : latestFailedExecution && (material || ["verify", "repair"].includes(state.phase))
      ? latestFailedExecution
      : undefined;
  const successfulVerification = latestVerification && latestVerification.status === "completed" && latestVerification.result?.ok !== false && Number(latestVerification.result?.exitCode ?? 0) === 0
    ? latestVerification
    : undefined;

  if (failedVerification) {
    state.phase = "repair";
    state.checkpointVersion += 1;
    state.lastError = verificationError(failedVerification);
    state.lastAction = `verification_failed:${failedVerification.id || failedVerification.tool}`;
    state.nextAction = "Read the exact build/test error, patch the responsible source or configuration, then rerun the same verification.";
    state.noActionCalls = 0;
    return state;
  }

  if (successfulVerification) {
    const artifact = verifyRequestedArtifactProgress({ groupPath, question: state.taskQuestion || question, session });
    state.artifactStatus = artifact.status;
    state.checkpointVersion += 1;
    state.lastAction = `verification_passed:${successfulVerification.id || successfulVerification.tool}`;
    if (artifact.status === "needs_revision") {
      state.phase = "repair";
      state.lastError = artifact.requirements.map((item) => item.reason).filter(Boolean).join("; ");
      state.nextAction = "The build command passed but the requested artifact is missing or invalid. Locate the real output, fix packaging, and rerun the build.";
    } else {
      state.phase = "review";
      prepareReviewDelegations(state, session.groupSnapshot?.agents || []);
      state.lastError = "";
      state.nextAction = "A real verification checkpoint exists. Preserve the evidence and address any reviewer finding.";
      const hasReviewers = (session.groupSnapshot?.agents || []).some((item) => item.enabled !== false && !item.judge && isReviewerLike(item));
      if (!hasReviewers) state.phase = "complete";
    }
    state.noActionCalls = 0;
    return state;
  }

  if (material) {
    state.phase = "verify";
    state.checkpointVersion += 1;
    state.lastAction = "workspace_mutated";
    state.lastError = "";
    state.nextAction = "Run the real project build or test now. Do not return to broad inspection unless verification identifies a specific missing fact.";
    state.noActionCalls = 0;
    return state;
  }

  const observations = toolResults.filter((item) => ["read_file", "list_directory", "search_files", "grep_content"].includes(item.tool));
  state.noActionCalls += 1;
  state.lastAction = observations.length ? "workspace_observed" : "no_real_action";
  state.nextAction = state.phase === "inspect"
    ? "You have enough inspection budget. Perform a real write, patch, command, or project setup action next."
    : "Perform the concrete pending action now; another plan-only response is not progress.";
  return state;
}

export function isDeliveryTask(question) {
  const text = String(question || "");
  const directive = taskDirectiveText(text);
  const directArtifactRequest = /\b(?:make|produce|create|generate|write|export)\b[^\r\n]{0,100}\b(?:pdf|report|document|presentation|spreadsheet|file)\b|\u5e2e\u6211\u505a|\u505a(?:\u4e00|\u4e2a|\u4efd)[^\r\n]{0,100}(?:\u62a5\u544a|\u6587\u4ef6|\u6587\u6863|\u8868\u683c|\u5e7b\u706f\u7247|pdf)|(?:\u7f16\u8f91|\u5bfc\u51fa|\u4fdd\u5b58|\u653e)[^\r\n]{0,80}(?:\u6587\u4ef6|\u684c\u9762|pdf)/i;
  if (directArtifactRequest.test(directive.combined)) return true;
  const continuationWork = /\bcontinue(?:\s+from|\s+with|\s+the)?\b|继续(?:处理|完成|做|推进)?/i.test(directive.combined)
    && /\b(?:current|existing|latest|newest|requested)\b[^\r\n]{0,100}\b(?:artifact|deliverable|file|project|task|requirement)\b|\b[\w./-]+\.(?:json|js|cjs|mjs|ts|py|java|md|txt|csv|zip|jar)\b|当前|现有|最新|最终|要求|产物|文件|项目/i.test(directive.combined);
  const explicitNoChange = /\b(?:do not|don't|without)\s+(?:modify|change|edit|write|touch)\b|只(?:检查|审查|分析)|不要(?:修改|改动|编辑|写入)/i.test(directive.leading);
  const explicitReview = /\b(review|analy[sz]e|assess|evaluate|inspect|what\s+do\s+you\s+think)\b|\u5e2e\u6211\u770b\u770b|\u770b\u770b|\u68c0\u67e5|\u5206\u6790|\u8bc4\u4ef7|\u8bc4\u5ba1|\u5ba1\u67e5|\u600e\u4e48\u6837|\u7ed9\u5efa\u8bae|\u53ea\u7ed9\u5efa\u8bae|\u4e0d\u8981\u6539\u52a8/i;
  if (explicitNoChange && explicitReview.test(directive.leading)) return false;
  if (continuationWork && !explicitNoChange) return true;
  const explicitDirectiveDelivery = /\b(build|create|implement|write|modify|fix|generate|package|compile|assemble|install|delete|rename|move|commit|push)\b|\u6784\u5efa|\u751f\u6210|\u5236\u4f5c|\u5f00\u53d1|\u5b9e\u73b0|\u7f16\u5199|\u5199\u5165|\u4fee\u6539|\u4fee\u590d|\u6253\u5305|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u63d0\u4ea4|\u63a8\u9001/i;
  if (explicitReview.test(directive.leading) && !explicitDirectiveDelivery.test(directive.leading)) return false;
  if (explicitDirectiveDelivery.test(directive.combined)) return true;
  if (/^(?:update|edit|change|adjust|extend|refactor)\b/i.test(directive.leading)) return true;
  const explicitDelivery = /\b(build|create|implement|write|modify|fix|generate|package|compile|assemble|install|delete|rename|move|commit|push)\b|\b(?:make|produce)\s+(?:a|an|the)?\s*(?:jar|mod|app|project|file|patch|package|build)\b|构建|生成|制作|开发|实现|编写|写入|修改|修复|打包|安装|删除|重命名|移动|提交|推送/i;
  if (explicitDelivery.test(directive.combined)) return true;

  const imperativeContinuation = /^(?:use|keep|make|ensure|preserve|apply|update|continue|finish|complete|validate|verify)\b|^(?:\u4f7f\u7528|\u4fdd\u7559|\u786e\u4fdd|\u66f4\u65b0|\u7ee7\u7eed|\u5b8c\u6210|\u9a8c\u8bc1|\u6821\u9a8c)/i;
  const constrainedArtifact = /\b(?:final|current|requested|existing)\b[\s\S]{0,160}\b(?:json|file|artifact|document|spreadsheet|archive|package|project)\b/i;
  const artifactOperation = /\b(?:update|edit|change|adjust|extend|refactor|write|modify|fix|generate|build|create|validate|verify|preserve|package|compile|assemble)\b|\u66f4\u65b0|\u4fee\u6539|\u4fee\u590d|\u751f\u6210|\u9a8c\u8bc1|\u6821\u9a8c|\u6784\u5efa|\u6253\u5305/i;
  if (imperativeContinuation.test(directive.leading) && constrainedArtifact.test(text) && artifactOperation.test(text)) return true;

  const requestedArtifact = /\b(?:jar|exe|msi|apk|ipa|dmg|deb|rpm)\b[^\r\n]{0,40}\b(?:needed|required|deliver|output)\b|(?:需要|产出|交付|给我|做成)[^\r\n]{0,30}\.(?:jar|exe|msi|apk|ipa|dmg|deb|rpm)\b/i;
  return requestedArtifact.test(directive.combined);
}

function taskDirectiveText(value) {
  const text = String(value || "").trim();
  if (!text) return { leading: "", trailing: "", combined: "" };
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean);
  const firstParagraph = (paragraphs[0] || text).slice(0, 1200);
  const firstLine = (firstParagraph.split(/\r?\n/)[0] || firstParagraph).trim();
  const colon = firstLine.search(/[:\uff1a]/);
  const leading = (colon > 0 && colon <= 240 ? firstLine.slice(0, colon) : firstLine).slice(0, 500);
  const lastParagraph = (paragraphs.at(-1) || "").slice(0, 800);
  const trailing = /^(?:please\b|can\s+you\b|now\b|next\b|\u8bf7|\u73b0\u5728|\u63a5\u4e0b\u6765|\u7136\u540e)/i.test(lastParagraph)
    ? lastParagraph
    : "";
  return { leading, trailing, combined: [leading, trailing].filter(Boolean).join("\n") };
}

function chooseExecutor(agents, workspaceGroup) {
  const candidates = agents.filter((agent) => agent.enabled !== false && !agent.judge && !isReviewerLike(agent));
  const tiers = workspaceGroup?.permissions?.seatTiers || {};
  const fallbackTier = workspaceGroup?.permissions?.defaultTier || "text";
  return candidates.sort((a, b) => permissionRank(tiers[b.id] || fallbackTier) - permissionRank(tiers[a.id] || fallbackTier))[0];
}

function initialOwnership(executor) {
  return {
    ownerId: executor.id,
    ownerName: executor.name,
    version: 1,
    transfers: [],
    delegations: []
  };
}

function resumeOwnership(value, previousState, executor) {
  const ownership = normalizeOwnership(value, previousState);
  if (ownership.ownerId === executor.id) {
    ownership.ownerName = executor.name;
    return ownership;
  }
  const fromId = ownership.ownerId || previousState.executorId || "";
  const fromName = ownership.ownerName || previousState.executorName || "";
  ownership.ownerId = executor.id;
  ownership.ownerName = executor.name;
  ownership.version += 1;
  ownership.transfers = [...ownership.transfers, {
    fromId,
    fromName,
    toId: executor.id,
    toName: executor.name,
    reason: "previous_owner_unavailable_during_resume",
    version: ownership.version
  }].slice(-20);
  return ownership;
}

function normalizeOwnership(value, state = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ownerId: String(source.ownerId || state.executorId || ""),
    ownerName: String(source.ownerName || state.executorName || ""),
    version: Math.max(1, Number(source.version || 1)),
    transfers: Array.isArray(source.transfers) ? source.transfers.filter((item) => item && typeof item === "object").slice(-20) : [],
    delegations: Array.isArray(source.delegations) ? source.delegations.filter((item) => item && typeof item === "object").slice(-40) : []
  };
}

function prepareReviewDelegations(state, agents = []) {
  const ownership = state.ownership = normalizeOwnership(state.ownership, state);
  const reviewerIds = new Set(agents
    .filter((agent) => agent.id !== state.executorId && agent.enabled !== false && !agent.judge && isReviewerLike(agent))
    .map((agent) => agent.id));
  for (const delegation of ownership.delegations) {
    if (delegation.type === "checkpoint_review" && delegation.checkpointVersion === state.checkpointVersion && !reviewerIds.has(delegation.assigneeId) && delegation.status === "pending") {
      delegation.status = "superseded";
    }
  }
  for (const agent of agents) {
    if (!reviewerIds.has(agent.id)) continue;
    reviewDelegationFor(state, agent, true);
  }
}

function reviewDelegationFor(state, agent, create = false) {
  const ownership = state.ownership = normalizeOwnership(state.ownership, state);
  const existing = ownership.delegations.find((item) => (
    item.type === "checkpoint_review"
    && item.checkpointVersion === state.checkpointVersion
    && item.assigneeId === agent.id
  ));
  if (existing || !create) return existing;
  const delegation = {
    id: `review:${state.checkpointVersion}:${agent.id}`,
    type: "checkpoint_review",
    checkpointVersion: state.checkpointVersion,
    assignedBy: ownership.ownerId,
    assigneeId: agent.id,
    assigneeName: agent.name,
    status: "pending"
  };
  ownership.delegations = [...ownership.delegations, delegation].slice(-40);
  return delegation;
}

function pendingReviewersForCheckpoint(state, reviewers) {
  prepareReviewDelegations(state, reviewers);
  return reviewers.filter((agent) => reviewDelegationFor(state, agent, false)?.status === "pending");
}

function reviewCheckpointComplete(state) {
  const ownership = normalizeOwnership(state.ownership, state);
  const delegates = ownership.delegations.filter((item) => (
    item.type === "checkpoint_review" && item.checkpointVersion === state.checkpointVersion
  ));
  return delegates.length > 0 && delegates.every((item) => item.status === "completed" || item.status === "superseded");
}

function permissionRank(value) {
  if (value === "full") return 3;
  if (value === "tool") return 2;
  return 1;
}

function isVerificationResult(item = {}) {
  if (item.tool === "run_tests") return true;
  if (item.tool === "run_code") {
    return Boolean(item.result?.verificationIntent)
      || /\b(?:verify|verification|validat(?:e|ion)?|test|check|parse|lint|smoke|assert(?:ion)?)/i.test(String(item.reason || ""));
  }
  if (item.tool !== "execute_command") return false;
  const command = String(item.command || item.result?.command || "");
  const reason = String(item.reason || "");
  if (/\b(?:gradle|gradlew|mvn|mvnw|npm|pnpm|yarn|cargo|go|dotnet)\b[^\r\n]*(?:build|test|package|assemble|check)|\bjar\s+(?:c|--create)|\bcompress-archive\b/i.test(command)) return true;
  if (/\b(?:verify|verification|validat(?:e|ion)?|test|check|parse|lint|smoke|assert(?:ion)?)/i.test(reason)) return true;
  if (/\b(?:verify|verification|validat(?:e|ion)?|test|check|parse|lint|smoke|assert(?:ion)?)/i.test(command)) return true;

  // A successful project check is not limited to one build ecosystem. Agents
  // regularly validate JSON, documents, scripts, and generated data with a
  // small explicit command such as `node -e "JSON.parse(...)"`.
  return /\b(?:verify|validate|test|check|parse|lint|smoke)\b|验证|校验|检查|解析|测试/i.test(reason)
    || /JSON\.parse\s*\(|python(?:3)?\s+-m\s+json\.tool\b|\b(?:jq|xmllint)\b/i.test(command);
}

function verificationError(item = {}) {
  const details = [item.error, item.result?.stderr, item.result?.stdout, item.code]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(details)].join("\n").slice(0, 1200) || "verification_failed";
}

function mergeCheckpointEvidence(previous = [], results = []) {
  const next = [...(Array.isArray(previous) ? previous : []), ...results.map(checkpointEvidenceItem).filter(Boolean)];
  const byId = new Map();
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()].slice(-6);
}

function checkpointEvidenceItem(item = {}) {
  if (item?.status !== "completed" || item?.result?.ok === false) return null;
  const tool = String(item.tool || item.op || item.action || "").trim();
  const id = String(item.id || item.proposalId || "").trim();
  if (!tool || !id) return null;
  const changes = item.result?.workspaceChanges || {};
  const changeCount = Number(changes.totalChanges || changes.total || 0);
  const httpStatus = Number(item.result?.status || 0);
  const exitCode = item.result?.exitCode;
  const target = String(item.path || item.destination || "").trim();
  const outcome = [
    Number.isFinite(exitCode) ? `exit=${exitCode}` : "",
    httpStatus > 0 ? `http=${httpStatus}` : "",
    changeCount > 0 ? `workspace_changes=${changeCount}` : "",
    item.result?.verificationIntent ? "verification_intent" : ""
  ].filter(Boolean).join(", ") || "completed";
  return { id, tool, status: "completed", target, outcome };
}

function formatCheckpointEvidence(value) {
  const evidence = Array.isArray(value) ? value.filter((item) => item?.id && item?.tool).slice(-6) : [];
  if (!evidence.length) return "";
  return `Recorded current-session evidence (newer than prior task summaries): ${evidence.map((item) => `${item.tool}#${item.id}${item.target ? `(${item.target})` : ""} ${item.outcome || item.status}`).join("; ")}`;
}
