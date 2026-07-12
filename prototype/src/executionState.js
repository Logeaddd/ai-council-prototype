import { isReviewerLike } from "./objectionLedger.js";
import { hasMaterialWorkspaceChange } from "./observationCache.js";
import { verifyRequestedArtifactProgress } from "./deliverableVerification.js";

export function createExecutionState({ question, agents = [], workspaceGroup, previousState } = {}) {
  if (previousState?.active && previousState.phase !== "complete") {
    const executor = agents.find((agent) => agent.id === previousState.executorId && agent.enabled !== false)
      || chooseExecutor(agents, workspaceGroup);
    if (executor) {
      return {
        ...previousState,
        active: true,
        executorId: executor.id,
        executorName: executor.name,
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
    lastError: ""
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
  if (state.phase === "review" && state.checkpointVersion > state.reviewedCheckpointVersion) {
    return reviewers.length ? reviewers : [];
  }
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
      "Do not restart broad planning. Continue from the recorded checkpoint and use a real file, command, build, or test action now.",
      state.lastError ? `Last verification error: ${state.lastError}` : ""
    ].filter(Boolean).join("\n");
  }
  if (isReviewerLike(agent)) {
    return `[Checkpoint review] Review checkpoint ${state.checkpointVersion}. Use the recorded diff, command, test, or artifact evidence. Do not repeat an unchanged objection without new evidence.`;
  }
  return "";
}

export function advanceExecutionState({ state, session, agent, groupPath, question, response } = {}) {
  if (!state?.active) return state;
  if (agent.id !== state.executorId) {
    if (isReviewerLike(agent)) {
      state.reviewedCheckpointVersion = state.checkpointVersion;
      state.lastAction = `checkpoint_reviewed_by:${agent.id}`;
      const blockingItems = (response?.objection_items || []).filter((item) => item?.blocks_final !== false && item?.in_scope !== false);
      if (blockingItems.length) {
        state.phase = "repair";
        state.lastError = blockingItems.map((item) => item.issue || item.id).filter(Boolean).join("; ").slice(0, 1200);
        state.nextAction = "A reviewer found a blocking issue. Inspect its evidence, patch the responsible files, and rerun verification.";
      } else if (state.phase === "review" && state.artifactStatus !== "missing_or_invalid") {
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
  const material = [...toolResults, ...fileResults].some(hasMaterialWorkspaceChange);
  const verificationResults = toolResults.filter(isVerificationResult);
  const latestVerification = verificationResults.at(-1);
  const failedVerification = latestVerification && (latestVerification.status !== "completed" || latestVerification.result?.ok === false || Number(latestVerification.result?.exitCode ?? 0) !== 0)
    ? latestVerification
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
  const explicitDelivery = /\b(build|create|implement|write|modify|fix|generate|package|compile|assemble|install|delete|rename|move|commit|push)\b|\b(?:make|produce)\s+(?:a|an|the)?\s*(?:jar|mod|app|project|file|patch|package|build)\b|构建|生成|制作|开发|实现|编写|写入|修改|修复|打包|安装|删除|重命名|移动|提交|推送/i;
  if (explicitDelivery.test(text)) return true;

  const requestedArtifact = /\b(?:jar|exe|msi|apk|ipa|dmg|deb|rpm)\b[^\r\n]{0,40}\b(?:needed|required|deliver|output)\b|(?:需要|产出|交付|给我|做成)[^\r\n]{0,30}\.(?:jar|exe|msi|apk|ipa|dmg|deb|rpm)\b/i;
  return requestedArtifact.test(text);
}

function chooseExecutor(agents, workspaceGroup) {
  const candidates = agents.filter((agent) => agent.enabled !== false && !agent.judge && !isReviewerLike(agent));
  const tiers = workspaceGroup?.permissions?.seatTiers || {};
  const fallbackTier = workspaceGroup?.permissions?.defaultTier || "text";
  return candidates.sort((a, b) => permissionRank(tiers[b.id] || fallbackTier) - permissionRank(tiers[a.id] || fallbackTier))[0];
}

function permissionRank(value) {
  if (value === "full") return 3;
  if (value === "tool") return 2;
  return 1;
}

function isVerificationResult(item = {}) {
  if (item.tool === "run_tests") return true;
  if (item.tool !== "execute_command") return false;
  return /\b(?:gradle|gradlew|mvn|mvnw|npm|pnpm|yarn|cargo|go|dotnet)\b[^\r\n]*(?:build|test|package|assemble|check)|\bjar\s+(?:c|--create)|\bcompress-archive\b/i.test(String(item.command || item.result?.command || ""));
}

function verificationError(item = {}) {
  return String(item.error || item.result?.stderr || item.result?.stdout || item.code || "verification_failed").slice(0, 1200);
}
