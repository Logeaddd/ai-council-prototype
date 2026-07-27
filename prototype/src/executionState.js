import { isReviewerLike } from "./objectionLedger.js";
import { hasMaterialWorkspaceChange } from "./observationCache.js";
import { verifyRequestedArtifactProgress } from "./deliverableVerification.js";
import { hasNativeModelSource } from "./nativeToolProvenance.js";

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
        taskContract: normalizeTaskContract(previousState.taskContract)
          || (previousState.phase && previousState.phase !== "intake" ? inferredLegacyDeliveryContract(previousState) : undefined),
        taskQuestion: String(previousState.taskQuestion || question || ""),
        processedToolResults: 0,
        processedFileResults: 0,
        noActionCalls: 0,
        recovery: normalizeRecoveryState(previousState.recovery),
        delegationSequence: Math.max(0, Number(previousState.delegationSequence || 0)),
        resumed: true
      };
    }
  }
  if (!String(question || "").trim()) return { active: false };
  const executor = chooseExecutor(agents, workspaceGroup);
  if (!executor) return { active: false };
  return {
    active: true,
    executorId: executor.id,
    executorName: executor.name,
    ownership: initialOwnership(executor),
    taskQuestion: String(question || ""),
    phase: "intake",
    taskContract: undefined,
    intakeAttempts: 0,
    nextAction: "Interpret the user request and record a task contract before delegating or repeating work. If it is delivery work, start the next material action; if it is discussion, release the group to discuss it.",
    checkpointVersion: 0,
    reviewedCheckpointVersion: 0,
    processedToolResults: 0,
    processedFileResults: 0,
    noActionCalls: 0,
    recovery: createRecoveryState(),
    delegationSequence: 0,
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
  const pendingDelegates = pendingWorkDelegates(state, agents);
  if (pendingDelegates.length) return pendingDelegates;
  if (hasUnacknowledgedWorkDelegations(state)) return [executor];
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
    if (state.phase === "intake") {
      return [
        "[Task intake owner] You alone own the initial interpretation of this task. Read the user's actual meaning in any language and return a valid task_contract in this response.",
        "Do not use keywords, file extensions, or role names as the classifier. Set mode=delivery only when work must be carried out; set mode=discussion only when the user wants analysis, advice, or an answer without carrying out work.",
        "For delivery, state the requested outputs and mechanical completion criteria, then begin a real material action when one is available. For discussion, give a substantive answer; the group will be released after this contract is recorded."
      ].join("\n");
    }
    const requiresWorkspace = state.taskContract?.requiresWorkspace === true;
    return [
      `[Execution owner] You are the primary executor for this delivery task. Current phase: ${state.phase}.`,
      formatTaskContract(state.taskContract),
      formatDelegationHandoffsForOwner(state),
      formatRecoveryState(state.recovery),
      `Required next action: ${state.nextAction}`,
      formatCheckpointEvidence(state.checkpointEvidence),
      requiresWorkspace
        ? "Do not restart broad planning. Continue from the recorded checkpoint and use a real file, command, build, or test action now."
        : "Do not restart broad planning. Continue from the recorded checkpoint and take the recorded material action now.",
      state.lastError ? `Last verification error: ${state.lastError}` : ""
    ].filter(Boolean).join("\n");
  }
  const workDelegation = workDelegationFor(state, agent);
  if (workDelegation) {
    return [
      `[Delegated ${workDelegation.type} work] You are contributor ${agent.name} for delivery owner ${state.ownership?.ownerName || state.executorName}. Delegation: ${workDelegation.id}.`,
      `Your bounded task: ${workDelegation.task}`,
      `Expected handoff evidence: ${workDelegation.expectedEvidence.join("; ")}.`,
      `Allowed tools: ${workDelegation.allowedTools.join(", ") || "read-only default"}.`,
      workDelegation.allowWorkspaceMutation
        ? `You may mutate only these explicitly delegated paths: ${workDelegation.allowedPaths.join(", ")}. Do not modify any final deliverable outside them.`
        : "You have no workspace-mutation delegation. Do not write, move, delete, build, package, or otherwise mutate project outputs.",
      "Do not restart the whole task, do not independently finalize it, and do not delegate further. Return delegation_handoff with this exact delegation_id, a concise result, and concrete evidence for the owner."
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
    const workDelegation = workDelegationFor(state, agent);
    if (workDelegation) {
      completeWorkDelegation(state, workDelegation, agent, response, session);
      return state;
    }
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

  if (state.phase === "intake") {
    const intake = applyTaskIntake(state, response, session);
    if (!intake.delivery) return state;
  }

  acknowledgeOwnerDelegations(state, agent);
  registerOwnerDelegations(state, response, session.groupSnapshot?.agents || []);

  const toolResults = (session.toolExecutionResults || []).slice(state.processedToolResults);
  const fileResults = (session.fileOperationExecutionResults || []).slice(state.processedFileResults);
  state.processedToolResults = (session.toolExecutionResults || []).length;
  state.processedFileResults = (session.fileOperationExecutionResults || []).length;
  state.checkpointEvidence = mergeCheckpointEvidence(state.checkpointEvidence, [...fileResults, ...toolResults]);
  const recoveryUpdate = updateDeliveryRecoveryState(state, toolResults);
  const material = [...toolResults, ...fileResults].some(hasMaterialWorkspaceChange);
  const collaborationBeforeAction = collaborationRequirementStatus(state);
  if (collaborationBeforeAction.pending && collaborationBeforeAction.beforeFirstMutation && material) {
    state.phase = "repair";
    state.checkpointVersion += 1;
    state.lastAction = "collaboration_prerequisite_bypassed";
    state.lastError = collaborationBeforeAction.reason;
    state.nextAction = collaborationBeforeAction.nextAction;
    state.noActionCalls = 0;
    return state;
  }
  if (collaborationBeforeAction.pending && !hasOpenWorkDelegations(state) && !toolResults.length && !fileResults.length) {
    state.lastAction = "collaboration_prerequisite_pending";
    state.lastError = collaborationBeforeAction.reason;
    state.nextAction = collaborationBeforeAction.nextAction;
    state.noActionCalls = 0;
    return state;
  }
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

  if (recoveryUpdate.requiresAlternative && !material && !successfulVerification) {
    state.phase = "repair";
    state.checkpointVersion += 1;
    state.lastAction = `recovery_required:${recoveryUpdate.failure.resultId}`;
    state.lastError = recoveryUpdate.failure.error;
    state.nextAction = recoveryAlternativeAction(recoveryUpdate.failure);
    state.noActionCalls = 0;
    return state;
  }

  if (recoveryUpdate.pendingCapability && !material && !successfulVerification) {
    state.lastAction = `capability_acquired:${recoveryUpdate.pendingCapability.acquisitionId}`;
    state.lastError = "";
    state.nextAction = recoveryUsageAction(recoveryUpdate.pendingCapability);
    state.noActionCalls = 0;
    return state;
  }

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
    const collaboration = collaborationRequirementStatus(state);
    if (collaboration.pending) {
      state.phase = "repair";
      state.checkpointVersion += 1;
      state.lastAction = "collaboration_prerequisite_pending";
      state.lastError = collaboration.reason;
      state.nextAction = collaboration.nextAction;
      state.noActionCalls = 0;
      return state;
    }
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

  // Verification can finish while a deliberately managed terminal or server
  // is still alive. Its status/output/stop controls are cleanup evidence, not
  // a new unverified execution phase, so keep the completed checkpoint intact.
  if (preservesVerifiedCheckpoint(state, toolResults, fileResults)) return state;

  if (material) {
    state.phase = "verify";
    state.checkpointVersion += 1;
    state.lastAction = "workspace_mutated";
    state.lastError = "";
    state.nextAction = "Run the real project build or test now. Do not return to broad inspection unless verification identifies a specific missing fact.";
    state.noActionCalls = 0;
    return state;
  }

  const collaboration = collaborationRequirementStatus(state);
  if (canCompleteNonWorkspaceDelivery(state, response) && !hasOpenWorkDelegations(state) && !collaboration.pending) {
    state.phase = "complete";
    state.lastAction = "non_workspace_delivery_complete";
    state.lastError = "";
    state.nextAction = "The declared non-workspace delivery has completed its recorded tool work; proceed to final synthesis.";
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

// Delivery recovery is durable evidence, not a model-facing suggestion.  It
// records the exact acquisition/runtime strategy that failed and the later
// result that proved an acquired capability was actually used.  This lets a
// resumed owner continue from a real checkpoint instead of rediscovering the
// same failed path.
function createRecoveryState() {
  return {
    version: 1,
    failures: [],
    pendingCapabilities: [],
    usage: []
  };
}

function normalizeRecoveryState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: Math.max(1, Number(source.version || 1)),
    failures: Array.isArray(source.failures) ? source.failures.filter(isRecoveryFailure).slice(-24) : [],
    pendingCapabilities: Array.isArray(source.pendingCapabilities) ? source.pendingCapabilities.filter(isPendingCapability).slice(-16) : [],
    usage: Array.isArray(source.usage) ? source.usage.filter(isCapabilityUsageRecord).slice(-32) : []
  };
}

function isRecoveryFailure(item) {
  return item && typeof item === "object" && String(item.fingerprint || "") && String(item.resultId || "");
}

function isPendingCapability(item) {
  return item && typeof item === "object" && String(item.acquisitionId || "") && String(item.tool || "");
}

function isCapabilityUsageRecord(item) {
  return item && typeof item === "object" && String(item.acquisitionId || "") && String(item.usedBy || "");
}

function updateDeliveryRecoveryState(state, toolResults = []) {
  const recovery = state.recovery = normalizeRecoveryState(state.recovery);
  const newlyRecordedFailures = [];

  for (const result of toolResults) {
    const failure = recoveryFailureFromResult(result);
    if (failure && !recovery.failures.some((item) => item.resultId === failure.resultId)) {
      recovery.failures.push(failure);
      newlyRecordedFailures.push(failure);
    }
    const capability = pendingCapabilityFromResult(result);
    if (capability && !recovery.pendingCapabilities.some((item) => item.acquisitionId === capability.acquisitionId) && !recovery.usage.some((item) => item.acquisitionId === capability.acquisitionId)) {
      recovery.pendingCapabilities.push(capability);
    }
    for (const usage of Array.isArray(result?.capabilityUsage) ? result.capabilityUsage : []) {
      const acquisitionId = String(usage?.acquisitionId || "");
      if (!acquisitionId) continue;
      const pendingIndex = recovery.pendingCapabilities.findIndex((item) => item.acquisitionId === acquisitionId);
      if (pendingIndex >= 0) recovery.pendingCapabilities.splice(pendingIndex, 1);
      if (!recovery.usage.some((item) => item.acquisitionId === acquisitionId && item.usedBy === result.id)) {
        recovery.usage.push({
          acquisitionId,
          acquisitionTool: String(usage.acquisitionTool || ""),
          kind: String(usage.kind || ""),
          references: Array.isArray(usage.references) ? usage.references.slice(0, 4).map((item) => String(item).slice(0, 180)) : [],
          usedBy: String(result.id || ""),
          usedAt: String(result.createdAt || "")
        });
      }
    }
  }

  resolveRecoveredFailures(recovery, toolResults);
  recovery.failures = recovery.failures.slice(-24);
  recovery.pendingCapabilities = recovery.pendingCapabilities.slice(-16);
  recovery.usage = recovery.usage.slice(-32);
  const unresolvedFailures = recovery.failures.filter((item) => !item.resolvedBy);
  return {
    failure: newlyRecordedFailures.at(-1),
    requiresAlternative: Boolean(newlyRecordedFailures.length && unresolvedFailures.length),
    pendingCapability: recovery.pendingCapabilities.at(-1)
  };
}

function recoveryFailureFromResult(result = {}) {
  if (!isFailedToolResult(result)) return undefined;
  const tool = String(result.tool || "");
  const strategy = recoveryStrategyForResult(result);
  if (!strategy) return undefined;
  return {
    resultId: String(result.id || `${tool}:${strategy.fingerprint}`),
    tool,
    fingerprint: strategy.fingerprint,
    family: strategy.family,
    label: strategy.label,
    error: recoveryErrorText(result),
    createdAt: String(result.createdAt || "")
  };
}

function isFailedToolResult(result = {}) {
  return result?.status === "failed" || result?.result?.ok === false;
}

function recoveryStrategyForResult(result = {}) {
  const tool = String(result.tool || "");
  if (tool === "install_package") {
    const manager = String(result.manager || result.result?.manager || "default").toLowerCase();
    const packageName = normalizeRecoveryValue(result.packageName || result.result?.packageName || "unknown-package");
    return {
      family: "managed_package",
      fingerprint: `install_package:${manager}:${packageName}`,
      label: `${manager} package ${packageName}`
    };
  }
  if (tool === "provision_tool") {
    const command = normalizeRecoveryValue(result.commandName || result.result?.command || result.toolName || "unknown-command");
    const source = normalizeRecoveryValue(result.packageId || result.downloadUrl || result.installCommand || result.discoverySourceUrl || "default-source");
    return {
      family: "tool_provision",
      fingerprint: `provision_tool:${command}:${source}`,
      label: `tool provisioning for ${command}`
    };
  }
  if (tool === "execute_command" && isDirectPackageInstall(result)) {
    const command = normalizeRecoveryValue(result.command || result.result?.command || "package-install");
    return { family: "shell_package", fingerprint: `shell_package:${command}`, label: "direct package-manager command" };
  }
  if (tool === "execute_command" && missingExecutableName(result)) {
    const executable = normalizeRecoveryValue(missingExecutableName(result));
    return { family: "missing_runtime", fingerprint: `missing_runtime:${executable}`, label: `missing executable ${executable}` };
  }
  return undefined;
}

function isDirectPackageInstall(result = {}) {
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:add|install)\b|\b(?:python|python3|py)(?:\.exe)?\s+-m\s+pip\s+install\b|(?:^|[;&|]\s*)pip3?\s+install\b|(?:^|[;&|]\s*)(?:cargo|gem)\s+(?:add|install)\b|(?:^|[;&|]\s*)go\s+(?:get|install)\b|(?:^|[;&|]\s*)(?:winget|choco|scoop|brew)\s+install\b|\bapt(?:-get)?\s+install\b/i.test(String(result.command || result.result?.command || ""));
}

function missingExecutableName(result = {}) {
  const output = [result.error, result.result?.error, result.result?.stderr, result.result?.stdout].filter(Boolean).join("\n");
  const patterns = [
    /['"]?([A-Za-z0-9._-]+)['"]?\s+is not recognized as an internal or external command/i,
    /(?:command not found|not found):?\s*([A-Za-z0-9._-]+)?/i,
    /([A-Za-z0-9._-]+):\s*(?:command not found|not found)/i,
    /The term ['"]([^'"]+)['"] is not recognized/i
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function recoveryErrorText(result = {}) {
  const text = [result.error, result.result?.error, result.result?.stderr, result.result?.stdout]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return (text || `The ${result.tool || "tool"} request failed.`).slice(0, 1200);
}

function pendingCapabilityFromResult(result = {}) {
  if (result?.status !== "completed" || result?.result?.ok === false) return undefined;
  const tool = String(result.tool || "");
  if (!new Set(["install_package", "provision_tool", "skill_install", "mcp_install_npm"]).has(tool)) return undefined;
  return {
    acquisitionId: String(result.id || ""),
    tool,
    label: capabilityLabel(result),
    references: capabilityReferences(result),
    acquiredAt: String(result.createdAt || "")
  };
}

function capabilityLabel(result = {}) {
  if (result.tool === "install_package") return `installed package ${String(result.result?.packageName || result.packageName || "")}`.trim();
  if (result.tool === "provision_tool") return `provisioned command ${String(result.result?.command || result.commandName || result.toolName || "")}`.trim();
  if (result.tool === "skill_install") return `installed skill ${String(result.result?.skill?.id || result.skillId || "")}`.trim();
  return `configured MCP server ${String(result.result?.id || result.serverId || result.packageSpec || "")}`.trim();
}

function capabilityReferences(result = {}) {
  const values = result.tool === "install_package"
    ? [result.result?.packageName, result.packageName]
    : result.tool === "provision_tool"
      ? [result.result?.command, result.commandName, result.toolName]
      : result.tool === "skill_install"
        ? [result.result?.skill?.id, result.skillId]
        : [result.result?.id, result.serverId, result.packageSpec];
  return [...new Set(values.map(normalizeRecoveryValue).filter(Boolean))].slice(0, 4);
}

function resolveRecoveredFailures(recovery, toolResults = []) {
  for (const failure of recovery.failures) {
    if (failure.resolvedBy) continue;
    const alternative = (toolResults || []).find((result) => result?.status === "completed" && result?.result?.ok !== false && resolvesRecoveryFailure(failure, result));
    if (alternative) {
      failure.resolvedBy = String(alternative.id || alternative.tool || "alternative_action");
      failure.resolvedAt = String(alternative.createdAt || "");
    }
  }
}

function resolvesRecoveryFailure(failure, result = {}) {
  const tool = String(result.tool || "");
  if (failure.family === "managed_package") {
    return tool === "provision_tool" || (tool === "install_package" && recoveryStrategyForResult({ ...result, status: "failed" })?.fingerprint !== failure.fingerprint);
  }
  if (failure.family === "tool_provision" || failure.family === "missing_runtime") {
    return ["provision_tool", "install_package"].includes(tool);
  }
  if (failure.family === "shell_package") {
    return ["install_package", "provision_tool"].includes(tool) || (tool === "execute_command" && !isDirectPackageInstall(result));
  }
  return false;
}

function recoveryAlternativeAction(failure) {
  return `The previous ${failure.label} strategy failed (${failure.error}). Do not retry that exact strategy. Choose and execute a materially different acquisition or runtime path now, then use it to create, repair, build, or verify the requested deliverable.`;
}

function recoveryUsageAction(capability) {
  return `A capability was acquired (${capability.label}). Invoke it in a real artifact-producing, build, repair, or verification action now. Do not return to broad search, planning, or another acquisition before recording concrete use evidence.`;
}

function formatRecoveryState(value) {
  const recovery = normalizeRecoveryState(value);
  const unresolved = recovery.failures.filter((item) => !item.resolvedBy).slice(-3);
  const pending = recovery.pendingCapabilities.slice(-3);
  if (!unresolved.length && !pending.length) return "";
  return [
    "[Durable delivery recovery]",
    ...unresolved.map((item) => `Failed strategy (do not repeat unchanged): ${item.label}. Evidence: ${item.error}`),
    ...pending.map((item) => `Acquired but not yet used: ${item.label}. Required: invoke it in an artifact-producing, build, repair, or verification action.`)
  ].join("\n");
}

// The engine calls this before executing model-proposed tools.  It only blocks
// an exact failed acquisition retry, or read/search wandering after the owner
// has already acquired a capability.  It deliberately does not impose a turn
// or tool-count limit on genuine delivery work.
export function gateDeliveryRecoveryToolRequests(state, agent, requests = []) {
  if (!state?.active || agent?.id !== state.executorId) return { accepted: Array.isArray(requests) ? requests : [], rejected: [] };
  const recovery = normalizeRecoveryState(state.recovery);
  const collaboration = collaborationRequirementStatus(state);
  const blockedFingerprints = new Set(recovery.failures.map((item) => item.fingerprint));
  const pending = recovery.pendingCapabilities;
  const accepted = [];
  const rejected = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    if (collaboration.pending && collaboration.beforeFirstMutation && requestIsMaterialExecution(request)) {
      rejected.push(recoveryRequestRejection(request, "collaboration_prerequisite_pending", collaboration.nextAction));
      continue;
    }
    const fingerprint = recoveryStrategyForRequest(request);
    if (fingerprint && blockedFingerprints.has(fingerprint)) {
      rejected.push(recoveryRequestRejection(request, "recovery_strategy_repeated", "This exact acquisition or runtime strategy already failed. Choose a materially different manager, source, tool, or execution path and use its real result."));
      continue;
    }
    if (pending.length && isRecoveryWanderingRequest(request) && !isCapabilityActivationRequest(request, pending)) {
      rejected.push(recoveryRequestRejection(request, "acquired_capability_must_be_used", `A previously acquired capability is still unused (${pending.map((item) => item.label).join("; ")}). Use it for a concrete artifact, build, repair, or verification action before further broad discovery or acquisition.`));
      continue;
    }
    accepted.push(request);
  }
  return { accepted, rejected };
}

function requestIsMaterialExecution(request = {}) {
  const tool = String(request.tool || "").trim().toLowerCase().replace(/-/g, "_");
  if (["install_package", "provision_tool", "skill_install", "mcp_install_npm", "create_archive", "extract_archive", "run_tests"].includes(tool)) return true;
  if (tool === "workspace_edit") return ["write", "append", "replace", "move", "delete", "mkdir"].includes(String(request.action || "").toLowerCase());
  if (tool === "execute_command") return Boolean(String(request.command || "").trim());
  if (tool === "run_code") return Boolean(String(request.code || request.inputText || "").trim());
  if (tool === "git_operation") return !["status", "log", "show", "diff"].includes(String(request.action || "").toLowerCase());
  if (tool === "database_query") return !/^\s*(?:select|pragma|explain)\b/i.test(String(request.sql || ""));
  return false;
}

function recoveryStrategyForRequest(request = {}) {
  const tool = String(request.tool || "").trim().toLowerCase().replace(/-/g, "_");
  if (tool === "install_package") {
    return `install_package:${String(request.manager || request.packageManager || "default").toLowerCase()}:${normalizeRecoveryValue(request.packageName || request.package || request.name || request.query || "unknown-package")}`;
  }
  if (tool === "provision_tool") {
    const command = normalizeRecoveryValue(request.commandName || request.executable || request.toolName || request.name || request.query || "unknown-command");
    const source = normalizeRecoveryValue(request.packageId || request.downloadUrl || request.installCommand || request.discoverySourceUrl || "default-source");
    return `provision_tool:${command}:${source}`;
  }
  if (tool === "execute_command") {
    const result = { tool, command: request.command, status: "failed", result: { stderr: "" } };
    if (isDirectPackageInstall(result)) return `shell_package:${normalizeRecoveryValue(request.command || "package-install")}`;
  }
  return "";
}

function isRecoveryWanderingRequest(request = {}) {
  const tool = String(request.tool || "").trim().toLowerCase().replace(/-/g, "_");
  return new Set([
    "list_directory", "read_file", "search_files", "grep_content", "web_search", "fetch_url", "api_request",
    "skill_list", "skill_search", "mcp_search_npm", "mcp_list_tools", "mcp_list_resources", "mcp_list_prompts",
    "install_package", "provision_tool", "skill_install", "mcp_install_npm"
  ]).has(tool);
}

function isCapabilityActivationRequest(request = {}, pending = []) {
  const tool = String(request.tool || "").trim().toLowerCase().replace(/-/g, "_");
  if (["mcp_list_tools", "mcp_list_resources", "mcp_list_prompts"].includes(tool)) {
    const requestedServer = normalizeRecoveryValue(request.serverId || "");
    return pending.some((item) => item.tool === "mcp_install_npm" && (!requestedServer || item.references.includes(requestedServer)));
  }
  if (["skill_read", "skill_enable"].includes(tool)) {
    const requestedSkill = normalizeRecoveryValue(request.skillId || "");
    return pending.some((item) => item.tool === "skill_install" && requestedSkill && item.references.includes(requestedSkill));
  }
  return false;
}

function recoveryRequestRejection(request = {}, code, error) {
  return {
    id: String(request.id || `recovery:${makeRecoveryRequestId(request)}`),
    tool: String(request.tool || ""),
    status: "rejected",
    code,
    error,
    createdAt: new Date().toISOString()
  };
}

function makeRecoveryRequestId(request = {}) {
  return `${request.tool || "tool"}:${request.commandName || request.packageName || request.path || request.query || "request"}`
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function normalizeRecoveryValue(value) {
  return String(value || "").trim().replaceAll("\\", "/").toLowerCase().slice(0, 600);
}

function preservesVerifiedCheckpoint(state, toolResults, fileResults) {
  if (!["review", "complete"].includes(String(state?.phase || ""))) return false;
  if (fileResults.length || !toolResults.length) return false;
  return toolResults.every((item) => {
    if (item?.tool !== "process_control") return false;
    const action = String(item?.result?.action || item?.action || "").toLowerCase();
    return ["list", "status", "output", "resize", "stop"].includes(action);
  });
}

export function isDeliveryExecution(state) {
  return Boolean(
    state?.active
    && (state.taskContract?.mode === "delivery" || (state.phase && !["intake", "discussion"].includes(state.phase)))
  );
}

export function requiresWorkspaceExecution(state) {
  return isDeliveryExecution(state) && state.taskContract?.requiresWorkspace === true;
}

function applyTaskIntake(state, response = {}, session = {}) {
  const observedContract = inferContractFromObservedAction(response, session);
  if (response.status == null && !observedContract) return { delivery: false };
  const contract = normalizeTaskContract(response.task_contract) || observedContract;
  if (!contract) {
    retainMissingTaskContractForOwner(state, response);
    return { delivery: false, intakeRequired: true };
  }
  state.taskContract = contract;
  if (contract.mode === "discussion") {
    state.active = false;
    state.phase = "discussion";
    state.lastAction = "task_contract:discussion";
    state.lastError = "";
    state.nextAction = "Task intake recorded a discussion contract; normal group discussion may proceed.";
    return { delivery: false };
  }
  state.phase = "inspect";
  state.lastAction = "task_contract:delivery";
  state.lastError = "";
  state.nextAction = contract.nextAction
    || (contract.requiresWorkspace
      ? "Inspect only the minimum facts required, then perform the first real workspace mutation or command."
      : "Perform the first material action required by the recorded task contract.");
  return { delivery: true };
}

function retainMissingTaskContractForOwner(state, response = {}) {
  state.intakeAttempts = Number(state.intakeAttempts || 0) + 1;
  state.taskContract = undefined;
  state.active = true;
  state.phase = "intake";
  state.lastAction = "task_contract_missing";
  const status = String(response?.status || "missing");
  state.lastError = status === "unavailable"
    ? "The intake owner was unavailable before declaring a task contract."
    : "The intake owner responded without a valid task contract or completed tool/file evidence.";
  state.nextAction = "Return a complete task_contract now. Do not delegate, release other members, or restart planning. Explicitly choose mode=delivery or mode=discussion and include the objective, requirements, deliverables, completion criteria, and one concrete next action.";
}

export function normalizeTaskContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mode = String(value.mode || "").trim().toLowerCase();
  if (mode !== "delivery" && mode !== "discussion") return undefined;
  const objective = String(value.objective || "").trim().slice(0, 1200);
  const deliverables = normalizeContractTextList(value.deliverables);
  const completionCriteria = normalizeContractTextList(value.completion_criteria ?? value.completionCriteria);
  const nextAction = String(value.next_action ?? value.nextAction ?? "").trim().slice(0, 1200);
  const hasWorkspaceRequirement = Object.hasOwn(value, "requires_workspace") || Object.hasOwn(value, "requiresWorkspace");
  const hasVerificationRequirement = Object.hasOwn(value, "requires_verification") || Object.hasOwn(value, "requiresVerification");
  // A mode alone is not a semantic contract. Requiring these fields keeps an
  // invalid provider reply with no work evidence from releasing delivery ownership.
  if (!objective || !completionCriteria.length || !nextAction || !hasWorkspaceRequirement || !hasVerificationRequirement || (mode === "delivery" && !deliverables.length)) return undefined;
  return {
    mode,
    objective,
    requiresWorkspace: Boolean(value.requires_workspace ?? value.requiresWorkspace),
    requiresVerification: Boolean(value.requires_verification ?? value.requiresVerification),
    deliverables,
    completionCriteria,
    nextAction,
    collaboration: normalizeCollaborationRequirement(value.collaboration, value),
    source: String(value.source || "model_task_contract")
  };
}

function normalizeCollaborationRequirement(value, contract = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const required = Boolean(source.required ?? contract.requires_collaboration ?? contract.requiresCollaboration);
  const minimum = Number.parseInt(String(source.minimum_delegations ?? source.minimumDelegations ?? 1), 10);
  const types = normalizeContractTextList(source.types ?? source.delegation_types ?? source.delegationTypes)
    .map((item) => item.toLowerCase())
    .filter((item) => WORK_DELEGATION_TYPES.has(item));
  return {
    required,
    beforeFirstMutation: required && source.before_first_mutation !== false && source.beforeFirstMutation !== false,
    minimumDelegations: required ? Math.max(1, Math.min(8, Number.isFinite(minimum) ? minimum : 1)) : 0,
    types: [...new Set(types)],
    reason: String(source.reason || contract.collaboration_reason || contract.collaborationReason || "").trim().slice(0, 600)
  };
}

function inferContractFromObservedAction(response = {}, session = {}) {
  const toolResults = Array.isArray(session.toolExecutionResults) ? session.toolExecutionResults : [];
  const fileResults = Array.isArray(session.fileOperationExecutionResults) ? session.fileOperationExecutionResults : [];
  // Requests are only intentions. Intake can be inferred only after the
  // runtime records a real tool/file result, so a malformed reply cannot
  // escape the single-owner intake phase by merely proposing an action.
  if (!toolResults.length && !fileResults.length) return undefined;
  const workspaceMutationTools = new Set([
    "execute_command", "run_code", "install_package", "provision_tool",
    "create_archive", "extract_archive", "git_operation", "database_query"
  ]);
  return {
    mode: "delivery",
    objective: "",
    requiresWorkspace: fileResults.some(isWorkspaceMutation)
      || toolResults.some((result) => isWorkspaceMutation(result) || workspaceMutationTools.has(String(result?.tool || ""))),
    requiresVerification: toolResults.some((result) => ["run_tests", "run_code"].includes(String(result?.tool || ""))),
    deliverables: [],
    completionCriteria: [],
    nextAction: "",
    source: "observed_first_action"
  };
}

function canCompleteNonWorkspaceDelivery(state, response = {}) {
  return state.taskContract?.mode === "delivery"
    && state.taskContract.requiresWorkspace !== true
    && state.taskContract.requiresVerification !== true
    && response.status === "speak"
    && !(response.tool_requests || []).length
    && !(response.file_operations || []).length
    && state.checkpointEvidence.length > 0;
}

function isWorkspaceMutation(value = {}) {
  const action = String(value.action || value.op || "").toLowerCase();
  return String(value.tool || "") === "workspace_edit"
    && ["write", "append", "replace", "move", "delete", "mkdir"].includes(action);
}

function inferredLegacyDeliveryContract(state = {}) {
  return {
    mode: "delivery",
    objective: "",
    requiresWorkspace: true,
    requiresVerification: false,
    deliverables: [],
    completionCriteria: [],
    nextAction: String(state.nextAction || ""),
    source: "legacy_execution_state"
  };
}

function normalizeContractTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, 600)).slice(0, 12);
}

function formatTaskContract(contract) {
  if (!contract || contract.mode !== "delivery") return "";
  const outputs = contract.deliverables?.length ? contract.deliverables.join("; ") : "none recorded";
  const criteria = contract.completionCriteria?.length ? contract.completionCriteria.join("; ") : "none recorded";
  const collaboration = collaborationRequirementStatus({ taskContract: contract, ownership: {} });
  return [
    "[Recorded task contract]",
    `Objective: ${contract.objective || "not recorded"}`,
    `Deliverables: ${outputs}`,
    `Completion criteria: ${criteria}`,
    `Workspace required: ${contract.requiresWorkspace ? "yes" : "no"}; verification required: ${contract.requiresVerification ? "yes" : "no"}.`,
    collaboration.required
      ? `Collaboration required before completion: ${collaboration.minimumDelegations} evidence-backed delegation(s)${collaboration.types.length ? ` of type ${collaboration.types.join(", ")}` : ""}${contract.collaboration?.beforeFirstMutation ? "; before the first owner mutation when still possible" : ""}.`
      : ""
  ].join("\n");
}

/**
 * @deprecated Compatibility-only helper. Runtime orchestration must use the
 * intake owner's semantic task_contract and real execution evidence instead.
 */
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
  const explicitDirectiveDelivery = /\b(build|create|implement|write|modify|fix|generate|package|compile|assemble|install|delete|rename|move|commit|push|run|execute|test|validate|verify)\b|\u6784\u5efa|\u751f\u6210|\u5236\u4f5c|\u5f00\u53d1|\u5b9e\u73b0|\u7f16\u5199|\u5199\u5165|\u4fee\u6539|\u4fee\u590d|\u6253\u5305|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u63d0\u4ea4|\u63a8\u9001|\u8fd0\u884c|\u6267\u884c|\u6d4b\u8bd5|\u9a8c\u8bc1|\u6821\u9a8c/i;
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

const WORK_DELEGATION_TYPES = new Set(["research", "implementation", "unblocker"]);
const DEFAULT_RESEARCH_TOOLS = ["web_search", "fetch_url", "api_request", "list_directory", "read_file", "search_files", "grep_content", "search_context", "load_context"];

export function collaborationRequirementStatus(state = {}) {
  const requirement = state?.taskContract?.collaboration || {};
  const required = requirement.required === true;
  const minimumDelegations = required ? Math.max(1, Number(requirement.minimumDelegations || 1)) : 0;
  const types = Array.isArray(requirement.types) ? requirement.types.filter((item) => WORK_DELEGATION_TYPES.has(item)) : [];
  const ownership = normalizeOwnership(state.ownership, state);
  const completed = ownership.delegations.filter((item) => (
    WORK_DELEGATION_TYPES.has(item.type)
    && item.native === true
    && item.status === "completed"
    && item.ownerAcknowledged === true
    && Array.isArray(item.handoffEvidence)
    && item.handoffEvidence.some((evidence) => ["tool", "file"].includes(evidence?.kind))
    && (!types.length || types.includes(item.type))
  ));
  const pending = required && completed.length < minimumDelegations;
  const typeText = types.length ? ` of type ${types.join(", ")}` : "";
  const reason = requirement.reason || `The task contract requires ${minimumDelegations} native, evidence-backed delegated handoff(s)${typeText} before delivery can complete.`;
  return {
    required,
    beforeFirstMutation: requirement.beforeFirstMutation === true,
    minimumDelegations,
    types,
    completed: completed.length,
    pending,
    reason,
    nextAction: pending
      ? `${reason} The delivery owner must use native delegate_task for a narrow eligible subtask, wait for its concrete handoff evidence, acknowledge and integrate it, then rerun verification.`
      : ""
  };
}

export function activeDelegationForAgent(state, agent) {
  return workDelegationFor(state, agent);
}

function workDelegationFor(state, agent) {
  if (!state || !agent?.id) return undefined;
  const ownership = normalizeOwnership(state.ownership, state);
  return ownership.delegations.find((item) => (
    WORK_DELEGATION_TYPES.has(item.type)
    && item.assigneeId === agent.id
    && ["pending", "in_progress"].includes(item.status)
  ));
}

function pendingWorkDelegates(state, agents) {
  const byId = new Map((agents || []).filter((agent) => agent.enabled !== false).map((agent) => [agent.id, agent]));
  const ownership = normalizeOwnership(state.ownership, state);
  return ownership.delegations
    .filter((item) => WORK_DELEGATION_TYPES.has(item.type) && ["pending", "in_progress"].includes(item.status))
    .map((item) => byId.get(item.assigneeId))
    .filter(Boolean);
}

function hasOpenWorkDelegations(state) {
  const ownership = normalizeOwnership(state.ownership, state);
  return ownership.delegations.some((item) => WORK_DELEGATION_TYPES.has(item.type) && ["pending", "in_progress"].includes(item.status));
}

function hasUnacknowledgedWorkDelegations(state) {
  const ownership = normalizeOwnership(state.ownership, state);
  return ownership.delegations.some((item) => (
    WORK_DELEGATION_TYPES.has(item.type)
    && ["completed", "failed", "rejected", "superseded"].includes(item.status)
    && item.ownerAcknowledged !== true
  ));
}

export function hasPendingWorkDelegations(state) {
  return hasOpenWorkDelegations(state);
}

function registerOwnerDelegations(state, response = {}, agents = []) {
  const requested = Array.isArray(response?.task_delegations) ? response.task_delegations : [];
  if (!requested.length) return;
  const registered = response.__registeredTaskDelegationKeys || new Set();
  if (!response.__registeredTaskDelegationKeys) {
    Object.defineProperty(response, "__registeredTaskDelegationKeys", { value: registered, enumerable: false });
  }
  const ownership = state.ownership = normalizeOwnership(state.ownership, state);
  const assignees = new Map((agents || []).filter((agent) => agent?.enabled !== false).map((agent) => [agent.id, agent]));
  const added = [];
  for (const request of requested) {
    const type = String(request?.type || "").trim().toLowerCase();
    const assigneeId = String(request?.assignee_id || request?.assigneeId || "").trim();
    const task = String(request?.task || request?.question || "").trim().slice(0, 1200);
    const expectedEvidence = normalizeContractTextList(request?.expected_evidence ?? request?.expectedEvidence).slice(0, 8);
    const allowWorkspaceMutation = Boolean(request?.allow_workspace_mutation ?? request?.allowWorkspaceMutation);
    const allowedPaths = normalizeDelegationPaths(request?.allowed_paths ?? request?.allowedPaths);
    const allowedTools = normalizeDelegationTools(request?.allowed_tools ?? request?.allowedTools, type, allowWorkspaceMutation);
    const assignee = assignees.get(assigneeId);
    const key = delegationRequestKey({ type, assigneeId, task, expectedEvidence, allowedTools, allowedPaths, allowWorkspaceMutation });
    if (registered.has(key)) continue;
    registered.add(key);
    const native = hasNativeModelSource(request);
    if (!WORK_DELEGATION_TYPES.has(type) || !assigneeId || assigneeId === state.executorId || !task || !expectedEvidence.length || !assignee || (allowWorkspaceMutation && !allowedPaths.length)) {
      ownership.delegations.push({
        id: `delegation:rejected:${state.checkpointVersion}:${++state.delegationSequence}`,
        type: WORK_DELEGATION_TYPES.has(type) ? type : "invalid",
        checkpointVersion: state.checkpointVersion,
        createdAt: new Date().toISOString(),
        assignedBy: ownership.ownerId,
        assigneeId,
        assigneeName: assignee?.name || "",
        status: "rejected",
        result: "invalid_or_unavailable_delegation",
        native,
        ownerAcknowledged: false
      });
      continue;
    }
    const duplicate = ownership.delegations.some((item) => (
      WORK_DELEGATION_TYPES.has(item.type)
      && item.assigneeId === assigneeId
      && item.task === task
      && ["pending", "in_progress"].includes(item.status)
    ));
    if (duplicate) continue;
    const delegation = {
      id: `delegation:${state.checkpointVersion}:${++state.delegationSequence}:${assigneeId}`,
      type,
      checkpointVersion: state.checkpointVersion,
      createdAt: new Date().toISOString(),
      assignedBy: ownership.ownerId,
      assigneeId,
      assigneeName: assignee.name,
      task,
      expectedEvidence,
      allowedTools,
      allowedPaths,
      allowWorkspaceMutation,
      native,
      status: "pending",
      result: "",
      handoffEvidence: [],
      ownerAcknowledged: false
    };
    ownership.delegations.push(delegation);
    added.push(delegation);
  }
  ownership.delegations = ownership.delegations.slice(-40);
  if (added.length) {
    state.lastAction = `delegated:${added.map((item) => item.id).join(",")}`;
    state.nextAction = "Wait for the specifically delegated handoffs, then integrate their evidence yourself before advancing delivery.";
  }
}

function delegationRequestKey(value = {}) {
  return JSON.stringify({
    type: String(value.type || ""),
    assigneeId: String(value.assigneeId || ""),
    task: String(value.task || ""),
    expectedEvidence: value.expectedEvidence || [],
    allowedTools: value.allowedTools || [],
    allowedPaths: value.allowedPaths || [],
    allowWorkspaceMutation: Boolean(value.allowWorkspaceMutation)
  });
}

function completeWorkDelegation(state, delegation, agent, response = {}, session = {}) {
  const handoff = response?.delegation_handoff;
  const actualEvidence = collectDelegationEvidence(session, agent, delegation);
  const unavailable = ["unavailable", "error"].includes(String(response?.status || ""));
  if (unavailable) {
    delegation.status = "failed";
    delegation.result = String(response?.reason || "delegated_contributor_unavailable").slice(0, 600);
  } else if (!handoff || handoff.delegation_id !== delegation.id) {
    delegation.status = "failed";
    delegation.result = "missing_or_mismatched_delegation_handoff";
  } else if (!actualEvidence.length) {
    delegation.status = "failed";
    delegation.result = "missing_current_delegation_evidence";
    delegation.handoffEvidence = uniqueDelegationEvidence(
      (handoff.evidence || []).map((item) => ({ kind: "reported", detail: String(item).slice(0, 500) }))
    );
  } else {
    delegation.status = "completed";
    delegation.result = String(handoff.summary || "delegated_work_completed").slice(0, 600);
    delegation.handoffEvidence = uniqueDelegationEvidence([
      ...(handoff.evidence || []).map((item) => ({ kind: "reported", detail: String(item).slice(0, 500) })),
      ...actualEvidence
    ]);
  }
  delegation.ownerAcknowledged = false;
  state.lastAction = `delegation_handoff:${delegation.id}:${delegation.status}`;
  state.nextAction = hasOpenWorkDelegations(state)
    ? "Wait for the remaining delegated handoffs."
    : "Read every delegated handoff, use or correct its evidence, then continue the delivery as the owner.";
  if (delegation.status === "failed") {
    state.lastError = `Delegated ${delegation.type} work from ${agent.name} failed: ${delegation.result}`;
  }
}

export function acknowledgeOwnerDelegations(state, agent) {
  if (agent?.id !== state.executorId || !hasUnacknowledgedWorkDelegations(state)) return false;
  const ownership = state.ownership = normalizeOwnership(state.ownership, state);
  const handoffs = ownership.delegations.filter((item) => (
    WORK_DELEGATION_TYPES.has(item.type)
    && ["completed", "failed", "rejected", "superseded"].includes(item.status)
    && item.ownerAcknowledged !== true
  ));
  for (const delegation of handoffs) {
    delegation.ownerAcknowledged = true;
    delegation.acknowledgedBy = agent.id;
  }
  if (handoffs.length) {
    state.lastAction = `delegation_handoffs_received:${handoffs.map((item) => item.id).join(",")}`;
    state.nextAction = "Integrate the delegated evidence yourself. Repair gaps or perform the next material action; only the owner may advance or finalize the delivery.";
  }
  return handoffs.length > 0;
}

function collectDelegationEvidence(session = {}, agent = {}, delegation = {}) {
  const sourceId = String(agent.id || "");
  const toolEvidence = (session.toolExecutionResults || [])
    .filter((item) => item?.source_agent_id === sourceId && occurredAfterDelegation(item, delegation))
    .slice(-6)
    .map(checkpointEvidenceItem)
    .filter(Boolean)
    .map((item) => ({ kind: "tool", detail: `${item.tool}#${item.id} ${item.outcome || item.status}` }));
  const fileEvidence = (session.fileOperationExecutionResults || [])
    .filter((item) => item?.source_agent_id === sourceId && occurredAfterDelegation(item, delegation))
    .slice(-6)
    .map(checkpointEvidenceItem)
    .filter(Boolean)
    .map((item) => ({ kind: "file", detail: `${item.tool}#${item.id} ${item.outcome || item.status}` }));
  return [...toolEvidence, ...fileEvidence];
}

function occurredAfterDelegation(item = {}, delegation = {}) {
  const startedAt = Date.parse(String(delegation.createdAt || ""));
  const occurredAt = Date.parse(String(item.createdAt || ""));
  return Number.isFinite(startedAt) && Number.isFinite(occurredAt) && occurredAt >= startedAt;
}

function uniqueDelegationEvidence(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item?.kind || ""}\u001f${item?.detail || ""}`;
    if (!item?.detail || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

function normalizeDelegationTools(value, type, allowWorkspaceMutation) {
  const supplied = normalizeContractTextList(value).map((item) => item.toLowerCase().replace(/-/g, "_")).slice(0, 24);
  if (supplied.length) return supplied;
  if (type === "research") return DEFAULT_RESEARCH_TOOLS;
  return allowWorkspaceMutation ? ["workspace_edit", "read_file", "list_directory", "search_files", "grep_content", "run_code", "run_tests"] : DEFAULT_RESEARCH_TOOLS;
}

function normalizeDelegationPaths(value) {
  return normalizeContractTextList(value)
    .map((item) => item.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((item) => item && !item.startsWith("/") && !item.includes(".."))
    .slice(0, 16);
}

function formatDelegationHandoffsForOwner(state) {
  const ownership = normalizeOwnership(state?.ownership, state || {});
  const handoffs = ownership.delegations.filter((item) => (
    WORK_DELEGATION_TYPES.has(item.type)
    && ["completed", "failed", "rejected", "superseded"].includes(item.status)
  )).slice(-8);
  if (!handoffs.length) return "";
  return [
    "[Durable delegated handoffs]",
    ...handoffs.map((item) => {
      const evidence = (item.handoffEvidence || []).map((entry) => entry.detail).join(" | ");
      return `${item.id} (${item.type}, ${item.status}, from ${item.assigneeName || item.assigneeId}): ${item.result || "no summary"}${evidence ? ` Evidence: ${evidence}` : ""}`;
    })
  ].join("\n");
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
