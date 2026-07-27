import { callAgentResult } from "./modelClient.js";
import { buildFinalPrompt, buildRoundPrompt } from "./promptBuilder.js";
import { buildContextPromptSections, buildMemberContext, materializeContextReceipt } from "./contextBuilder.js";
import { hasValidFinalDecision, parseFinalDecision, parseRoundModelResult } from "./responseParser.js";
import { makeId, nowIso } from "./types.js";
import { isConsensusParticipant, scoreConsensus, shouldStop, updateUnresolvedObjections } from "./consensusEngine.js";
import { appendMemoryCandidates, listSessionHistoryCatalogue, readRecentGroupSessions, searchSessionContextArchive, writeContextArchive, writeGroupSession, writeSession } from "./storage.js";
import { assessBudgetUsage, assessSizeUsage } from "./tokenLimits.js";
import { appendSessionTranscriptChunk, readSummaryCache, updateDeterministicSummaries } from "./summaryCache.js";
import { appendProviderUsageSample, appendSessionUsage, estimateCost, estimateMemberAccruedCost, readProviderUsageCalibration } from "./usageStats.js";
import { appendAgentSemanticPublicMemories, appendSummarizerPublicMemories, formatPublicMemoriesForPrompt, rememberExplicitUserMemory } from "./publicMemory.js";
import { applyObjectionLedger, isReviewerLike } from "./objectionLedger.js";
import { computeFinalState } from "./finalState.js";
import { parseFileOperationProposals } from "./fileOperations.js";
import { executeReadListFileOperations } from "./fileOperationReader.js";
import { executeToolRequests } from "./toolRequests.js";
import { extractImportedProjectRoots, extractUserReferencedRoots } from "./fileTools.js";
import { runAutoFileOperations } from "./fileOperationAutoRunner.js";
import { enqueueFileOperationProposals } from "./fileOperationQueue.js";
import { readPrivateContextMessages } from "./privateChat.js";
import { normalizeFileAttachments } from "./attachments.js";
import { readTaskState, updateExecutionCheckpoint, updateTaskStateFromSession } from "./taskState.js";
import { discoverRuntimeEnvironment, formatRuntimeEnvironment } from "./runtimeEnvironment.js";
import { applyDeliverableVerification, enforceRequestedArtifactRequirements, verifyFinalDeliverables } from "./deliverableVerification.js";
import { formatEnabledSkillMetadataForPrompt, listEnabledSkillMetadata } from "./skillPacks.js";
import { capabilityEnabled } from "./capabilityPolicy.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createObservationCache, hasMaterialWorkspaceChange } from "./observationCache.js";
import { acknowledgeOwnerDelegations, activeDelegationForAgent, advanceExecutionState, collaborationRequirementStatus, createExecutionState, executionInstruction, gateDeliveryRecoveryToolRequests, hasPendingWorkDelegations, requiresWorkspaceExecution, selectExecutionAgents } from "./executionState.js";
import { nativeToolDefinitions } from "./nativeToolProtocol.js";
import { markNativeModelSource } from "./nativeToolProvenance.js";
import { readPublicEventHotCache } from "./publicEventJournal.js";
import { appendTaskRunEvent, createTaskRun, readTaskRun, recordTaskRunArtifactVerification, recordTaskRunFileEvidence, recordTaskRunToolAttempts, syncTaskRunFromSession } from "./taskRuntime.js";

export async function runCouncil(question, group, baseDir, options = {}) {
  let finalResult;
  for await (const event of runCouncilEvents(question, group, baseDir, options)) {
    if (event.type === "done") finalResult = event.result;
  }
  return finalResult;
}

export async function* runCouncilEvents(question, group, baseDir, options = {}) {
  const enabledAgents = group.agents.filter((agent) => agent.enabled);
  const attachments = normalizeFileAttachments(options.attachments || []);
  const importedProjectRoots = extractImportedProjectRoots(attachments);
  const userReferencedRoots = extractUserReferencedRoots({ text: question, attachments });
  const sessionStartMs = Date.now();
  const sessionStartedAt = nowIso();
  const workMode = normalizeWorkMode(group.settings?.workMode);
  const firstRoundAgents = selectFirstRoundAgents(enabledAgents, {
    startAfterAgentId: options.startAfterAgentId,
    startAtAgentId: options.startAtAgentId,
    workMode
  });
  const globalRequirement = options.globalRequirement || group.settings?.globalRequirement || "";
  const workspaceGroup = options.groupPath ? readWorkspaceGroup(options.groupPath) : undefined;
  const memoryEnabled = capabilityEnabled(options.appSettings, "memory");
  const recentGroupSessions = options.groupPath && memoryEnabled
    ? readRecentGroupSessions(options.groupPath, { limit: 12 })
    : [];
  const automaticContinuationSource = isContinuationRequest(question)
    ? selectAutomaticContinuationSource(recentGroupSessions)
    : undefined;
  const continuationContext = normalizeContinuationContext(options.continuationContext)
    || (options.groupPath && memoryEnabled && automaticContinuationSource
      ? buildAutomaticContinuationContext(automaticContinuationSource)
      : null);
  const continuationTaskRun = options.groupPath && continuationContext?.taskRunId
    ? readTaskRun(options.groupPath, continuationContext.taskRunId)
    : undefined;
  const authorizedProjectRoots = [...new Set([
    ...importedProjectRoots,
    ...userReferencedRoots,
    ...continuationAuthorizedProjectRoots(continuationContext, automaticContinuationSource)
  ])];
  const executionQuestion = continuationContext?.previousQuestion || question;
  const excludedLegacyContinuationIds = automaticContinuationSource
    ? recentGroupSessions.filter(isLegacyContinuationShell).map((session) => session.id)
    : [];
  let taskState = options.groupPath && memoryEnabled ? readTaskState(options.groupPath) : undefined;
  let contextInvalidations = mergeContextInvalidations(taskState?.invalidations, options.contextInvalidations);
  const runtimeDiscoveryOptions = { managedToolRoots: [path.join(baseDir, "tools")] };
  const runtimeEnvironment = formatRuntimeEnvironment(discoverRuntimeEnvironment(options.groupPath || baseDir, runtimeDiscoveryOptions));
  const retrievedContext = options.groupPath && memoryEnabled
    ? searchSessionContextArchive(options.groupPath, [
      options.latestBossInstruction,
      continuationContext?.previousQuestion,
      continuationContext?.finalAnswer,
      continuationContext ? "" : question
    ].filter(Boolean).join("\n"), {
      limit: options.contextSearchLimit || group.settings?.contextSearchLimit || 5,
      excludeSessionIds: excludedLegacyContinuationIds
    })
    : [];
  const historyCatalogue = options.groupPath && memoryEnabled
    ? listSessionHistoryCatalogue(options.groupPath, {
      limit: group.settings?.historyCatalogueLimit || 12,
      excludeSessionIds: excludedLegacyContinuationIds
    })
    : [];
  const publicEventHotCache = options.groupPath && memoryEnabled
    ? readPublicEventHotCache(options.groupPath, {
      limit: group.settings?.publicEventHotCacheLimit || 12,
      excludeSessionIds: excludedLegacyContinuationIds
    })
    : { events: [] };
  const session = {
    id: makeId("session"),
    question,
    createdAt: sessionStartedAt,
    startedAt: sessionStartedAt,
    continuationContext,
    groupId: group.id,
    authorizedProjectRoots,
    groupSnapshot: redactGroupForSession(group),
    status: "running",
    activeAgentIds: firstRoundAgents.map((agent) => agent.id),
    unresolvedObjections: {},
    consensusByRound: [],
    artifacts: [],
    fileOperationProposals: [],
    fileOperationExecutionResults: [],
    toolExecutionResults: [],
    toolRequests: [],
    rejectedToolRequests: [],
    contextRetrievalResults: retrievedContext,
    contextReceipts: [],
    contextInvalidationUpdates: [],
    semanticMemoryUpdates: [],
    contextInvalidations,
    rejectedFileOperationProposals: [],
    pendingFileOperationProposals: [],
    modelCallCount: 0,
    modelCallBudget: Number(group.settings.maxModelCalls || 0),
    guardStopReason: "",
    finalizationStatus: { status: "pending", reason: "" },
    messages: [],
    interimMessages: [],
    executionState: createExecutionState({
      question: executionQuestion,
      agents: enabledAgents,
      workspaceGroup,
      previousState: continuationTaskRun?.execution?.active
        ? continuationTaskRun.execution
        : automaticContinuationSource?.executionState
        || (isContinuationRequest(question) ? taskState?.executionCheckpoint : undefined)
    })
  };
  session.taskRun = options.groupPath && session.executionState.active
    ? createTaskRun({
      groupPath: options.groupPath,
      session,
      question: executionQuestion,
      authorizedProjectRoots,
      attachments,
      parentTaskRunId: continuationContext?.taskRunId || "",
      resumeTaskRunId: continuationContext?.taskRunId || ""
    })
    : null;
  session.explicitMemoryUpdate = persistExplicitUserMemory(options.groupPath, question, {
    appSettings: options.appSettings,
    sourceSessionId: session.id,
    createdAt: sessionStartedAt
  });
  const observationCache = createObservationCache();

  // The history API reads this file directly, so update it only at real event boundaries.
  const persistRunningSession = () => {
    if (!options.groupPath) return undefined;
    if (session.taskRun) {
      session.taskRun = syncTaskRunFromSession({
        groupPath: options.groupPath,
        taskRun: session.taskRun,
        session
      });
    }
    session.durationMs = elapsedMs(sessionStartMs);
    return writeGroupSession(session, options.groupPath);
  };
  const refreshExecutionCheckpoint = () => {
    const updated = updateExecutionCheckpoint(options.groupPath, session);
    if (updated) taskState = updated;
    return updated;
  };
  const recordContextInvalidationDeclarations = (response, memberContext, agent, round, phase) => {
    const accepted = acceptContextInvalidationDeclarations({
      declarations: response?.context_invalidations,
      memberContext,
      session,
      agent,
      round,
      phase
    });
    if (!accepted.length) return [];
    contextInvalidations = mergeContextInvalidations(contextInvalidations, accepted);
    session.contextInvalidations = contextInvalidations;
    const update = {
      id: makeId("context_invalidation"),
      createdAt: nowIso(),
      phase,
      round,
      agentId: agent.id,
      agentName: agent.name,
      accepted
    };
    session.contextInvalidationUpdates.push(update);
    if (options.groupPath && session.taskRun?.id) {
      appendTaskRunEvent(options.groupPath, session.taskRun.id, "context_invalidation_recorded", {
        id: update.id,
        createdAt: update.createdAt,
        phase,
        round,
        agentId: agent.id,
        agentName: agent.name,
        invalidations: accepted.map(compactContextInvalidation)
      });
    }
    persistRunningSession();
    return accepted;
  };
  const persistInterruptedSession = () => {
    if (session.status !== "running") return;
    session.status = "interrupted";
    session.interruptionReason = abortReasonCode(options.signal);
    session.completedAt = nowIso();
    persistRunningSession();
  };
  options.signal?.addEventListener("abort", persistInterruptedSession, { once: true });
  persistRunningSession();

  let consensus = scoreConsensus(enabledAgents, session);
  const maxRounds = normalizeMaxRounds(group.settings.maxRounds);
  for (let round = 1; round <= maxRounds; round += 1) {
    const agentsToCall = selectAgents(enabledAgents, session, round, firstRoundAgents);
    const results = [];

    for (const agent of agentsToCall) {
      throwIfAborted(options.signal);
      const agentStartMs = Date.now();
      const agentStartedAt = nowIso();
      const seat = findWorkspaceSeat(workspaceGroup, agent);
      const transcriptVisibility = contextVisibilityForAgent(agent, workMode);
      if (acknowledgeOwnerDelegations(session.executionState, agent)) {
        refreshExecutionCheckpoint();
        persistRunningSession();
      }
      let executionDirective = executionInstruction(session.executionState, agent);
      const memberContext = buildMemberContext(agent, session, {
        question,
        groupSettings: group.settings,
        globalRequirement,
        continuationContext,
        transcriptVisibility,
        latestBossInstruction: [options.latestBossInstruction, executionDirective].filter(Boolean).join("\n\n"),
        attachments,
        taskState,
        retrievedContext,
        historyCatalogue,
        publicEventHotCache,
        enabledSkills: loadEnabledSkills(baseDir, options.groupPath, options.appSettings),
        ...loadSummaryContext(options.groupPath, agent, options.appSettings),
        privateBossMessages: loadPrivateBossMessages(options.groupPath, agent, options.appSettings),
        contextInvalidations,
        providerUsageCalibration: loadProviderUsageCalibration(options.groupPath, agent)
      });
      const contextStatus = summarizeContextStatus(memberContext, {
        groupPath: options.groupPath,
        seat,
        agent
      });
      yield {
        type: "agent_start",
        round,
        agentId: agent.id,
        agentName: agent.name,
        contextStatus,
        taskRun: taskRunSnapshot(session.taskRun),
        createdAt: agentStartedAt
      };

      if (memberContext.coreOverflow) {
        const overflowReason = contextOverflowReason(contextStatus);
        session.guardStopReason ||= overflowReason;
        const message = buildUnavailableMessage(agent, round, overflowReason, contextStatus, {
          startedAt: agentStartedAt,
          durationMs: elapsedMs(agentStartMs)
        });
        results.push(message);
        session.messages.push(message);
        recordObjections(session, agent, message.response, round, group.settings);
        persistRunningSession();
        yield {
          type: "agent_message",
          message,
          createdAt: message.createdAt
        };
        continue;
      }

      const budgetBlockReason = limitBlockReason(memberContext, contextStatus, {
        groupPath: options.groupPath,
        seat,
        agent
      });
      if (budgetBlockReason) {
        const message = buildUnavailableMessage(agent, round, budgetBlockReason, contextStatus, {
          startedAt: agentStartedAt,
          durationMs: elapsedMs(agentStartMs)
        });
        results.push(message);
        session.messages.push(message);
        recordObjections(session, agent, message.response, round, group.settings);
        persistRunningSession();
        yield {
          type: "agent_message",
          message,
          createdAt: message.createdAt
        };
        continue;
      }

      const fileOperationPermissionTier = effectiveWorkspacePermissionTier(workspaceGroup, agent);
      const promptOptions = {
        globalRequirement,
        resumeInstruction: options.startAtAgentId === agent.id ? options.resumeInstruction : "",
        fileOperationContext: Boolean(options.groupPath),
        fileOperationPermissionTier,
        groupSettings: group.settings,
        independentAnswerMode: transcriptVisibility === "own",
        hideOpenObjectionLedger: transcriptVisibility === "own",
        runtimeEnvironment,
        appSettings: options.appSettings
      };
      const messages = buildRoundPrompt(agent, question, session, round, {
        ...promptOptions,
        contextSections: buildContextPromptSections(memberContext)
      });
      const captureSemanticMemory = (currentResponse, phase) => {
        if (!Array.isArray(currentResponse?.memory_candidates) || !currentResponse.memory_candidates.length) return undefined;
        const update = persistAgentSemanticPublicMemory(options.groupPath, currentResponse?.memory_candidates, {
          appSettings: options.appSettings,
          sourceText: question,
          sessionId: session.id,
          agent,
          createdAt: nowIso()
        });
        session.semanticMemoryUpdates.push({ phase, round, agentId: agent.id, ...update });
        return update;
      };
      let callOutcome = yield* callRoundModel({
        options,
        session,
        phase: "round",
        round,
        agent,
        memberContext,
        messages,
        timeoutMs: group.settings.agentTimeoutMs,
        nativeToolPermissionTier: fileOperationPermissionTier
      });
      let response = applyRoundResponseRules(callOutcome.response, agent, round);
      captureSemanticMemory(response, "round");
      recordContextInvalidationDeclarations(response, memberContext, agent, round, "round");
      let rawTextForMessage = callOutcome.rawTextForMessage;
      let errorForMessage = callOutcome.errorForMessage;
      let nativeToolConversation;
      const accumulatedToolRequests = [];
      const accumulatedToolResults = [];
      const accumulatedRejectedToolRequests = [];
      const accumulatedFileOperationProposals = [];
      const accumulatedFileOperationExecutionResults = [];
      const accumulatedPendingFileOperationProposals = [];
      const accumulatedRejectedFileOperationProposals = [];
      const maxToolIterations = normalizeMaxToolIterations(group.settings.maxToolIterations);
      let toolIterations = 0;
      let consecutiveStagnantToolLoops = 0;
      const seenToolTargets = new Set();
      const processResponseFileOperations = (currentResponse) => {
        const fileOperationResult = applyFilePermissionTier(
          applyCollaborationFileScope(
            applyDelegationFileScope(
              collectFileOperationProposals(currentResponse, agent, round, options.groupPath),
              activeDelegationForAgent(session.executionState, agent)
            ),
            session.executionState,
            agent
          ),
          fileOperationPermissionTier,
          options.appSettings
        );
        if (!fileOperationResult.accepted.length && !fileOperationResult.rejected.length) return;
        session.fileOperationProposals.push(...fileOperationResult.accepted);
        const readListResults = executeReadListFileOperations(options.groupPath, fileOperationResult.accepted, { observationCache });
        session.fileOperationExecutionResults.push(...readListResults);
        const queueResult = queueFileOperationProposals(fileOperationResult, options.groupPath);
        session.pendingFileOperationProposals.push(...queueResult.queued);
        session.rejectedFileOperationProposals.push(...queueResult.rejected);
        const autoFileExecutionResults = executeRoundAutoFileOperations({
          groupPath: options.groupPath,
          currentSession: session,
          transcriptVisibility,
          session,
          group: workspaceGroup || group,
          permissionTier: fileOperationPermissionTier,
          appSettings: options.appSettings
        });
        if (autoFileExecutionResults.some(hasMaterialWorkspaceChange)) {
          observationCache.invalidate("file_operation_mutation");
        }
        accumulatedFileOperationProposals.push(...fileOperationResult.accepted);
        accumulatedFileOperationExecutionResults.push(...readListResults, ...autoFileExecutionResults);
        accumulatedPendingFileOperationProposals.push(...queueResult.queued);
        accumulatedRejectedFileOperationProposals.push(...fileOperationResult.rejected, ...queueResult.rejected);
        if (session.taskRun && (readListResults.length || autoFileExecutionResults.length)) {
          recordTaskRunFileEvidence({
            groupPath: options.groupPath,
            taskRun: session.taskRun,
            agent,
            round,
            results: [...readListResults, ...autoFileExecutionResults]
          });
        }
        if (agent.id === session.executionState?.executorId) {
          advanceExecutionState({
            state: session.executionState,
            session,
            agent,
            groupPath: options.groupPath,
            question: executionQuestion,
            response: currentResponse
          });
          refreshExecutionCheckpoint();
          executionDirective = executionInstruction(session.executionState, agent);
        }
      };

      // Record a model-declared contract before executing any same-turn tool
      // or legacy file-operation request. This lets an explicit collaboration
      // prerequisite guard the owner's first material action as well as final
      // completion; it does not infer collaboration from member names.
      const establishTaskContractBeforeActions = (currentResponse) => {
        if (
          agent.id !== session.executionState?.executorId
          || session.executionState?.phase !== "intake"
          || !currentResponse?.task_contract
        ) return;
        advanceExecutionState({
          state: session.executionState,
          session,
          agent,
          groupPath: options.groupPath,
          question: executionQuestion,
          response: {
            ...currentResponse,
            tool_requests: [],
            file_operations: []
          }
        });
        refreshExecutionCheckpoint();
        executionDirective = executionInstruction(session.executionState, agent);
      };

      const registerNativeDelegation = async (request, provenance = {}) => {
        if (agent.id !== session.executionState?.executorId) {
          return { ok: false, code: "delegation_owner_required", error: "Only the durable delivery owner can create a bounded delegation." };
        }
        const delegation = {
          type: String(request.delegationType || "").trim().toLowerCase(),
          assignee_id: String(request.assigneeId || "").trim(),
          task: String(request.delegationTask || "").trim(),
          expected_evidence: Array.isArray(request.expectedEvidence) ? request.expectedEvidence : [],
          allowed_tools: Array.isArray(request.allowedTools) ? request.allowedTools : [],
          allow_workspace_mutation: request.allowWorkspaceMutation === true,
          allowed_paths: Array.isArray(request.allowedPaths) ? request.allowedPaths : []
        };
        if (!delegation.type || !delegation.assignee_id || !delegation.task || !delegation.expected_evidence.length) {
          return { ok: false, code: "invalid_delegation_request", error: "delegate_task needs delegationType, assigneeId, task, and expectedEvidence." };
        }
        if (provenance.nativeToolCall === true) markNativeModelSource(delegation);
        response.task_delegations = [...(response.task_delegations || []), delegation];
        advanceExecutionState({
          state: session.executionState,
          session,
          agent,
          groupPath: options.groupPath,
          question: executionQuestion,
          response
        });
        refreshExecutionCheckpoint();
        executionDirective = executionInstruction(session.executionState, agent);
        const registered = (session.executionState?.ownership?.delegations || []).find((item) => (
          item.assignedBy === agent.id
          && item.assigneeId === delegation.assignee_id
          && item.task === delegation.task
          && item.status === "pending"
        ));
        if (!registered) {
          return { ok: false, code: "delegation_rejected", error: "The requested delegation was rejected by the ownership boundary." };
        }
        return {
          ok: true,
          delegationId: registered.id,
          assigneeId: registered.assigneeId,
          nextAction: "Wait for this contributor handoff before the owner advances final delivery."
        };
      };

      establishTaskContractBeforeActions(response);
      if (!ownerRequestedDelegation(response, session.executionState, agent)) {
        processResponseFileOperations(response);
      }

      if (response.status === "speak" && !response.tool_requests?.length && accumulatedRejectedFileOperationProposals.length) {
        const rejectedAttempt = buildInterimModelMessage({
          session,
          phase: "file_operation_rejected",
          round,
          agent,
          toolIteration: 0,
          rawText: rawTextForMessage,
          response
        });
        session.interimMessages.push(rejectedAttempt);
        yield {
          type: "agent_interim",
          round,
          agentId: agent.id,
          agentName: agent.name,
          message: rejectedAttempt,
          createdAt: rejectedAttempt.createdAt
        };
        const rejectionDetails = accumulatedRejectedFileOperationProposals
          .map((item) => `${item.code || item.status || "rejected"}: ${item.reason || item.autoExecutionReason || "file operation rejected"}`)
          .join("; ")
          .slice(0, 1600);
        const collaborationRecovery = collaborationRequirementStatus(session.executionState);
        callOutcome = yield* callRoundModel({
          options,
          session,
          phase: "file_operation_recovery",
          round,
          agent,
          memberContext,
          messages: [...messages, {
            role: "user",
            content: collaborationRecovery.pending && collaborationRecovery.beforeFirstMutation
              ? `Your file operation did not execute: ${rejectionDetails}. Do not write the artifact yet. ${collaborationRecovery.nextAction}`
              : `Your file operation did not execute: ${rejectionDetails}. Correct it now with a real non-empty workspace_edit native tool call (or tool_requests fallback), then continue to build or verify. Do not return another plan or placeholder.`
          }],
          timeoutMs: group.settings.agentTimeoutMs,
          toolIteration: 0,
          nativeToolPermissionTier: fileOperationPermissionTier,
          nativeToolChoice: fileOperationPermissionTier === "full" ? "required" : "auto"
        });
        response = applyRoundResponseRules(callOutcome.response, agent, round);
        captureSemanticMemory(response, "file_operation_recovery");
        recordContextInvalidationDeclarations(response, memberContext, agent, round, "file_operation_recovery");
        rawTextForMessage = callOutcome.rawTextForMessage;
        errorForMessage = callOutcome.errorForMessage;
        processResponseFileOperations(response);
      }

      while (response.status === "speak" && response.tool_requests?.length && toolIterations < maxToolIterations) {
        const nativeToolTurn = nativeToolTurnFromResponse(callOutcome, response);
        if (nativeToolTurn) {
          nativeToolConversation ||= { baseMessageCount: messages.length, turns: [] };
        } else {
          // Text-JSON tool requests use the existing context path. Mixing the
          // two protocols in one follow-up would create an invalid provider
          // transcript, so restart native history at this boundary.
          nativeToolConversation = undefined;
        }
        toolIterations += 1;
        const requestedToolTimeoutMs = positiveDuration(group.settings.toolTimeoutMs);
        const ownerDelegationTurn = ownerRequestedDelegation(response, session.executionState, agent);
        const allRequestedTools = response.tool_requests || [];
        const deferredForDelegation = ownerDelegationTurn
          ? allRequestedTools.filter((request) => String(request?.tool || "").trim().toLowerCase() !== "delegate_task")
            .map((request) => deferredToolRequestForDelegation(request))
          : [];
        const executableRequests = ownerDelegationTurn
          ? allRequestedTools.filter((request) => String(request?.tool || "").trim().toLowerCase() === "delegate_task")
          : allRequestedTools;
        const recoveryGate = gateDeliveryRecoveryToolRequests(session.executionState, agent, executableRequests);
        const executedToolResult = await executeToolRequests({
          requests: recoveryGate.accepted,
          permissionTier: fileOperationPermissionTier,
          agent,
          round,
          baseDir,
          timeoutMs: requestedToolTimeoutMs,
          groupPath: options.groupPath,
          importedProjectRoots: fileOperationPermissionTier === "full"
            ? authorizedProjectRoots
            : importedProjectRoots,
          appSettings: options.appSettings,
          searchApiKey: options.searchApiKey,
          allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork),
          allowHttp: Boolean(options.allowHttp),
          maxReadBytes: group.settings.maxToolReadBytes,
          maxGrepResults: group.settings.maxToolGrepResults,
          maxGrepFileBytes: group.settings.maxToolGrepFileBytes,
          maxCommandOutputBytes: group.settings.maxToolOutputBytes,
          maxGitOutputBytes: group.settings.maxToolOutputBytes,
          maxWorkspaceSnapshotEntries: group.settings.maxWorkspaceSnapshotEntries,
          maxWorkspaceChanges: group.settings.maxWorkspaceChanges,
          managedToolRoots: runtimeDiscoveryOptions.managedToolRoots,
          onToolEvent: options.onToolEvent,
          signal: options.signal,
          observationCache,
          previousResults: [
            ...session.toolExecutionResults.filter((item) => item.source_agent_id === agent.id),
            ...continuationVerifiedToolResults(continuationContext)
          ],
          delegation: activeDelegationForAgent(session.executionState, agent),
          blockVerifiedContinuationCommands: Boolean(continuationContext && isPlainContinuationRequest(question)),
          delegateTaskTool: registerNativeDelegation
        });
        const toolResult = {
          ...executedToolResult,
          rejected: [...recoveryGate.rejected, ...executedToolResult.rejected, ...deferredForDelegation],
          events: [
            ...recoveryGate.rejected.map((item) => ({
              type: "tool_failure",
              id: item.id,
              tool: item.tool,
              round,
              agentId: agent.id,
              agentName: agent.name,
              status: item.status,
              code: item.code,
              error: item.error,
              createdAt: item.createdAt
            })),
            ...executedToolResult.events,
            ...deferredForDelegation.map((item) => ({
              type: "tool_failure",
              id: item.id,
              tool: item.tool,
              round,
              agentId: agent.id,
              agentName: agent.name,
              status: item.status,
              code: item.code,
              error: item.error,
              createdAt: item.createdAt
            }))
          ]
        };
        accumulatedToolRequests.push(...toolResult.accepted);
        accumulatedToolResults.push(...toolResult.results);
        accumulatedRejectedToolRequests.push(...toolResult.rejected);
        session.toolRequests.push(...toolResult.accepted);
        session.toolExecutionResults.push(...toolResult.results);
        session.rejectedToolRequests.push(...toolResult.rejected);
        if (nativeToolTurn) {
          nativeToolConversation.turns.push({
            ...nativeToolTurn,
            toolResults: [...toolResult.results, ...toolResult.rejected]
          });
        }
        if (session.taskRun) {
          recordTaskRunToolAttempts({
            groupPath: options.groupPath,
            taskRun: session.taskRun,
            agent,
            round,
            iteration: toolIterations,
            accepted: toolResult.accepted,
            results: toolResult.results,
            rejected: toolResult.rejected
          });
        }
        if (agent.id === session.executionState?.executorId) {
          advanceExecutionState({
            state: session.executionState,
            session,
            agent,
            groupPath: options.groupPath,
            question: executionQuestion,
            response
          });
          refreshExecutionCheckpoint();
          executionDirective = executionInstruction(session.executionState, agent);
        }
        const ownerMustWaitForDelegation = agent.id === session.executionState?.executorId
          && hasPendingWorkDelegations(session.executionState);
        persistRunningSession();
        if (session.taskRun) {
          yield {
            type: "task_run",
            taskRun: taskRunSnapshot(session.taskRun),
            createdAt: nowIso()
          };
        }
        for (const event of toolResult.events || []) {
          yield event;
        }

        if (ownerMustWaitForDelegation) {
          response = {
            ...response,
            tool_requests: [],
            argument: "The bounded delegation is active. Wait for the contributor's durable handoff before writing, building, validating, or finalizing the delivery."
          };
          rawTextForMessage = "";
          errorForMessage = "";
          break;
        }

        if (hasReachedVerificationCheckpoint(session, agent)) {
          response = buildVerificationCheckpointHandoff(session.executionState);
          rawTextForMessage = "";
          errorForMessage = "";
          break;
        }

        if (!toolResult.results.length && !toolResult.rejected.length) break;

        const toolLoopStagnated = updateStagnantToolLoopCount({
          requests: toolResult.accepted,
          results: toolResult.results,
          rejected: toolResult.rejected,
          current: consecutiveStagnantToolLoops,
          seenTargets: seenToolTargets,
          history: accumulatedToolResults,
          capabilityReady: hasPersistedAcquiredCapability(options.groupPath)
        });
        consecutiveStagnantToolLoops = toolLoopStagnated.count;

        const toolFollowupInstruction = buildToolFollowupInstruction(accumulatedToolResults, accumulatedRejectedToolRequests);
        const recoveryInstruction = toolLoopStagnated.recoveryRequired
          ? buildStagnantToolLoopRecoveryInstruction(agent, question, toolFollowupInstruction, session.executionState)
          : toolFollowupInstruction;
        const followupContext = buildMemberContext(agent, session, {
          question,
          groupSettings: group.settings,
          globalRequirement,
          continuationContext,
          transcriptVisibility,
          latestBossInstruction: [recoveryInstruction, executionDirective].filter(Boolean).join("\n\n"),
          attachments,
          taskState,
          retrievedContext,
          historyCatalogue,
          publicEventHotCache,
          enabledSkills: loadEnabledSkills(baseDir, options.groupPath, options.appSettings),
          ...loadSummaryContext(options.groupPath, agent, options.appSettings),
          privateBossMessages: loadPrivateBossMessages(options.groupPath, agent, options.appSettings),
          contextInvalidations,
          providerUsageCalibration: loadProviderUsageCalibration(options.groupPath, agent),
          currentTurnToolResults: toolResult.results,
          currentTurnRejectedToolRequests: toolResult.rejected
        });
        if (followupContext.coreOverflow) {
          const overflowReason = contextOverflowReason(summarizeContextStatus(followupContext, {
            groupPath: options.groupPath,
            seat,
            agent
          }));
          session.guardStopReason ||= overflowReason;
          response = {
            status: "unavailable",
            reason: overflowReason,
            retryable: false,
            objections: [overflowReason],
            memory_candidates: []
          };
          rawTextForMessage = "";
          errorForMessage = overflowReason;
          break;
        }
        const followupMessages = buildRoundPrompt(agent, question, session, round, {
          ...promptOptions,
          runtimeEnvironment: formatRuntimeEnvironment(discoverRuntimeEnvironment(options.groupPath || baseDir, {
            ...runtimeDiscoveryOptions,
            refresh: true
          })),
          resumeInstruction: recoveryInstruction,
          contextSections: buildContextPromptSections(followupContext),
        });
        const continuingNatively = Boolean(nativeToolConversation?.turns.length);
        const providerFollowupMessages = continuingNatively
          ? [...messages, {
            role: "user",
            content: buildNativeToolContinuationInstruction(recoveryInstruction, executionDirective)
          }]
          : followupMessages;
        callOutcome = yield* callRoundModel({
          options,
          session,
          phase: toolLoopStagnated.recoveryRequired ? "tool_stagnation_recovery" : "tool_followup",
          round,
          agent,
          memberContext: followupContext,
          messages: providerFollowupMessages,
          timeoutMs: group.settings.agentTimeoutMs,
          toolIteration: toolIterations,
          nativeToolConversation: continuingNatively ? nativeToolConversation : undefined,
          nativeToolPermissionTier: fileOperationPermissionTier,
          nativeToolChoice: toolLoopStagnated.recoveryRequired && fileOperationPermissionTier === "full" && !isReviewerLike(agent)
            ? "required"
            : "auto"
        });
        response = applyRoundResponseRules(callOutcome.response, agent, round);
        captureSemanticMemory(response, toolLoopStagnated.recoveryRequired ? "tool_stagnation_recovery" : "tool_followup");
        recordContextInvalidationDeclarations(response, followupContext, agent, round, toolLoopStagnated.recoveryRequired ? "tool_stagnation_recovery" : "tool_followup");
        rawTextForMessage = callOutcome.rawTextForMessage;
        errorForMessage = callOutcome.errorForMessage;
        if (toolLoopStagnated.recoveryRequired && isReviewerLike(agent) && response.tool_requests?.length) {
          nativeToolConversation = undefined;
          callOutcome = yield* callRoundModel({
            options,
            session,
            phase: "tool_stagnation_review_recovery",
            round,
            agent,
            memberContext: followupContext,
            messages: [...followupMessages, {
              role: "user",
              content: "Your review stagnated and you requested more tools again. Do not call any tool. Respond now with a concrete review conclusion, objection, or skip based only on the evidence already returned."
            }],
            timeoutMs: group.settings.agentTimeoutMs,
            toolIteration: toolIterations,
            nativeToolPermissionTier: fileOperationPermissionTier,
            nativeToolChoice: "auto"
          });
          response = applyRoundResponseRules(callOutcome.response, agent, round);
          captureSemanticMemory(response, "tool_stagnation_review_recovery");
          recordContextInvalidationDeclarations(response, followupContext, agent, round, "tool_stagnation_review_recovery");
          rawTextForMessage = callOutcome.rawTextForMessage;
          errorForMessage = callOutcome.errorForMessage;
          if (response.tool_requests?.length) {
            session.toolContinuation = {
              agentId: agent.id,
              round,
              completedIterations: toolIterations,
              reason: "stagnation_recovery_reviewer_requested_more_tools",
              pendingRequests: response.tool_requests
            };
            response = {
              status: "speak",
              argument: "Reviewer stagnation recovery did not produce a tool-free conclusion.",
              objections: ["stagnation_recovery_reviewer_requested_more_tools"],
              confidence: 0,
              memory_candidates: []
            };
          }
        }
        if (toolLoopStagnated.recoveryRequired && requiresStagnationWorkspaceEdit(agent, question, fileOperationPermissionTier, session.executionState) && !hasMaterialExecutionRequest(response)) {
          nativeToolConversation = undefined;
          callOutcome = yield* callRoundModel({
            options,
            session,
            phase: "tool_stagnation_action_recovery",
            round,
            agent,
            memberContext: followupContext,
            messages: [...followupMessages, {
              role: "user",
              content: "Your stagnation recovery did not include a workspace_edit or another material execution action. Stop reading, searching, listing, or planning. Call a real tool now to write or repair the artifact, acquire and use a missing capability, run the required build or generator, or verify an already-correct deliverable."
            }],
            timeoutMs: group.settings.agentTimeoutMs,
            toolIteration: toolIterations,
            nativeToolPermissionTier: fileOperationPermissionTier,
            nativeToolChoice: "required"
          });
          response = applyRoundResponseRules(callOutcome.response, agent, round);
          captureSemanticMemory(response, "tool_stagnation_action_recovery");
          recordContextInvalidationDeclarations(response, followupContext, agent, round, "tool_stagnation_action_recovery");
          rawTextForMessage = callOutcome.rawTextForMessage;
          errorForMessage = callOutcome.errorForMessage;
          if (!hasMaterialExecutionRequest(response)) {
            session.toolContinuation = {
              agentId: agent.id,
              round,
              completedIterations: toolIterations,
              reason: "stagnation_recovery_missing_material_action",
              pendingRequests: response.tool_requests || []
            };
            response = {
              status: "speak",
              argument: "Stagnation recovery did not produce a real material execution action.",
              objections: ["stagnation_recovery_missing_material_action"],
              confidence: 0,
              memory_candidates: []
            };
          }
        }
        if (toolLoopStagnated.recoveryRequired && requiresStagnationVerification(agent, fileOperationPermissionTier, session.executionState) && !hasVerificationRequest(response)) {
          nativeToolConversation = undefined;
          callOutcome = yield* callRoundModel({
            options,
            session,
            phase: "tool_stagnation_verification_recovery",
            round,
            agent,
            memberContext: followupContext,
            messages: [...followupMessages, {
              role: "user",
              content: "The task is already in verification. Your recovery did not request a real verification tool. Do not read, search, fetch, edit, install, or plan. Call run_tests, run_code, or execute_command now to validate the current deliverable or project state."
            }],
            timeoutMs: group.settings.agentTimeoutMs,
            toolIteration: toolIterations,
            nativeToolPermissionTier: fileOperationPermissionTier,
            nativeToolChoice: "required"
          });
          response = applyRoundResponseRules(callOutcome.response, agent, round);
          captureSemanticMemory(response, "tool_stagnation_verification_recovery");
          recordContextInvalidationDeclarations(response, followupContext, agent, round, "tool_stagnation_verification_recovery");
          rawTextForMessage = callOutcome.rawTextForMessage;
          errorForMessage = callOutcome.errorForMessage;
          if (!hasVerificationRequest(response)) {
            session.toolContinuation = {
              agentId: agent.id,
              round,
              completedIterations: toolIterations,
              reason: "stagnation_recovery_missing_verification",
              pendingRequests: response.tool_requests || []
            };
            response = {
              status: "speak",
              argument: "Stagnation recovery did not produce a real verification action.",
              objections: ["stagnation_recovery_missing_verification"],
              confidence: 0,
              memory_candidates: []
            };
          }
        }
        processResponseFileOperations(response);
      }

      if (response.status === "speak" && response.tool_requests?.length && Number.isFinite(maxToolIterations) && toolIterations >= maxToolIterations) {
        session.toolContinuation = {
          agentId: agent.id,
          round,
          completedIterations: toolIterations,
          reason: `user_configured_tool_iteration_pause:${maxToolIterations}`,
          pendingRequests: response.tool_requests
        };
        response = {
          ...response,
          tool_requests: [],
          continuation_required: true
        };
      }

      const artifacts = collectMessageArtifacts(response, agent, round);
      session.artifacts.push(...artifacts);

      const message = {
        round,
        agentId: agent.id,
        agentName: agent.name,
        response,
        artifacts,
        fileOperationProposals: accumulatedFileOperationProposals,
        fileOperationExecutionResults: accumulatedFileOperationExecutionResults,
        toolRequests: accumulatedToolRequests,
        toolExecutionResults: accumulatedToolResults,
        rejectedToolRequests: accumulatedRejectedToolRequests,
        pendingFileOperationProposals: accumulatedPendingFileOperationProposals,
        rejectedFileOperationProposals: accumulatedRejectedFileOperationProposals,
        displayText: formatDisplayText(agent, response),
        rawText: rawTextForMessage,
        error: errorForMessage,
        contextStatus,
        startedAt: agentStartedAt,
        createdAt: nowIso(),
        durationMs: elapsedMs(agentStartMs)
      };
      results.push(message);
      session.messages.push(message);
      advanceExecutionState({
        state: session.executionState,
        session,
        agent,
        groupPath: options.groupPath,
        question: executionQuestion,
        response: message.response
      });
      refreshExecutionCheckpoint();
      recordObjections(session, agent, message.response, round, group.settings);
      persistRunningSession();
      appendDiscussionFallbackAgents({ agentsToCall, enabledAgents, session, round, firstRoundAgents });
      yield {
        type: "agent_message",
        message,
        createdAt: message.createdAt
      };
    }

    if (!results.length) break;

    consensus = scoreConsensus(enabledAgents, session, { round });
    session.consensusByRound.push({ round, ...consensus });
    persistRunningSession();
    yield {
      type: "round_complete",
      round,
      consensus,
      createdAt: nowIso()
    };
    if (session.guardStopReason) {
      persistRunningSession();
      break;
    }
    const noProgressReason = noProgressGuardReason(session, question, group.settings);
    if (noProgressReason) {
      session.guardStopReason = noProgressReason;
      persistRunningSession();
      break;
    }
    if (shouldStop(consensus, enabledAgents, session, group.settings, round)) break;
  }

  throwIfAborted(options.signal);
  const judge = selectFinalizer(enabledAgents, session);
  const finalStartMs = Date.now();
  const finalStartedAt = nowIso();
  const fallback = fallbackFinalDecision(session, consensus);
  let finalizationFailure = "";
  const finalSeat = findWorkspaceSeat(workspaceGroup, judge);
  const finalContext = buildMemberContext(judge, session, {
    question,
    groupSettings: group.settings,
    globalRequirement,
    continuationContext,
    latestBossInstruction: options.latestBossInstruction || "",
    attachments,
    taskState,
    retrievedContext,
    publicEventHotCache,
    enabledSkills: loadEnabledSkills(baseDir, options.groupPath, options.appSettings),
    ...loadSummaryContext(options.groupPath, judge, options.appSettings),
    privateBossMessages: loadPrivateBossMessages(options.groupPath, judge, options.appSettings),
    contextInvalidations,
    providerUsageCalibration: loadProviderUsageCalibration(options.groupPath, judge)
  });
  const finalContextStatus = summarizeContextStatus(finalContext, {
    groupPath: options.groupPath,
    seat: finalSeat,
    agent: judge
  });
  const finalBudgetBlockReason = limitBlockReason(finalContext, finalContextStatus, {
    groupPath: options.groupPath,
    seat: finalSeat,
    agent: judge
  });
  yield {
    type: "final_start",
    agentId: judge.id,
    agentName: judge.name,
    contextStatus: finalContextStatus,
    createdAt: finalStartedAt
  };
  if (finalContext.coreOverflow) {
    finalizationFailure = `non_compressible_core_exceeds_input_limit:${finalContextStatus.nonCompressibleCoreTokens}/${finalContextStatus.effectiveInputLimit}`;
    session.finalDecision = {
      ...fallback,
      risks: [
        ...fallback.risks,
        `final_judge_unavailable:non_compressible_core_exceeds_input_limit:${finalContextStatus.nonCompressibleCoreTokens}/${finalContextStatus.effectiveInputLimit}`
      ]
    };
  } else if (finalBudgetBlockReason) {
    finalizationFailure = finalBudgetBlockReason;
    session.finalDecision = {
      ...fallback,
      risks: [
        ...fallback.risks,
        `final_judge_unavailable:${finalBudgetBlockReason}`
      ]
    };
  } else if (session.guardStopReason) {
    finalizationFailure = session.guardStopReason;
    session.finalDecision = {
      ...fallback,
      risks: [...fallback.risks, session.guardStopReason]
    };
  } else if (!reserveModelCall(session)) {
    session.guardStopReason = "model_call_budget_exhausted";
    finalizationFailure = session.guardStopReason;
    session.finalDecision = {
      ...fallback,
      risks: [...fallback.risks, session.guardStopReason]
    };
  } else {
    const finalMessages = buildFinalPrompt(judge, session, consensus, {
      globalRequirement,
      contextSections: buildContextPromptSections(finalContext)
    });
    const contextReceipt = recordContextReceipt(session, finalContext, {
      groupPath: options.groupPath,
      sessionId: session.id,
      modelCallIndex: session.modelCallCount,
      phase: "final",
      agentId: judge.id,
      round: 0,
      toolIteration: 0,
      inputMessages: finalMessages
    });
    const modelCallRecord = notifyModelCall(options, {
      sessionId: session.id,
      phase: "final",
      agentId: judge.id,
      agentName: judge.name,
      model: judge.model || "",
      provider: judge.provider || "",
      inputMessages: finalMessages,
      contextReceipt
    });
    throwIfAborted(options.signal);
    const finalRaw = await safeCall(judge, finalMessages, group.settings.agentTimeoutMs, options.signal);
    completeModelCall(modelCallRecord, finalRaw);
    if (finalRaw.error) {
      finalizationFailure = finalRaw.error;
      session.finalDecision = { ...fallback, risks: [...fallback.risks, finalRaw.error] };
    } else {
      if (!hasValidFinalDecision(finalRaw.text)) finalizationFailure = "invalid_finalizer_response";
      session.finalDecision = parseFinalDecision(finalRaw.text, fallback);
    }
  }
  session.finalSemanticMemoryUpdate = Array.isArray(session.finalDecision.memory_candidates) && session.finalDecision.memory_candidates.length
    ? persistAgentSemanticPublicMemory(options.groupPath, session.finalDecision.memory_candidates, {
      appSettings: options.appSettings,
      sourceText: question,
      sessionId: session.id,
      agent: judge,
      createdAt: nowIso()
    })
    : { status: "no_candidates", candidateCount: 0, savedCount: 0, duplicateCount: 0, rejectedCount: 0 };
  session.finalizationStatus = finalizationFailure
    ? { status: "failed", reason: finalizationFailure }
    : { status: "completed", reason: "" };
  session.finalDecision.startedAt = finalStartedAt;
  session.finalDecision.durationMs = elapsedMs(finalStartMs);
  applyEngineFinalState(session, consensus, group.settings);
  applyFinalizationFailure(session);
  applyIncompleteExecutionState(session);
  if (session.guardStopReason) {
    session.finalDecision.final_state = "needs_revision";
    session.finalDecision.blocking_issues = [
      ...(session.finalDecision.blocking_issues || []),
      {
        id: "engine-no-progress-guard",
        issue: session.guardStopReason,
        severity: "critical",
        blocks_final: true,
        in_scope: true,
        source_agent_id: "engine",
        source_agent_name: "AI Council",
        status: "open"
      }
    ];
  }
  if (options.groupPath) {
    const fileExecution = runAutoFileOperations({
      groupPath: options.groupPath,
      session,
      group: workspaceGroup || group,
      appSettings: options.appSettings
    });
    session.finalDecision.file_execution_state = fileExecution.state;
    session.finalDecision.file_execution_results = fileExecution.results;
    if (session.taskRun && fileExecution.results.length) {
      recordTaskRunFileEvidence({
        groupPath: options.groupPath,
        taskRun: session.taskRun,
        agent: { id: "system", name: "Automatic file executor" },
        round: 0,
        results: fileExecution.results
      });
    }
    const deliverableVerification = verifyFinalDeliverables({
      groupPath: options.groupPath,
      session
    });
    applyDeliverableVerification(session, deliverableVerification);
    const requestedArtifactVerification = enforceRequestedArtifactRequirements({
      groupPath: options.groupPath,
      question: session.executionState?.taskQuestion || executionQuestion,
      session
    });
    if (session.taskRun) {
      recordTaskRunArtifactVerification({
        groupPath: options.groupPath,
        taskRun: session.taskRun,
        reports: [deliverableVerification, requestedArtifactVerification]
      });
    }
  }
  session.finalDecision.memory_candidates = limitMemoryCandidates(session.finalDecision.memory_candidates);
  session.publicMemoryUpdate = persistSummarizerPublicMemory(options.groupPath, session.finalDecision.memory_candidates, {
    sessionId: session.id,
    agent: judge,
    appSettings: options.appSettings
  });
  session.completedAt = nowIso();
  session.durationMs = elapsedMs(sessionStartMs);
  session.status = deriveSessionStatus(session);
  options.signal?.removeEventListener("abort", persistInterruptedSession);

  const sessionPath = options.groupPath
    ? persistRunningSession()
    : writeSession(session, baseDir);
  const contextArchive = options.groupPath
    ? writeContextArchive(session, options.groupPath, { attachments })
    : undefined;
  const transcriptChunk = options.groupPath && memoryEnabled
    ? appendSessionTranscriptChunk(options.groupPath, session)
    : undefined;
  const summaryUpdate = options.groupPath && memoryEnabled
    ? updateDeterministicSummaries(options.groupPath, session, workspaceGroup)
    : undefined;
  const usageRecord = options.groupPath
    ? appendSessionUsage(options.groupPath, session, workspaceGroup)
    : undefined;
  const taskStateUpdate = options.groupPath && memoryEnabled
    ? updateTaskStateFromSession(options.groupPath, session)
    : undefined;
  const memoryRecords = memoryEnabled
    ? appendMemoryCandidates(session.finalDecision, session, baseDir)
    : [];

  const result = { session, sessionPath, contextArchive, memoryRecords, transcriptChunk, summaryUpdate, usageRecord, taskStateUpdate };
  if (session.taskRun) {
    yield {
      type: "task_run",
      taskRun: taskRunSnapshot(session.taskRun),
      createdAt: nowIso()
    };
  }
  yield {
    type: "final_decision",
    agentId: judge.id,
    agentName: judge.name,
    session,
    finalDecision: session.finalDecision,
    contextStatus: finalContextStatus,
    durationMs: session.finalDecision.durationMs,
    createdAt: session.completedAt
  };
  yield {
    type: "done",
    result,
    createdAt: nowIso()
  };
}

function appendDiscussionFallbackAgents({ agentsToCall, enabledAgents, session, round, firstRoundAgents }) {
  const execution = session.executionState;
  if (execution?.active || execution?.phase !== "discussion") return;
  if (round === 1 && firstRoundAgents.length < enabledAgents.length) return;
  const scheduled = new Set(agentsToCall.map((agent) => agent.id));
  for (const agent of selectAgents(enabledAgents, session, round, firstRoundAgents)) {
    if (scheduled.has(agent.id)) continue;
    scheduled.add(agent.id);
    agentsToCall.push(agent);
  }
}

function positiveDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : undefined;
}

function persistSummarizerPublicMemory(groupPath, candidates, options = {}) {
  if (!capabilityEnabled(options.appSettings, "memory")) {
    return {
      status: "disabled",
      reason: "memory_capability_disabled",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0
    };
  }
  if (!groupPath) {
    return {
      status: "not_applicable",
      reason: "group_workspace_unavailable",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0
    };
  }
  try {
    return appendSummarizerPublicMemories(groupPath, candidates, {
      sourceSessionId: options.sessionId,
      sourceAgentId: options.agent?.id,
      sourceAgentName: options.agent?.name
    });
  } catch (error) {
    return {
      status: "failed",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      error: String(error?.message || error || "public_memory_write_failed").slice(0, 500)
    };
  }
}

function persistExplicitUserMemory(groupPath, text, options = {}) {
  if (!capabilityEnabled(options.appSettings, "memory")) {
    return {
      status: "disabled",
      reason: "memory_capability_disabled",
      candidateCount: 0,
      savedCount: 0,
      duplicateCount: 0
    };
  }
  if (!groupPath) {
    return {
      status: "not_applicable",
      reason: "group_workspace_unavailable",
      candidateCount: 0,
      savedCount: 0,
      duplicateCount: 0
    };
  }
  try {
    return rememberExplicitUserMemory(groupPath, text, {
      sourceSessionId: options.sourceSessionId,
      createdAt: options.createdAt
    });
  } catch (error) {
    return {
      status: "failed",
      candidateCount: 0,
      savedCount: 0,
      duplicateCount: 0,
      error: String(error?.message || error || "explicit_public_memory_write_failed").slice(0, 500)
    };
  }
}

function persistAgentSemanticPublicMemory(groupPath, candidates, options = {}) {
  if (!capabilityEnabled(options.appSettings, "memory")) {
    return {
      status: "disabled",
      reason: "memory_capability_disabled",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      savedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0
    };
  }
  if (!groupPath) {
    return {
      status: "not_applicable",
      reason: "group_workspace_unavailable",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      savedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0
    };
  }
  try {
    return appendAgentSemanticPublicMemories(groupPath, candidates, {
      sourceText: options.sourceText,
      sourceSessionId: options.sessionId,
      sourceAgentId: options.agent?.id,
      createdAt: options.createdAt
    });
  } catch (error) {
    return {
      status: "failed",
      candidateCount: Array.isArray(candidates) ? candidates.length : 0,
      savedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      error: String(error?.message || error || "semantic_public_memory_write_failed").slice(0, 500)
    };
  }
}

async function* callRoundModel({ options, session, phase, round, agent, memberContext, messages, timeoutMs, toolIteration, formatRecovery = true, nativeToolPermissionTier = "text", nativeToolChoice = "auto", nativeToolConversation = undefined }) {
  if (!reserveModelCall(session)) {
    session.guardStopReason = "model_call_budget_exhausted";
    return {
      response: { status: "unavailable", reason: session.guardStopReason, retryable: false },
      rawTextForMessage: "",
      errorForMessage: session.guardStopReason,
      nativeToolCalls: [],
      nativeAssistantText: ""
    };
  }
  const contextReceipt = recordContextReceipt(session, memberContext, {
    groupPath: options.groupPath,
    sessionId: session.id,
    modelCallIndex: session.modelCallCount,
    phase,
    round,
    toolIteration,
    agentId: agent.id,
    inputMessages: messages
  });
  const modelCallRecord = notifyModelCall(options, {
    sessionId: session.id,
    phase,
    round,
    toolIteration,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model || "",
    provider: agent.provider || "",
    inputMessages: messages,
    contextReceipt
  });
  throwIfAborted(options.signal);
  const streamingCall = startAgentCallWithDeltaQueue(agent, messages, timeoutMs, options.signal, nativeToolDefinitions(nativeToolPermissionTier), nativeToolChoice, nativeToolConversation);
  const pendingDeltas = [];
  while (!streamingCall.done() || streamingCall.hasDeltas()) {
    const delta = await streamingCall.nextDelta();
    if (!delta) continue;
    pendingDeltas.push(delta);
  }
  const raw = await streamingCall.result();
  const parsedResponse = raw.error
    ? { status: "unavailable", reason: raw.error, retryable: true }
    : parseRoundModelResult(raw.text, raw.nativeToolCalls);
  const safeRawText = raw.error ? "" : redactToolInputFromRawText(raw.text, parsedResponse);
  const safeRaw = raw.error ? raw : { ...raw, text: safeRawText };
  completeModelCall(modelCallRecord, safeRaw);
  if (safeRawText !== raw.text) {
    if (safeRawText) {
      yield {
        type: "agent_delta",
        round,
        agentId: agent.id,
        agentName: agent.name,
        delta: safeRawText,
        createdAt: nowIso()
      };
    }
  } else {
    for (const delta of pendingDeltas) {
      yield {
        type: "agent_delta",
        round,
        agentId: agent.id,
        agentName: agent.name,
        delta,
        createdAt: nowIso()
      };
    }
  }
  if (!raw.error && shouldKeepInterimModelMessage(parsedResponse, formatRecovery)) {
    const interim = buildInterimModelMessage({
      session,
      phase,
      round,
      agent,
      toolIteration,
      rawText: safeRawText,
      response: parsedResponse
    });
    session.interimMessages.push(interim);
    yield {
      type: "agent_interim",
      round,
      agentId: agent.id,
      agentName: agent.name,
      message: interim,
      createdAt: interim.createdAt
    };
  }
  if (formatRecovery && isInvalidStructuredResponse(parsedResponse)) {
    return yield* callRoundModel({
      options,
      session,
      phase: "format_recovery",
      round,
      agent,
      memberContext,
      timeoutMs,
      toolIteration,
      formatRecovery: false,
      nativeToolPermissionTier,
      nativeToolChoice: nativeToolPermissionTier === "full" ? "required" : "auto",
      messages: [...messages, {
        role: "user",
        content: nativeToolPermissionTier === "full"
          ? "Your previous response was truncated or invalid, so no work was accepted. Recover by calling a real native tool now. For file work, call workspace_edit with a complete non-empty write/append/replace; for execution, call the required command or test tool. Do not return analysis, a plan, a promise, or a file_operations placeholder. If native tools are unavailable and the provider falls back to text, return one valid compact JSON object with tool_requests that performs the same real action."
          : "Your previous response was truncated or invalid, so no work was accepted. Retry now with one complete valid JSON object. Do not repeat analysis or a plan; return an allowed action or status with all required fields."
      }]
    });
  }
  return {
    response: parsedResponse,
    rawTextForMessage: safeRawText,
    errorForMessage: raw.error,
    nativeToolCalls: raw.nativeToolCalls || [],
    nativeAssistantText: raw.error ? "" : raw.text
  };
}

function isInvalidStructuredResponse(response = {}) {
  return response.status === "unavailable" && String(response.reason || "").startsWith("invalid_json_response");
}

function shouldKeepInterimModelMessage(response = {}, willRecoverFormat = false) {
  if (response.status === "speak" && Array.isArray(response.tool_requests) && response.tool_requests.length) return true;
  return willRecoverFormat && isInvalidStructuredResponse(response);
}

function buildInterimModelMessage({ session, phase, round, agent, toolIteration, rawText, response }) {
  const safeResponse = redactTerminalInputFromResponse(response);
  const invalid = isInvalidStructuredResponse(response);
  const displayText = invalid
    ? String(rawText || safeResponse.reason || "").trim()
    : String(safeResponse.argument || safeResponse.reason || rawText || "").trim();
  return {
    id: makeId("attempt"),
    round,
    agentId: agent.id,
    agentName: agent.name,
    phase,
    toolIteration: Number(toolIteration || 0),
    modelCallIndex: Number(session.modelCallCount || 0),
    response: safeResponse,
    displayText,
    rawText: String(rawText || ""),
    interim: true,
    createdAt: nowIso()
  };
}

function redactToolInputFromRawText(rawText, response) {
  if (!hasSensitiveToolInput(response)) return String(rawText || "");
  try {
    const parsed = JSON.parse(String(rawText || ""));
    return JSON.stringify(redactTerminalInputFromResponse(parsed));
  } catch {
    // A truncated JSON response cannot be structurally rewritten. Do not let a
    // possible tool-input value leak through an event or trace while recovery
    // asks the model for a complete response.
    return "[Structured tool response redacted because it included sensitive input.]";
  }
}

function redactTerminalInputFromResponse(response = {}) {
  if (!response || typeof response !== "object") return response;
  const copy = JSON.parse(JSON.stringify(response));
  for (const request of Array.isArray(copy.tool_requests) ? copy.tool_requests : []) {
    if (!isTerminalInputRequest(request)) continue;
    const input = String(request.inputText ?? request.input_text ?? request.text ?? request.value ?? "");
    const redacted = { bytes: Buffer.byteLength(input, "utf8"), redacted: true };
    if ("inputText" in request || !Object.keys(request).some((key) => ["input_text", "text", "value"].includes(key))) request.inputText = redacted;
    else if ("input_text" in request) request.input_text = redacted;
    else if ("text" in request) request.text = redacted;
    else request.value = redacted;
  }
  return copy;
}

function hasSensitiveToolInput(response = {}) {
  return (Array.isArray(response?.tool_requests) ? response.tool_requests : []).some(isTerminalInputRequest);
}

function isTerminalInputRequest(request = {}) {
  return String(request?.tool || "").toLowerCase() === "process_control"
    && String(request?.action || "").toLowerCase() === "input";
}

function applyRoundResponseRules(response, agent, round) {
  if (round === 1 && isReviewerLike(agent) && response.status === "skip") {
    return {
      status: "speak",
      position: "reviewer_required",
      argument: "An explicitly assigned reviewer cannot skip in round 1.",
      objections: ["reviewer_required"],
      suggested_revision: "Provide at least one concrete in-scope risk or explicitly state what was checked.",
      confidence: 0,
      memory_candidates: []
    };
  }
  return response;
}

function normalizeModelCallBudget(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) return Number.POSITIVE_INFINITY;
  return number;
}

function normalizeMaxToolIterations(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) return Number.POSITIVE_INFINITY;
  return number;
}

function normalizeMaxRounds(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) return Number.POSITIVE_INFINITY;
  return number;
}

function reserveModelCall(session) {
  const count = Number(session.modelCallCount || 0);
  const budget = normalizeModelCallBudget(session.modelCallBudget);
  if (count >= budget) return false;
  session.modelCallCount = count + 1;
  return true;
}

function noProgressGuardReason(session, question, settings = {}) {
  if (!requiresWorkspaceExecution(session.executionState) || hasMaterialWorkspaceProgress(session)) return "";
  const threshold = Number(settings.noProgressModelCalls || 0);
  if (!Number.isFinite(threshold) || threshold <= 0) return "";
  if (Number(session.modelCallCount || 0) < threshold) return "";
  return `no_workspace_progress_after_${session.modelCallCount}_model_calls`;
}

function hasMaterialWorkspaceProgress(session = {}) {
  if ((session.fileOperationExecutionResults || []).some((item) => (
    ["executed", "committed", "restored"].includes(String(item.status || ""))
    && ["write", "append", "delete", "restore"].includes(String(item.op || item.action || ""))
  ))) return true;
  return (session.toolExecutionResults || []).some((item) => {
    if (item?.status !== "completed") return false;
    const changes = item.result?.workspaceChanges || {};
    if (Number(changes.totalChanges || 0) > 0) return true;
    return [changes.created, changes.modified, changes.deleted].some((entries) => Array.isArray(entries) && entries.length > 0);
  });
}

export function updateStagnantToolLoopCount({ requests = [], results = [], rejected = [], current = 0, seenTargets = new Set(), history = [], capabilityReady = false } = {}) {
  const material = (results || []).some(hasMaterialWorkspaceChange);
  const actionableFailure = (rejected || []).some((item) => ["permission_denied", "capability_disabled", "invalid_tool"].includes(String(item.code || "")))
    || (results || []).some((item) => item.status === "failed" && !isRepeatableInspectionTool(item));
  const targets = (requests || []).map(toolLoopTarget).filter(Boolean);
  const allTargetsNovel = targets.length > 0 && targets.every((target) => !seenTargets.has(target));
  for (const target of targets) seenTargets.add(target);
  const acquiredCapabilityReady = capabilityReady || hasReadyAcquiredCapability(history);
  const inspectionOnly = results.length > 0 && results.every(isRepeatableInspectionTool);
  const repeatedInspection = inspectionOnly && !allTargetsNovel;
  const scoreIncrement = acquiredCapabilityReady || repeatedInspection ? 3 : 1;
  const count = material
    ? 0
    : actionableFailure
      ? Number(current || 0) + 3
      : !inspectionOnly
        ? 0
        : Number(current || 0) + scoreIncrement;
  return { count, recoveryRequired: count >= 9 };
}

export function hasPersistedAcquiredCapability(groupPath) {
  if (!groupPath) return false;
  const npmModules = path.join(groupPath, "shared", "environments", "npm", "node_modules");
  if (directoryHasEntries(npmModules, new Set([".bin", ".package-lock.json"]))) return true;
  const managedTools = path.join(groupPath, "shared", "tools");
  if (directoryHasEntries(managedTools)) return true;
  const gemPackages = path.join(groupPath, "shared", "environments", "gem", "gems");
  if (directoryHasEntries(gemPackages)) return true;
  return hasInstalledPythonPackage(path.join(groupPath, "shared", "environments", "pip", ".venv"));
}

function directoryHasEntries(directory, ignored = new Set()) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => !ignored.has(entry.name));
  } catch {
    return false;
  }
}

function hasInstalledPythonPackage(venvRoot) {
  const stack = [{ directory: venvRoot, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    if (path.basename(current.directory).toLowerCase() === "site-packages") {
      return entries.some((entry) => !/^(?:pip|setuptools|pkg_resources)(?:-|$)/i.test(entry.name) && entry.name !== "__pycache__");
    }
    if (current.depth < 5) {
      for (const entry of entries) if (entry.isDirectory()) stack.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return false;
}

function hasReadyAcquiredCapability(items = []) {
  return (Array.isArray(items) ? items : []).some((item) => {
    if (item?.status !== "completed" || item.result?.ok === false) return false;
    if (["install_package", "provision_tool", "skill_install", "mcp_install_npm"].includes(item.tool)) return true;
    return item.tool === "execute_command" && isSuccessfulPackageInstallCommand(item);
  });
}

function toolLoopTarget(request = {}) {
  const tool = String(request.tool || "");
  if (!tool) return "";
  if (request.path) return `${tool}:path:${String(request.path).toLowerCase()}`;
  if (request.url) return `${tool}:url:${String(request.url).toLowerCase()}`;
  if (request.command) {
    const command = String(request.command).toLowerCase();
    const fileTarget = command.match(/[a-z0-9_./-]+\.(?:json|js|ts|py|java|txt|csv|zip|jar)\b/)?.[0] || "";
    return `${tool}:command:${fileTarget || command.replace(/\s+/g, " ").slice(0, 180)}`;
  }
  return `${tool}:generic`;
}

function isRepeatableInspectionTool(item = {}) {
  return ["list_directory", "read_file", "search_files", "grep_content", "web_search", "fetch_url", "api_request", "execute_command", "git_operation", "run_tests"].includes(item.tool);
}

function buildStagnantToolLoopRecoveryInstruction(agent, question, toolFollowupInstruction, executionState) {
  const reviewer = isReviewerLike(agent);
  const roleDirective = reviewer
    ? "You are reviewing. Stop issuing more inspection, search, API, Git or verification calls unless there is one distinct unresolved evidence gap. Use the evidence already returned and give a concrete review conclusion, objection, or skip."
    : requiresStagnationVerification(agent, "full", executionState)
      ? "The execution state is verify. Stop repeating inspection, search, API, Git or file-edit calls. Use the evidence already returned and run a real validation, test, build, parser, assertion, or smoke command for the current deliverable."
      : requiresStagnationWorkspaceEdit(agent, question, "full", executionState)
      ? "You are delivering a file task. Stop repeating inspection, search, API, Git or verification calls. Use the evidence already returned and make the concrete workspace edit or repair needed for the current requirement. Do not return another investigation plan."
      : "Stop repeating inspection, search, API, Git or verification calls. Use the evidence already returned and take a materially different next action, or state the concrete blocker with its evidence.";
  return `${toolFollowupInstruction}\n\n[Stagnation recovery]\nSeveral consecutive tool turns produced no material workspace progress. ${roleDirective}`;
}

function requiresStagnationWorkspaceEdit(agent, question, permissionTier, executionState) {
  return permissionTier === "full"
    && !isReviewerLike(agent)
    && requiresWorkspaceExecution(executionState)
    && executionState?.phase !== "verify"
    && executionState?.phase !== "review"
    && executionState?.phase !== "complete";
}

function requiresStagnationVerification(agent, permissionTier, executionState) {
  return permissionTier === "full"
    && !isReviewerLike(agent)
    && executionState?.active
    && executionState?.phase === "verify";
}

function hasWorkspaceMutationRequest(response = {}) {
  return (response.tool_requests || []).some((request) => (
    request.tool === "workspace_edit"
    && ["write", "append", "replace", "move"].includes(String(request.action || ""))
    && (String(request.code || "").length > 0 || String(request.content || "").length > 0 || String(request.newText || "").length > 0 || String(request.destination || "").length > 0)
  ));
}

export function hasMaterialExecutionRequest(response = {}) {
  if (hasWorkspaceMutationRequest(response)) return true;
  return (response.tool_requests || []).some((request) => {
    const tool = String(request.tool || "");
    if (["install_package", "provision_tool", "skill_install", "mcp_install_npm", "create_archive", "extract_archive", "process_control"].includes(tool)) return true;
    if (tool === "execute_command") return Boolean(String(request.command || "").trim());
    if (tool === "run_code") return Boolean(String(request.code || "").trim() || String(request.inputText || "").trim());
    if (tool === "run_tests") return true;
    if (tool === "git_operation") return !["status", "log", "show", "diff"].includes(String(request.action || "").toLowerCase());
    if (tool === "database_query") return !/^\s*(?:select|pragma|explain)\b/i.test(String(request.sql || ""));
    return false;
  });
}

function hasVerificationRequest(response = {}) {
  return (response.tool_requests || []).some((request) => (
    request.tool === "run_tests"
    || (request.tool === "run_code" && (String(request.code || "").trim() || String(request.inputText || "").trim()))
    || (request.tool === "execute_command" && String(request.command || "").trim())
  ));
}

function hasReachedVerificationCheckpoint(session, agent) {
  const state = session?.executionState || {};
  return Boolean(
    state?.active
    && agent?.id === state.executorId
    && /^verification_passed:/.test(String(state.lastAction || ""))
    && ["review", "complete"].includes(String(state.phase || ""))
    && !hasActiveManagedProcess(session)
  );
}

function hasActiveManagedProcess(session = {}) {
  const latestByProcessId = new Map();
  for (const item of Array.isArray(session.toolExecutionResults) ? session.toolExecutionResults : []) {
    const result = item?.result || {};
    const process = result.process || {};
    const processId = String(result.processId || process.processId || "").trim();
    if (!processId) continue;
    const status = String(process.status || result.status || (result.background ? "running" : "")).trim().toLowerCase();
    if (status) latestByProcessId.set(processId, status);
  }
  return [...latestByProcessId.values()].some((status) => ["starting", "running", "stopping"].includes(status));
}

function buildVerificationCheckpointHandoff(state = {}) {
  const nextPhase = state.phase === "complete" ? "final synthesis" : "checkpoint review";
  return {
    status: "speak",
    position: "verification_checkpoint_recorded",
    argument: `A real verification checkpoint was recorded (${state.lastAction}). The executor is handing the task to ${nextPhase}; no additional tool request is needed in this turn.`,
    objections: [],
    objection_items: [],
    confidence: 1,
    memory_candidates: []
  };
}

function abortReasonCode(signal) {
  const reason = signal?.reason;
  return String(reason?.code || reason?.message || "aborted").slice(0, 200);
}

function notifyModelCall(options = {}, record = {}) {
  const safeRecord = { ...record };
  if (options.groupPath) {
    Object.defineProperty(safeRecord, "__trace", {
      value: { groupPath: options.groupPath },
      enumerable: false
    });
    appendModelCallTrace(safeRecord, { event: "start" });
  }
  if (typeof options.onModelCall === "function") options.onModelCall(safeRecord);
  return safeRecord;
}

function completeModelCall(record, raw = {}) {
  if (!record) return;
  if (raw.error) record.error = raw.error;
  else record.rawText = raw.text || "";
  if (raw.usage) record.usage = raw.usage;
  if (raw.usage && record.__trace?.groupPath) {
    try {
      appendProviderUsageSample(record.__trace.groupPath, record, raw.usage);
    } catch (error) {
      // Usage calibration is observability. A local accounting write failure
      // must not rewrite a completed provider response into a fake failure.
      record.usageCalibrationError = String(error?.message || error).slice(0, 300);
    }
  }
  appendModelCallTrace(record, { event: "complete", raw });
}

function recordContextReceipt(session, memberContext, details = {}) {
  const receipt = materializeContextReceipt(memberContext, details);
  if (!Array.isArray(session.contextReceipts)) session.contextReceipts = [];
  session.contextReceipts.push(receipt);
  if (details.groupPath && session.taskRun?.id) {
    appendTaskRunEvent(details.groupPath, session.taskRun.id, "context_compiled", compactTaskRunContextReceipt(receipt));
  }
  return receipt;
}

function compactTaskRunContextReceipt(receipt = {}) {
  const decisions = Array.isArray(receipt.decisions) ? receipt.decisions : [];
  const nonInjected = decisions.filter((item) => item.status !== "injected");
  return {
    call: receipt.call || {},
    budget: receipt.budget || {},
    sections: (Array.isArray(receipt.sections) ? receipt.sections : []).map((item) => ({
      id: item.id,
      estimatedTokens: item.estimatedTokens,
      retainedTokenShare: item.retainedTokenShare,
      sourceCount: item.sourceCount
    })),
    omittedOrShortened: nonInjected.slice(-80).map((item) => ({
      section: item.section,
      status: item.status,
      reason: item.reason,
      source: item.source
    })),
    invalidatedSources: receipt.policy?.invalidatedSources || []
  };
}

function taskRunSnapshot(taskRun) {
  if (!taskRun?.id) return undefined;
  return {
    id: taskRun.id,
    state: taskRun.state,
    blockReason: taskRun.blockReason,
    updatedAt: taskRun.updatedAt,
    execution: {
      phase: taskRun.execution?.phase || "",
      nextAction: taskRun.execution?.nextAction || "",
      artifactStatus: taskRun.execution?.artifactStatus || ""
    }
  };
}

function appendModelCallTrace(record, { event, raw } = {}) {
  const groupPath = record?.__trace?.groupPath;
  if (!groupPath) return;
  const filePath = path.join(path.resolve(groupPath), "shared", "logs", "model-calls.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    event,
    createdAt: nowIso(),
    sessionId: record.sessionId || "",
    phase: record.phase || "",
    round: record.round,
    agentId: record.agentId || "",
    agentName: record.agentName || "",
    provider: record.provider || "",
    model: record.model || "",
    input: summarizePromptMessages(record.inputMessages || []),
    contextReceipt: record.contextReceipt || undefined
  };
  if (raw?.error) payload.error = String(raw.error).slice(0, 500);
  if (raw?.text != null) payload.output = summarizeText(raw.text);
  if (raw?.usage) payload.usage = raw.usage;
  if (record.usageCalibrationError) payload.usageCalibrationError = record.usageCalibrationError;
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function summarizePromptMessages(messages = []) {
  const combined = messages.map((message) => {
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content || "");
    return `${message.role || "unknown"}: ${content}`;
  }).join("\n\n");
  const question = messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : "";
    return content.match(/(?:^|\n)Question:\s*([\s\S]*?)(?=\n\nRound:|\nRound:|$)/)?.[1]?.trim() || "";
  }).find(Boolean) || "";
  return {
    ...summarizeText(combined),
    question: summarizeText(question)
  };
}

function summarizeText(value) {
  const text = String(value || "");
  return {
    chars: text.length,
    head: text.slice(0, 600),
    tail: text.length > 600 ? text.slice(-600) : ""
  };
}

function effectiveWorkspacePermissionTier(workspaceGroup, agent) {
  if (!workspaceGroup) return "text";
  const permissions = workspaceGroup.permissions || {};
  return permissions.seatTiers?.[agent.id] || permissions.defaultTier || "text";
}

function selectAgents(enabledAgents, session, round, firstRoundAgents = enabledAgents) {
  if (
    session.executionState?.phase === "intake"
    && round === 1
    && !firstRoundAgents.some((agent) => agent.id === session.executionState.executorId)
  ) return firstRoundAgents.filter((agent) => participatesInRound(agent, enabledAgents));
  const executionAgents = selectExecutionAgents(session.executionState, enabledAgents);
  if (executionAgents) return executionAgents;
  const roundEligibleAgents = enabledAgents.filter((agent) => participatesInRound(agent, enabledAgents));
  const firstRoundEligible = firstRoundAgents.filter((agent) => participatesInRound(agent, enabledAgents));
  if (round === 1) return firstRoundEligible;
  return roundEligibleAgents;
}

function participatesInRound(agent, enabledAgents) {
  if (!agent.judge) return true;
  if (agent.consensusParticipant === true) return true;
  if (isReviewerLike(agent)) return true;
  return enabledAgents.length <= 1;
}

function recordObjections(session, agent, response, round, groupSettings) {
  updateUnresolvedObjections(session, agent, response);
  applyObjectionLedger(session, agent, response, { round, groupSettings });
}

function selectFirstRoundAgents(enabledAgents, options = {}) {
  const startId = options.startAtAgentId || options.startAfterAgentId;
  const base = !startId ? enabledAgents : sliceFirstRoundAgents(enabledAgents, options);
  return options.workMode === "independent" ? orderIndependentFirstRound(base) : base;
}

function sliceFirstRoundAgents(enabledAgents, options = {}) {
  const startId = options.startAtAgentId || options.startAfterAgentId;
  if (!startId) return enabledAgents;
  const index = enabledAgents.findIndex((agent) => agent.id === startId);
  if (index < 0) return enabledAgents;
  return enabledAgents.slice(index + (options.startAfterAgentId ? 1 : 0));
}

function orderIndependentFirstRound(agents) {
  return [...agents].sort((a, b) => independentFirstRoundPhase(a) - independentFirstRoundPhase(b));
}

function independentFirstRoundPhase(agent) {
  if (agent.judge && !isReviewerLike(agent)) return 3;
  if (isReviewerLike(agent)) return 2;
  return 1;
}

function normalizeWorkMode(value) {
  return value === "independent" ? "independent" : "collab";
}

function mergeContextInvalidations(...values) {
  const byKey = new Map();
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : []) {
      const source = item?.source || item;
      const supersededBy = item?.supersededBy || item?.superseded_by;
      const type = String(source?.type || source?.sourceType || "").trim();
      const id = String(source?.id || source?.eventId || source?.sourceId || "").trim();
      const nextType = String(supersededBy?.type || supersededBy?.sourceType || "").trim();
      const nextId = String(supersededBy?.id || supersededBy?.eventId || supersededBy?.sourceId || "").trim();
      if (!type || !id || !nextType || !nextId) continue;
      byKey.set(`${type}\u001f${id}`, {
        source: { type, id },
        supersededBy: { type: nextType, id: nextId },
        reason: String(item?.reason || "explicit_source_invalidation").trim()
      });
    }
  }
  return [...byKey.values()];
}

function acceptContextInvalidationDeclarations({ declarations, memberContext, session, agent, round, phase }) {
  const visibleSourceList = Array.isArray(memberContext?.invalidationSourceRefs)
    ? memberContext.invalidationSourceRefs
    : [];
  const visibleSources = new Map(visibleSourceList.map((source) => [`${source.type}\u001f${source.id}`, source]));
  if (!visibleSources.size || !Array.isArray(declarations)) return [];
  const current = memberContext?.currentInstructionSource || {
    type: "session_question",
    id: String(session?.id || "")
  };
  const accepted = [];
  const seen = new Set();
  for (const declaration of declarations) {
    const source = declaration?.source || {};
    const type = String(source.type || "").trim();
    const id = String(source.id || "").trim();
    const key = `${type}\u001f${id}`;
    if (!type || !id || !visibleSources.has(key) || seen.has(key)) continue;
    if (type === current.type && id === current.id) continue;
    const declaredSource = visibleSources.get(key);
    for (const relatedSource of visibleSourceList.filter((candidate) => replacementSourceAliases(declaredSource, candidate))) {
      const relatedKey = `${relatedSource.type}\u001f${relatedSource.id}`;
      if (seen.has(relatedKey)) continue;
      seen.add(relatedKey);
      accepted.push({
        source: { type: String(relatedSource.type), id: String(relatedSource.id) },
        supersededBy: { type: String(current.type), id: String(current.id) },
        reason: String(declaration.reason || "current_user_instruction_replaces_retained_source").trim().slice(0, 400),
        declaredBy: {
          agentId: String(agent?.id || ""),
          agentName: String(agent?.name || ""),
          round: Number(round || 0),
          phase: String(phase || "")
        }
      });
      if (accepted.length >= 12) break;
    }
    if (accepted.length >= 12) break;
  }
  return accepted;
}

function replacementSourceAliases(declared = {}, candidate = {}) {
  if (declared?.type === candidate?.type && declared?.id === candidate?.id) return true;
  const eventViews = new Set(["retrieved_context", "public_event"]);
  if (!eventViews.has(declared?.type) || !eventViews.has(candidate?.type)) return false;
  if (declared?.id && declared.id === candidate?.id) return true;
  const sameSession = String(declared?.sessionId || "") && String(declared?.sessionId) === String(candidate?.sessionId || "");
  if (!sameSession) return false;
  const declaredRound = Number(declared?.round || 0);
  const candidateRound = Number(candidate?.round || 0);
  if (declaredRound > 0 || candidateRound > 0) return declaredRound === candidateRound;
  return String(declared?.sourceType || "") === "session_final" && String(candidate?.sourceType || "") === "final_decision";
}

function compactContextInvalidation(item = {}) {
  return {
    source: {
      type: String(item.source?.type || ""),
      id: String(item.source?.id || "")
    },
    supersededBy: {
      type: String(item.supersededBy?.type || ""),
      id: String(item.supersededBy?.id || "")
    },
    reason: String(item.reason || ""),
    declaredBy: item.declaredBy && typeof item.declaredBy === "object" ? {
      agentId: String(item.declaredBy.agentId || ""),
      agentName: String(item.declaredBy.agentName || ""),
      round: Number(item.declaredBy.round || 0),
      phase: String(item.declaredBy.phase || "")
    } : undefined
  };
}

function contextVisibilityForAgent(agent, workMode) {
  if (workMode !== "independent") return "full";
  if (agent.judge || isReviewerLike(agent)) return "full";
  return "own";
}

function selectFinalizer(enabledAgents, session) {
  const explicitJudge = enabledAgents.find((agent) => agent.judge);
  if (explicitJudge) return explicitJudge;
  const byId = new Map(enabledAgents.map((agent) => [agent.id, agent]));
  for (const message of [...(session.messages || [])].reverse()) {
    const agent = byId.get(message.agentId);
    if (agent) return agent;
  }
  return enabledAgents[0];
}

function normalizeContinuationContext(value) {
  if (!value || typeof value !== "object") return null;
  const blockingIssues = normalizeTextList(value.blockingIssues || value.blocking_issues);
  const risks = normalizeTextList(value.risks || value.unresolved_risks);
  const nextActions = normalizeTextList(value.nextActions || value.next_actions);
  const normalized = {
    previousSessionId: String(value.previousSessionId || value.sessionId || "").trim(),
    previousQuestion: String(value.previousQuestion || value.question || "").trim(),
    finalState: String(value.finalState || value.final_state || "").trim(),
    finalAnswer: String(value.finalAnswer || value.answer || "").trim(),
    summary: String(value.summary || "").trim(),
    sourcePath: String(value.sourcePath || value.source_path || "").trim(),
    previousStatus: String(value.previousStatus || value.status || "").trim(),
    blockingIssues,
    risks,
    nextActions,
    participantMessages: normalizeContinuationMessages(value.participantMessages || value.participant_messages, 12),
    recentMessages: normalizeContinuationMessages(value.recentMessages || value.recent_messages, 12),
    recentActivity: normalizeTextList(value.recentActivity || value.recent_activity).slice(0, 12),
    verifiedToolResults: normalizeVerifiedContinuationToolResults(value.verifiedToolResults || value.verified_tool_results, 12),
    authorizedProjectRoots: normalizeContinuationProjectRoots(value.authorizedProjectRoots || value.authorized_project_roots),
    taskRunId: String(value.taskRunId || value.task_run_id || "").trim()
  };
  return Object.values(normalized).some((item) => Array.isArray(item) ? item.length : Boolean(item)) ? normalized : null;
}

function isContinuationRequest(question) {
  const text = String(question || "").trim().toLowerCase();
  if (!text) return false;
  return /^(?:好(?:的)?|可以|行|嗯|那)?[\s，,。.!！?？]*(?:继续|接着|往下(?:做)?|继续完善|继续完成|continue\b|go\s+on\b|keep\s+going\b)/iu.test(text);
}

function buildAutomaticContinuationContext(previousSession) {
  if (!previousSession?.id) return null;
  const inherited = normalizeContinuationContext(previousSession.continuationContext);
  const messages = allSessionMessages(previousSession);
  const latestByAgent = new Map();
  for (const message of messages) {
    const key = String(message.agentId || message.agentName || "").trim();
    if (key) latestByAgent.set(key, message);
  }
  const finalDecision = previousSession.finalDecision || {};
  const participantMessages = messages.length
    ? [...latestByAgent.values()].slice(-12).map(compactContinuationMessage)
    : inherited?.participantMessages || [];
  const participantKeys = new Set(participantMessages.map(continuationMessageKey));
  const recentMessages = messages.length
    ? messages.slice(-24).map(compactContinuationMessage).filter((message) => !participantKeys.has(continuationMessageKey(message))).slice(-12)
    : inherited?.recentMessages || [];
  const recentActivity = [
    ...(Array.isArray(previousSession.toolExecutionResults) ? previousSession.toolExecutionResults.slice(-8).map((item) => compactContinuationActivity("tool", item)) : []),
    ...(Array.isArray(previousSession.fileOperationExecutionResults) ? previousSession.fileOperationExecutionResults.slice(-8).map((item) => compactContinuationActivity("file result", item)) : []),
    ...(Array.isArray(previousSession.fileOperationProposals) ? previousSession.fileOperationProposals.slice(-8).map((item) => compactContinuationActivity("file proposal", item)) : [])
  ].filter(Boolean).slice(-12);
  const verifiedToolResults = mergeVerifiedContinuationToolResults([
    ...(previousSession.toolExecutionResults || []).map(compactVerifiedContinuationToolResult),
    ...(inherited?.verifiedToolResults || [])
  ]);
  return normalizeContinuationContext({
    previousSessionId: previousSession.id,
    previousQuestion: inherited?.previousQuestion || previousSession.question,
    previousStatus: previousSession.status,
    finalState: finalDecision.final_state || inherited?.finalState,
    finalAnswer: finalDecision.answer || inherited?.finalAnswer,
    summary: `Saved public session with ${messages.length} member messages across ${Math.max(0, ...messages.map((message) => Number(message.round || 0)))} rounds.`,
    sourcePath: `sessions/${previousSession.id}.json`,
    blockingIssues: finalDecision.blocking_issues || finalDecision.unresolved_blockers || inherited?.blockingIssues,
    risks: finalDecision.risks || finalDecision.unresolved_risks || inherited?.risks,
    nextActions: finalDecision.next_actions || inherited?.nextActions,
    participantMessages,
    recentMessages,
    recentActivity: recentActivity.length ? recentActivity : inherited?.recentActivity,
    verifiedToolResults,
    authorizedProjectRoots: normalizeContinuationProjectRoots([
      ...(previousSession.authorizedProjectRoots || []),
      ...(inherited?.authorizedProjectRoots || [])
    ]),
    taskRunId: String(previousSession.taskRun?.id || inherited?.taskRunId || "").trim()
  });
}

function normalizeContinuationProjectRoots(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter((item) => (
    path.isAbsolute(item) && fs.existsSync(item)
  )).map((item) => {
    try { return fs.realpathSync.native(item); } catch { return ""; }
  }).filter(Boolean))];
}

function continuationAuthorizedProjectRoots(context, automaticSource) {
  return normalizeContinuationProjectRoots([
    ...(automaticSource?.authorizedProjectRoots || []),
    ...(context?.authorizedProjectRoots || [])
  ]);
}

function isPlainContinuationRequest(question) {
  return /^(?:continue|go\s+on|keep\s+going|\u7ee7\u7eed|\u63a5\u7740|\u7ee7\u7eed\u505a|\u7ee7\u7eed\u5b8c\u6210)[\s.!?\u3002\uff01\uff1f]*$/iu.test(String(question || "").trim());
}

function normalizeVerifiedContinuationToolResults(value, limit) {
  return mergeVerifiedContinuationToolResults(Array.isArray(value) ? value.slice(-limit).map((item) => ({
    tool: String(item?.tool || "").trim(),
    commandFingerprint: String(item?.commandFingerprint || item?.command_fingerprint || "").trim(),
    sourceAgentId: String(item?.sourceAgentId || item?.source_agent_id || "").trim(),
    createdAt: String(item?.createdAt || item?.created_at || "").trim()
  })) : []);
}

function mergeVerifiedContinuationToolResults(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || item.tool !== "execute_command" || !/^[a-f0-9]{64}$/i.test(item.commandFingerprint || "")) return false;
    if (seen.has(item.commandFingerprint)) return false;
    seen.add(item.commandFingerprint);
    return true;
  }).slice(-12);
}

function compactVerifiedContinuationToolResult(item = {}) {
  const command = String(item.command || item.result?.command || "").trim();
  const exitCode = Number(item.result?.exitCode);
  if (item.tool !== "execute_command" || item.status !== "completed" || !command || !Number.isFinite(exitCode) || exitCode !== 0) return null;
  return {
    tool: "execute_command",
    commandFingerprint: continuationCommandFingerprint(command),
    sourceAgentId: String(item.source_agent_id || item.sourceAgentId || ""),
    createdAt: String(item.createdAt || "")
  };
}

function continuationVerifiedToolResults(context) {
  return (context?.verifiedToolResults || []).map((item) => ({
    tool: item.tool,
    status: "completed",
    continuationVerified: true,
    commandFingerprint: item.commandFingerprint,
    source_agent_id: item.sourceAgentId || ""
  }));
}

function continuationCommandFingerprint(command) {
  return createHash("sha256").update(String(command || "").trim().replace(/\s+/g, " ").toLowerCase()).digest("hex");
}

function allSessionMessages(session = {}) {
  return [
    ...(Array.isArray(session.interimMessages) ? session.interimMessages : []),
    ...(Array.isArray(session.messages) ? session.messages : [])
  ].sort((a, b) => {
    const time = new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime();
    if (time) return time;
    return Number(a?.modelCallIndex || 0) - Number(b?.modelCallIndex || 0);
  });
}

function selectAutomaticContinuationSource(sessions) {
  const recent = Array.isArray(sessions) ? sessions : [];
  if (!recent.length) return undefined;
  return recent.find((session) => (
    !isContinuationRequest(session?.question)
    || normalizeContinuationContext(session?.continuationContext)?.previousSessionId
  )) || recent[0];
}

function isLegacyContinuationShell(session) {
  return Boolean(session?.id)
    && isContinuationRequest(session?.question)
    && !normalizeContinuationContext(session?.continuationContext)?.previousSessionId;
}

function compactContinuationMessage(message = {}) {
  const response = message.response || {};
  return {
    round: Number(message.round || 0),
    agentId: String(message.agentId || ""),
    agentName: String(message.agentName || message.agentId || ""),
    status: String(response.status || "unknown"),
    text: truncateContinuationText(response.argument || response.reason || response.position || message.displayText || "", 420),
    createdAt: String(message.createdAt || "")
  };
}

function normalizeContinuationMessages(value, limit) {
  return (Array.isArray(value) ? value : []).slice(-limit).map((message) => ({
    round: Number(message?.round || 0),
    agentId: String(message?.agentId || message?.agent_id || "").trim(),
    agentName: String(message?.agentName || message?.agent_name || message?.agentId || "").trim(),
    status: String(message?.status || "unknown").trim(),
    text: truncateContinuationText(message?.text || message?.argument || message?.reason || "", 420),
    createdAt: String(message?.createdAt || message?.created_at || "").trim()
  })).filter((message) => message.agentName || message.text);
}

function compactContinuationActivity(label, item = {}) {
  const result = item.result || {};
  const identity = item.tool || item.op || item.action || result.action || "activity";
  const target = item.path || result.path || result.destinationPath || item.query || item.url || item.command || "";
  const status = item.status || result.status || result.code || "unknown";
  const detail = result.error || result.stderr || result.stdout || result.message || item.error || "";
  return truncateContinuationText(`${label}: ${identity} status=${status}${target ? ` target=${target}` : ""}${detail ? ` detail=${detail}` : ""}`, 500);
}

function continuationMessageKey(message = {}) {
  return `${message.round || 0}|${message.agentId || message.agentName || ""}|${message.text || ""}`;
}

function truncateContinuationText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeTextList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") {
      return String(item.issue || item.text || item.reason || item.id || JSON.stringify(item)).trim();
    }
    return String(item || "").trim();
  }).filter(Boolean);
}

function startAgentCallWithDeltaQueue(agent, messages, timeoutMs, signal, nativeTools, nativeToolChoice = "auto", nativeToolConversation = undefined) {
  const queue = createAsyncQueue();
  let result;
  let thrown;
  let done = false;
  const callPromise = safeCall(agent, messages, timeoutMs, signal, (delta) => queue.push(delta), nativeTools, nativeToolChoice, nativeToolConversation)
    .then((value) => {
      result = value;
    })
    .catch((error) => {
      thrown = error;
    })
    .finally(() => {
      done = true;
      queue.close();
    });
  return {
    done: () => done,
    hasDeltas: () => queue.hasItems(),
    nextDelta: () => queue.shift(),
    async result() {
      await callPromise;
      if (thrown) throw thrown;
      return result;
    }
  };
}

function nativeToolTurnFromResponse(callOutcome = {}, response = {}) {
  const toolCalls = Array.isArray(callOutcome.nativeToolCalls)
    ? callOutcome.nativeToolCalls.filter((call) => call?.id && call?.name)
    : [];
  const requests = Array.isArray(response.tool_requests) ? response.tool_requests : [];
  if (!toolCalls.length || !requests.length) return undefined;
  const nativeRequestIds = new Set(toolCalls.map((call) => String(call.id)));
  if (requests.some((request) => !nativeRequestIds.has(String(request?.id || "")))) return undefined;
  return {
    text: String(callOutcome.nativeAssistantText || callOutcome.rawTextForMessage || ""),
    toolCalls
  };
}

function ownerRequestedDelegation(response = {}, executionState = {}, agent = {}) {
  return agent?.id === executionState?.executorId
    && (Array.isArray(response?.tool_requests) ? response.tool_requests : []).some((request) => (
      String(request?.tool || "").trim().toLowerCase() === "delegate_task"
    ));
}

function deferredToolRequestForDelegation(request = {}) {
  return {
    id: String(request.id || `delegation_deferred:${request.tool || "tool"}`),
    tool: String(request.tool || ""),
    status: "rejected",
    code: "delegation_handoff_required",
    error: "The delivery owner requested a bounded delegation in this response. All other same-turn actions are deferred until the contributor handoff is durable and acknowledged.",
    createdAt: nowIso()
  };
}

function buildNativeToolContinuationInstruction(recoveryInstruction, executionDirective) {
  return [
    "The preceding native tool-result messages are the authoritative result of your requested actions. Continue from them. Do not repeat a completed observation or command unless the workspace changed or the result requires a repair.",
    recoveryInstruction,
    executionDirective
  ].filter(Boolean).join("\n\n");
}

async function safeCall(agent, messages, timeoutMs, signal, onDelta, nativeTools, nativeToolChoice = "auto", nativeToolConversation = undefined) {
  try {
    return await callAgentResult(agent, messages, {
      timeoutMs,
      signal,
      onDelta,
      nativeTools: nativeTools || [],
      nativeToolChoice,
      nativeToolConversation
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { error: `agent_call_failed:${agent.id}:${error.message}` };
  }
}

function createAsyncQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(item) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        items.push(item);
      }
    },
    shift() {
      if (items.length) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()(null);
    },
    hasItems() {
      return items.length > 0;
    }
  };
}

function fallbackFinalDecision(session, consensus) {
  const redTeamObjections = Object.entries(session.unresolvedObjections)
    .flatMap(([agentId, objections]) => objections.map((objection) => `${agentId}: ${objection}`));
  return {
    answer: "The council could not complete because the finalizer did not provide a valid final answer.",
    consensus_score: consensus.score,
    supporting_agents: consensus.supportingAgents,
    dissenting_agents: consensus.dissentingAgents,
    minority_report: redTeamObjections.join("; ") || "No unresolved minority report.",
    risks: redTeamObjections,
    next_actions: ["Review the session transcript."],
    memory_candidates: []
  };
}

function contextOverflowReason(contextStatus = {}) {
  return `non_compressible_core_exceeds_input_limit:${Number(contextStatus.nonCompressibleCoreTokens || 0)}/${Number(contextStatus.effectiveInputLimit || 0)}`;
}

function applyFinalizationFailure(session) {
  if (session.finalizationStatus?.status !== "failed") return;
  const reason = session.finalizationStatus.reason || "invalid_finalizer_response";
  const issue = {
    id: "finalizer-failed",
    issue: `Final synthesis failed: ${reason}`,
    severity: "critical",
    blocks_final: true,
    in_scope: true,
    source_agent_id: "engine",
    source_agent_name: "AI Council",
    status: "open"
  };
  if (session.finalDecision.final_state !== "failed_to_converge") session.finalDecision.final_state = "needs_revision";
  session.finalDecision.blocking_issues = mergeBlockingIssue(session.finalDecision.blocking_issues, issue);
  session.finalDecision.risks = mergeRiskTexts(session.finalDecision.risks, [issue], []);
  session.finalDecision.answer = `The council could not complete: ${reason}. No valid final answer was produced.`;
}

function applyIncompleteExecutionState(session) {
  const execution = session.executionState;
  const pausedToolLoop = session.toolContinuation;
  if (!pausedToolLoop && (!execution?.active || execution.phase === "complete")) return;
  const executorId = execution?.executorId || pausedToolLoop?.agentId || "engine";
  const latestExecutorMessage = [...(session.messages || [])].reverse().find((message) => message.agentId === executorId);
  const responseStatus = latestExecutorMessage?.response?.status || "missing";
  const detail = pausedToolLoop
    ? pausedToolLoop.reason
    : `phase=${execution?.phase || "unknown"}, executor_status=${responseStatus}`;
  const issue = {
    id: "execution-incomplete",
    issue: `Execution did not reach complete (${detail}).`,
    severity: "critical",
    blocks_final: true,
    in_scope: true,
    source_agent_id: executorId,
    source_agent_name: execution?.executorName || latestExecutorMessage?.agentName || "AI Council",
    status: "open"
  };
  if (session.finalDecision.final_state !== "failed_to_converge") session.finalDecision.final_state = "needs_revision";
  session.finalDecision.blocking_issues = mergeBlockingIssue(session.finalDecision.blocking_issues, issue);
  session.finalDecision.risks = mergeRiskTexts(session.finalDecision.risks, [issue], []);
}

function mergeBlockingIssue(items = [], issue) {
  const existing = Array.isArray(items) ? items : [];
  return existing.some((item) => item?.id === issue.id) ? existing : [...existing, issue];
}

function deriveSessionStatus(session) {
  if (session.guardStopReason) return "guard_stopped";
  const state = session.finalDecision?.final_state;
  if (state === "ready_to_execute" || state === "usable_with_risks") return "completed";
  if (state === "failed_to_converge") return "failed";
  if (state === "needs_revision") return "incomplete";
  return "failed";
}

function applyEngineFinalState(session, consensus, settings) {
  const finalState = computeFinalState(session, settings);
  session.finalDecision.consensus_score = consensus.score;
  session.finalDecision.final_state = finalState.final_state;
  session.finalDecision.blocking_issues = finalState.blocking_issues;
  session.finalDecision.unresolved_risks = finalState.unresolved_risks;
  session.finalDecision.risks = mergeRiskTexts(
    session.finalDecision.risks,
    finalState.blocking_issues,
    finalState.unresolved_risks
  );
  if (finalState.blocking_issues.length) {
    const report = finalState.blocking_issues
      .map((item) => `${item.source_agent_name || item.source_agent_id || "reviewer"}: ${item.issue}`)
      .join("; ");
    session.finalDecision.minority_report = [session.finalDecision.minority_report, report]
      .filter((text) => text && text !== "No unresolved minority report.")
      .join("; ");
  }
}

function mergeRiskTexts(existing = [], blockingIssues = [], unresolvedRisks = []) {
  const seen = new Set();
  const values = [
    ...existing,
    ...blockingIssues.map((item) => `BLOCKER ${item.id}: ${item.issue}`),
    ...unresolvedRisks.map((item) => `${item.severity || "risk"} ${item.id}: ${item.issue}`)
  ];
  return values.filter((value) => {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeContextStatus(memberContext, options = {}) {
  const size = assessSizeUsage(memberContext.tokenEstimate.total, memberContext.limits);
  const budget = summarizeBudgetStatus(memberContext, {
    ...options,
    totalTokens: memberContext.tokenEstimate.total,
    reservedOutputTokens: memberContext.limits.reservedOutputTokens
  });
  return {
    contextWindow: memberContext.limits.contextWindow ?? null,
    effectiveInputLimit: memberContext.limits.effectiveInputLimit,
    inputLimitKnown: Boolean(memberContext.limits.inputLimitKnown),
    inputLimitSource: memberContext.limits.inputLimitSource || "unknown",
    effectiveOutputLimit: memberContext.limits.effectiveOutputLimit,
    reservedOutputTokens: memberContext.limits.reservedOutputTokens,
    inputEstimateMultiplier: memberContext.limits.inputEstimateMultiplier || 1,
    inputEstimateCalibration: memberContext.limits.inputEstimateCalibration || { status: "unavailable", sampleCount: 0 },
    totalTokens: memberContext.tokenEstimate.total,
    nonCompressibleCoreTokens: memberContext.tokenEstimate.nonCompressibleCore,
    compressionApplied: Boolean(memberContext.compression?.applied),
    droppedRecentMessages: memberContext.compression?.droppedRecentMessages || 0,
    archiveContextCompression: memberContext.archiveContextCompression || {
      applied: false,
      keptCount: 0,
      droppedCount: 0,
      truncatedSnippets: 0
    },
    currentTurnEvidenceCompression: memberContext.currentTurnEvidenceCompression || {
      applied: false,
      originalCount: 0,
      keptCount: 0,
      omittedCount: 0,
      shortenedCount: 0
    },
    executionEvidenceCompression: memberContext.executionEvidenceCompression || {
      applied: false,
      originalCount: 0,
      dedupedCount: 0,
      keptCount: 0,
      omittedCount: 0,
      shortenedCount: 0
    },
    coreOverflow: memberContext.coreOverflow,
    sizeStatus: size.status,
    sizeRatio: size.ratio,
    budgetStatus: budget.status,
    tokenBudgetStatus: budget.tokenStatus,
    tokenBudgetRatio: budget.tokenRatio,
    costBudgetStatus: budget.costStatus,
    costBudgetRatio: budget.costRatio,
    estimatedCost: budget.projectedCost,
    accruedCost: budget.accruedCost,
    providerCacheBreakpoint: memberContext.providerCacheBreakpoint
  };
}

function summarizeBudgetStatus(memberContext, options = {}) {
  const requiredTokens = Number(options.totalTokens || 0) + Number(options.reservedOutputTokens || 0);
  const token = assessBudgetUsage(requiredTokens, memberContext.limits.tokenBudget, memberContext.limits);
  const cost = summarizeCostBudgetUsage(memberContext, options);
  return {
    status: mostSevereBudgetStatus(token.status, cost.status),
    tokenStatus: token.status,
    tokenRatio: token.ratio,
    costStatus: cost.status,
    costRatio: cost.ratio,
    projectedCost: cost.projectedCost,
    accruedCost: cost.accruedCost
  };
}

function summarizeCostBudgetUsage(memberContext, options = {}) {
  const budget = memberContext.limits.costBudget;
  if (!budget || !options.groupPath || !options.seat) return { status: "unknown", ratio: undefined };
  const pricing = options.agent?.pricing || options.agent?.providerLimits?.pricing || {};
  const projectedCost = estimateCost({
    inputTokens: options.totalTokens,
    outputTokens: options.reservedOutputTokens,
    pricing
  });
  if (projectedCost === undefined) return { status: "unknown", ratio: undefined };
  const accruedCost = estimateMemberAccruedCost(options.groupPath, options.seat, pricing);
  const total = accruedCost + projectedCost;
  const usage = assessBudgetUsage(total, budget, memberContext.limits);
  return {
    status: usage.status,
    ratio: usage.ratio,
    projectedCost,
    accruedCost
  };
}

function mostSevereBudgetStatus(...statuses) {
  const rank = { unknown: 0, normal: 1, warning: 2, confirm: 3, pause: 4 };
  return statuses.reduce((winner, status) => {
    return (rank[status] || 0) > (rank[winner] || 0) ? status : winner;
  }, "unknown");
}

function limitBlockReason(memberContext, contextStatus, options = {}) {
  return tokenBudgetBlockReason(memberContext, contextStatus)
    || costBudgetBlockReason(memberContext, contextStatus, options);
}

function tokenBudgetBlockReason(memberContext, contextStatus) {
  const budget = memberContext.limits.tokenBudget;
  if (!budget) return "";
  const required = contextStatus.totalTokens + contextStatus.reservedOutputTokens;
  if (required <= budget) return "";
  return `token_budget_exceeded:${required}/${budget}`;
}

function costBudgetBlockReason(memberContext, contextStatus, options = {}) {
  const budget = memberContext.limits.costBudget;
  if (!budget || !options.groupPath || !options.seat) return "";
  const pricing = options.agent?.pricing || options.agent?.providerLimits?.pricing || {};
  const projectedCost = estimateCost({
    inputTokens: contextStatus.totalTokens,
    outputTokens: contextStatus.reservedOutputTokens,
    pricing
  });
  if (projectedCost === undefined) return "";
  const accruedCost = estimateMemberAccruedCost(options.groupPath, options.seat, pricing);
  const total = accruedCost + projectedCost;
  if (total <= budget) return "";
  return `cost_budget_exceeded:${formatCost(total)}/${formatCost(budget)}`;
}

function findWorkspaceSeat(group, agent) {
  if (!group?.seats) return undefined;
  return group.seats.find((seat) => {
    return seat.seatId === agent.id
      || seat.displayName === agent.name
      || seat.currentModel === agent.model
      || seat.role === agent.role;
  });
}

function formatCost(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function loadProviderUsageCalibration(groupPath, agent = {}) {
  if (!groupPath) return undefined;
  try {
    return readProviderUsageCalibration(groupPath, {
      provider: agent.provider,
      model: agent.model
    });
  } catch {
    // Calibration informs an estimate only. Treat an unreadable local ledger
    // as unknown; never invent a provider context limit as a fallback.
    return undefined;
  }
}

function loadSummaryContext(groupPath, agent, appSettings) {
  if (!groupPath) return {};
  if (!capabilityEnabled(appSettings, "memory")) return {};
  try {
    const group = readWorkspaceGroup(groupPath);
    const cache = readSummaryCache(groupPath, agent, group);
    return {
      memberShortSummary: cache.memberShortSummary,
      memberShortSummaryRecord: cache.memberShortSummaryRecord,
      groupSharedSummary: cache.groupSharedSummary,
      groupSharedSummaryRecord: cache.groupSharedSummaryRecord,
      compressedTranscriptChunks: cache.compressedTranscriptChunks,
      publicMemorySummary: formatPublicMemoriesForPrompt(groupPath)
    };
  } catch {
    return {};
  }
}

function loadPrivateBossMessages(groupPath, agent, appSettings) {
  const seatId = agent?.id;
  if (!groupPath || !seatId) return [];
  if (!capabilityEnabled(appSettings, "memory")) return [];
  // Browser-only seats may not exist in group.json; use the same display-name
  // based seat payload that private-chat writes use, or the inbox path diverges.
  const seat = {
    seatId,
    id: agent.id,
    displayName: agent.name || agent.role || seatId,
    role: agent.role || ""
  };
  try {
    return readPrivateContextMessages(groupPath, seatId, { limit: 12, seat });
  } catch {
    return [];
  }
}
function readWorkspaceGroup(groupPath) {
  const filePath = path.join(groupPath, "group.json");
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadEnabledSkills(baseDir, groupPath, appSettings) {
  if (!groupPath) return "";
  if (!capabilityEnabled(appSettings, "skills")) return "";
  try {
    return formatEnabledSkillMetadataForPrompt(listEnabledSkillMetadata(baseDir, groupPath));
  } catch {
    return "Enabled skill metadata could not be read. Do not claim any skill instructions are available.";
  }
}

export function buildToolFollowupInstruction(results = [], rejected = []) {
  const lines = [
    "Tool results from your previous request are now available in context. Use the real tool results to continue this round. Request another tool only when a real next step still requires it; otherwise finish with speak or skip JSON."
  ];
  const completed = (Array.isArray(results) ? results : []).filter((item) => item?.status === "completed" && item.result?.ok !== false);
  const failedCommands = (Array.isArray(results) ? results : []).filter((item) => item?.tool === "execute_command" && item?.status === "failed");
  const failedManagedInstalls = (Array.isArray(results) ? results : []).filter((item) => item?.tool === "install_package" && item?.status === "failed");
  const sourceRequiredProvisions = (Array.isArray(results) ? results : []).filter((item) => item?.tool === "provision_tool" && item?.status === "failed" && ["tool_source_required", "unsafe_discovery_source", "discovery_evidence_missing"].includes(item?.code));
  const failedSkillReads = (Array.isArray(results) ? results : []).filter((item) => item?.tool === "skill_read" && item?.status === "failed");
  const invalidSkillRequests = (Array.isArray(rejected) ? rejected : []).filter((item) => item?.code === "invalid_tool" && /^skill(?::|$)/i.test(String(item.tool || "")));
  if (failedCommands.length) {
    lines.push(`Failed command attempts this round: ${failedCommands.length}. Do not repeat an identical failed command. Read its stdout, stderr, exit code, timeout state, and environment hint before choosing a materially different next action.`);
  }
  for (const item of failedManagedInstalls) {
    const manager = item.manager || item.result?.manager || "the selected package manager";
    const packageName = item.packageName || item.package || item.result?.packageName || "the selected package";
    lines.push(`Managed package installation failed for ${manager} package ${JSON.stringify(packageName)}. Use the exact returned error. Do not retry the same manager unchanged; if another already-detected runtime ecosystem can satisfy the task, choose an equivalent package yourself and request install_package with that manager.`);
  }
  for (const item of sourceRequiredProvisions) {
    const tool = item.toolName || item.commandName || "the missing tool";
    lines.push(`Provisioning ${JSON.stringify(tool)} lacks a traceable acquisition source. Request web_search now for the publisher's or platform package manager's installation page, or fetch the exact public page, then make a materially different provision_tool request with manager/packageId or HTTPS downloadUrl, discoverySourceUrl set to that observed source, discoveryQuery set to the search terms, and SHA-256 when the publisher provides one. The source must match completed web_search/fetch_url evidence. It is discovery provenance only, not a substitute for download integrity verification; do not repeat an empty request or run an arbitrary copied shell script.`);
  }
  for (const item of failedSkillReads) {
    const skillId = item.skillId || "the requested skill";
    lines.push(`Skill instructions could not be loaded for ${JSON.stringify(skillId)} (${item.code || "skill_read_failed"}). Do not retry the same skill_read unchanged. Request skill_list to inspect installed and enabled skills. If no suitable enabled skill exists, use skill_search plus skill_install/skill_enable, or switch to a verified generic package, runtime, CLI, or code path that can produce the requested artifact.`);
  }
  if (invalidSkillRequests.length) {
    lines.push("A skill-like tool name was invalid. The protocol has no dynamic tool named skill or skill:<id>. Use skill_read with skillId for an enabled skill, skill_list to inspect availability, skill_search/skill_install/skill_enable to acquire one, or a generic package/runtime/command path. Do not repeat the invalid tool name.");
  }
  for (const item of failedCommands.filter((entry) => isPackageInstallCommand(entry))) {
    const output = `${item.result?.stdout || ""}\n${item.result?.stderr || ""}\n${item.result?.error || item.error || ""}`;
    if (/no such file or directory|cannot find the path|path not found|cannot cd/i.test(output) || /\bcd\s+[^;&|]+\s*(?:&&|;)/i.test(String(item.command || item.result?.command || ""))) {
      lines.push("A direct package install failed after changing into a guessed directory. Do not invent managed environment paths or search for them. Run the package manager from the current existing workspace, or use install_package with the selected manager and consume the environmentPath returned by that tool.");
    }
  }
  for (const item of failedCommands) {
    const command = String(item.command || item.result?.command || "");
    const output = `${item.result?.stdout || ""}\n${item.result?.stderr || ""}\n${item.result?.error || item.error || ""}`;
    if (/\bcd\s+(?:['"])?(?:\/workspace|[A-Za-z]:[\\/]workspace)(?:['"])?\b/i.test(command)
      || (/\bcd\s+[^;&|]+\s*(?:&&|;)/i.test(command) && /no such file or directory|cannot find the path|path not found|cannot cd|can't cd/i.test(output))) {
      lines.push("The command failed after changing into a nonexistent or placeholder workspace path. Command tools already start in the current group workspace. Remove the guessed cd prefix and retry the materially necessary command with cwd set only to a real directory returned by file tools.");
    }
  }
  const missingCommands = missingCommandNames(failedCommands);
  if (missingCommands.length) {
    lines.push(`Missing executable detected: ${missingCommands.join(", ")}. Do not stop or return to planning. Request provision_tool now for the missing runtime or CLI, verify it, then retry the original command in this same execution task.`);
  }
  const repeatedFamilies = repeatedFailedCommandFamilies(failedCommands);
  if (repeatedFamilies.length) {
    lines.push(`Repeated failed command strategies: ${repeatedFamilies.join(", ")}. Stop retrying that strategy for now; inspect existing files, detected runtimes, and generated artifacts before another install or download attempt.`);
  }
  for (const item of completed.filter((entry) => entry.tool === "install_package")) {
    const manager = item.result?.manager || item.manager || "package manager";
    const packageName = item.result?.packageName || item.packageName || item.package || "the selected package";
    const environmentPath = item.result?.environmentPath || "the managed workspace environment";
    if (manager === "npm") {
      lines.push(`npm package ${JSON.stringify(packageName)} is installed in ${environmentPath}. Later execute_command and run_code calls automatically receive the managed NODE_PATH. Import the package by its normal module name and use it for the next artifact-producing action; do not search forbidden or global node_modules directories and do not reinstall it.`);
    } else if (manager === "pip") {
      lines.push(`Python package ${JSON.stringify(packageName)} is installed in ${environmentPath}. Later commands automatically receive the managed environment's executable directory on PATH. Use that managed Python environment for the next artifact-producing action; do not search or reinstall globally.`);
    } else {
      lines.push(`${manager} package ${JSON.stringify(packageName)} is installed in ${environmentPath}. Use the returned managed environment in the next artifact-producing command; do not repeat discovery or reinstall the same package.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "provision_tool")) {
    const command = item.result?.command || item.commandName || item.toolName || "the acquired command";
    const status = item.result?.status || "verified";
    lines.push(`Tool acquisition completed with status ${JSON.stringify(status)} for command ${JSON.stringify(command)}. Invoke the acquired command in the next artifact-producing or verification action. Do not search for or install another copy unless that invocation produces a real failure.`);
  }
  for (const item of completed.filter((entry) => entry.tool === "execute_command" && isSuccessfulPackageInstallCommand(entry))) {
    lines.push(`A direct package-manager command completed successfully: ${JSON.stringify(String(item.command || item.result?.command || "").slice(0, 240))}. Use the acquired dependency in the next artifact-producing or verification command. Do not return to package discovery or repeat the install without a real usage failure.`);
  }
  const searchResults = completed.filter((item) => item.tool === "mcp_search_npm");
  for (const item of searchResults) {
    const packages = (item.result?.results || [])
      .map((result) => result.packageName || result.name)
      .filter(Boolean)
      .slice(0, 3);
    if (packages.length) {
      lines.push(`MCP tool search found installable npm packages: ${packages.join(", ")}. If one fits the task, request mcp_install_npm with packageSpec set to the chosen package name; otherwise explain why none fit.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_install_npm")) {
    const serverId = item.result?.id || item.serverId || item.catalogId || item.packageSpec;
    if (serverId) {
      lines.push(`MCP install completed for serverId "${serverId}". Next, request mcp_list_tools, mcp_list_resources, or mcp_list_prompts with that serverId depending on the task before trying to use the new MCP server.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_list_tools")) {
    const toolNames = (item.result?.servers || [])
      .flatMap((server) => (server.tools || []).map((tool) => `${server.serverId || item.serverId || ""}:${tool.name || ""}`))
      .filter((name) => !name.endsWith(":"))
      .slice(0, 8);
    if (toolNames.length) {
      lines.push(`MCP tool list is available: ${toolNames.join(", ")}. If a listed tool is needed, request mcp_call with mcpToolName and arguments; include serverId only when the same tool name appears on more than one server or you are choosing a specific server.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_call")) {
    const toolName = item.result?.toolName || item.mcpToolName;
    lines.push(`MCP call${toolName ? ` "${toolName}"` : ""} returned real content. Use that result directly; do not call the same tool again unless another real input is missing.`);
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_list_resources")) {
    const resourceUris = (item.result?.servers || [])
      .flatMap((server) => (server.resources || []).map((resource) => `${server.serverId || item.serverId || ""}:${resource.uri || ""}`))
      .filter((uri) => !uri.endsWith(":"))
      .slice(0, 8);
    if (resourceUris.length) {
      lines.push(`MCP resource list is available: ${resourceUris.join(", ")}. If a listed resource is needed, request mcp_read_resource with uri; include serverId only when the same URI appears on more than one server or you are choosing a specific server.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_read_resource")) {
    const uri = item.result?.uri || item.uri;
    lines.push(`MCP resource${uri ? ` "${uri}"` : ""} returned real content. Use that result directly; do not read the same resource again unless another real input is missing.`);
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_list_prompts")) {
    const promptNames = (item.result?.servers || [])
      .flatMap((server) => (server.prompts || []).map((prompt) => `${server.serverId || item.serverId || ""}:${prompt.name || ""}`))
      .filter((name) => !name.endsWith(":"))
      .slice(0, 8);
    if (promptNames.length) {
      lines.push(`MCP prompt list is available: ${promptNames.join(", ")}. If a listed prompt is needed, request mcp_get_prompt with promptName and any required arguments; include serverId only when the same prompt name appears on more than one server or you are choosing a specific server.`);
    }
  }
  for (const item of completed.filter((entry) => entry.tool === "mcp_get_prompt")) {
    const promptName = item.result?.promptName || item.promptName;
    lines.push(`MCP prompt${promptName ? ` "${promptName}"` : ""} returned real prompt messages. Use that result directly; do not get the same prompt again unless another real input is missing.`);
  }
  if ((Array.isArray(rejected) ? rejected : []).length) {
    lines.push("Some tool requests were rejected. Read the rejected tool request reasons in context before choosing the next step.");
  }
  return lines.join("\n");
}

function isSuccessfulPackageInstallCommand(item) {
  if (!isPackageInstallCommand(item)) return false;
  const output = `${item.result?.stdout || ""}\n${item.result?.stderr || ""}`;
  return !/(?:npm ERR!|permission denied|unable to acquire|could not open lock file|no module named ensurepip|command not found|not recognized as an internal or external command)/i.test(output);
}

function isPackageInstallCommand(item) {
  const command = String(item.command || item.result?.command || "");
  return /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:add|install)\b|\b(?:python|python3|py)(?:\.exe)?\s+-m\s+pip\s+install\b|(?:^|[;&|]\s*)pip3?\s+install\b|(?:^|[;&|]\s*)cargo\s+(?:add|install)\b|(?:^|[;&|]\s*)go\s+(?:get|install)\b|(?:^|[;&|]\s*)gem\s+install\b|(?:^|[;&|]\s*)(?:winget|choco|scoop|brew)\s+install\b|\bapt(?:-get)?\s+install\b/i.test(command);
}

function missingCommandNames(items = []) {
  const names = [];
  for (const item of items) {
    const output = [item.error, item.result?.error, item.result?.stderr, item.result?.stdout].filter(Boolean).join("\n");
    const patterns = [
      /['"]?([A-Za-z0-9._-]+)['"]?\s+is not recognized as an internal or external command/i,
      /(?:command not found|not found):?\s*([A-Za-z0-9._-]+)?/i,
      /([A-Za-z0-9._-]+):\s*(?:command not found|not found)/i,
      /The term ['"]([^'"]+)['"] is not recognized/i
    ];
    let found = "";
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match?.[1]) {
        found = match[1];
        break;
      }
    }
    if (!found) {
      const command = String(item.command || item.result?.command || "").trim().match(/^['"]?([A-Za-z0-9._-]+)/)?.[1];
      if (command && /not recognized|command not found|cannot find|ENOENT/i.test(output)) found = command;
    }
    if (found) names.push(found);
  }
  return [...new Set(names)].slice(0, 5);
}

function repeatedFailedCommandFamilies(items = []) {
  const counts = new Map();
  for (const item of items) {
    const command = String(item?.command || item?.result?.command || "").toLowerCase();
    const family = /curl|wget|invoke-webrequest|download|https?:\/\//.test(command)
      ? "download"
      : /\b(?:npm|pip|cargo|gem|go)\s+(?:install|add|get)\b/.test(command)
        ? "package install"
        : /\b(?:gradle|gradlew|mvn|mvnw|npm|cargo|dotnet)\b[^\r\n]*(?:build|test|package|assemble)/.test(command)
          ? "build/test"
          : "";
    if (family) counts.set(family, (counts.get(family) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([family, count]) => `${family} (${count})`);
}

function buildUnavailableMessage(agent, round, reason, contextStatus, timing = {}) {
  const response = {
    status: "unavailable",
    reason,
    retryable: false
  };
  return {
    round,
    agentId: agent.id,
    agentName: agent.name,
    response,
    artifacts: [],
    displayText: formatDisplayText(agent, response),
    rawText: "",
    error: reason,
    contextStatus,
    startedAt: timing.startedAt || nowIso(),
    createdAt: nowIso(),
    durationMs: Number(timing.durationMs || 0)
  };
}

function elapsedMs(startMs) {
  return Math.max(0, Date.now() - Number(startMs || Date.now()));
}

function collectMessageArtifacts(response, agent, round) {
  return (response.artifacts || []).map((artifact, index) => ({
    id: `${agent.id}-r${round}-a${index + 1}`,
    round,
    source_agent_id: agent.id,
    source_agent_name: agent.name,
    type: artifact.type || "text",
    title: artifact.title || undefined,
    content: artifact.content
  }));
}

function collectFileOperationProposals(response, agent, round, groupPath) {
  if (!groupPath) return { accepted: [], rejected: [] };
  const result = parseFileOperationProposals({
    groupRoot: groupPath,
    source: response,
    proposedBy: { seatId: agent.id, name: agent.name, role: agent.role }
  });
  return {
    accepted: result.accepted.map((proposal) => ({
      ...proposal,
      round,
      source_agent_id: agent.id,
      source_agent_name: agent.name
    })),
    rejected: result.rejected.map((rejection) => ({
      ...rejection,
      round,
      source_agent_id: agent.id,
      source_agent_name: agent.name
    }))
  };
}

function queueFileOperationProposals(fileOperationResult, groupPath) {
  if (!groupPath) return { queued: [], rejected: [] };
  return enqueueFileOperationProposals({
    groupPath,
    accepted: fileOperationResult.accepted.filter((proposal) => proposal.op !== "read" && proposal.op !== "list"),
    rejected: fileOperationResult.rejected
  });
}

function executeRoundAutoFileOperations(options = {}) {
  if (!options.groupPath || options.permissionTier !== "full") return [];
  const beforeCount = Array.isArray(options.session.fileOperationExecutionResults)
    ? options.session.fileOperationExecutionResults.length
    : 0;
  const autoSession = {
    finalDecision: { final_state: "ready_to_execute" },
    fileOperationExecutionResults: options.session.fileOperationExecutionResults || []
  };
  const result = runAutoFileOperations({
    groupPath: options.groupPath,
    session: autoSession,
    group: options.group,
    appSettings: options.appSettings
  });
  options.session.fileOperationExecutionResults = result.results || [];
  syncPendingFileOperationStatuses(options.session, options.session.fileOperationExecutionResults);
  return options.session.fileOperationExecutionResults.slice(beforeCount);
}

function syncPendingFileOperationStatuses(session, executionResults = []) {
  if (!Array.isArray(session.pendingFileOperationProposals) || !session.pendingFileOperationProposals.length) return;
  const byId = new Map(
    executionResults
      .filter((item) => item?.proposalId)
      .map((item) => [item.proposalId, item])
  );
  session.pendingFileOperationProposals = session.pendingFileOperationProposals.map((proposal) => {
    const result = byId.get(proposal.id);
    if (!result) return proposal;
    return {
      ...proposal,
      status: result.status || proposal.status,
      autoExecutionStatus: result.status || proposal.autoExecutionStatus,
      autoExecutionReason: result.reason || proposal.autoExecutionReason,
      commitHash: result.commitHash || proposal.commitHash,
      verification: result.verification || proposal.verification
    };
  });
}

function applyFilePermissionTier(fileOperationResult, tier, appSettings) {
  if (!capabilityEnabled(appSettings, "files")) {
    return {
      accepted: [],
      rejected: [
        ...fileOperationResult.rejected,
        ...fileOperationResult.accepted.map((proposal) => ({
          id: proposal.id,
          op: proposal.op,
          path: proposal.path,
          sourceIndex: proposal.sourceIndex,
          source_agent_id: proposal.source_agent_id,
          source_agent_name: proposal.source_agent_name,
          code: "capability_disabled",
          capabilityId: "files",
          reason: "File tools are disabled in global settings."
        }))
      ]
    };
  }
  if (tier !== "text") return fileOperationResult;
  return {
    accepted: [],
    rejected: [
      ...fileOperationResult.rejected,
      ...fileOperationResult.accepted.map((proposal) => ({
        id: proposal.id,
        op: proposal.op,
        path: proposal.path,
        sourceIndex: proposal.sourceIndex,
        source_agent_id: proposal.source_agent_id,
        source_agent_name: proposal.source_agent_name,
        code: "permission_denied",
        reason: "Seat has text-only permission and cannot request file operations."
      }))
    ]
  };
}

function applyDelegationFileScope(fileOperationResult, delegation) {
  if (!delegation) return fileOperationResult;
  const accepted = [];
  const rejected = [...(fileOperationResult.rejected || [])];
  for (const proposal of fileOperationResult.accepted || []) {
    const op = String(proposal.op || "").toLowerCase();
    const mutation = !["read", "list"].includes(op);
    const requiredTool = op === "read" ? "read_file" : op === "list" ? "list_directory" : "workspace_edit";
    const toolAllowed = delegation.allowedTools?.includes(requiredTool);
    const insideScope = delegationPathAllowed(proposal.path, delegation.allowedPaths);
    if (mutation && (!toolAllowed || !delegation.allowWorkspaceMutation || !insideScope)) {
      rejected.push({
        ...proposal,
        code: "delegation_scope_denied",
        reason: "This contributor may not mutate that path outside the owner's explicit delegation."
      });
    } else if (!mutation && !toolAllowed) {
      rejected.push({
        ...proposal,
        code: "delegation_scope_denied",
        reason: "This contributor's delegation does not authorize file observations."
      });
    } else {
      accepted.push(proposal);
    }
  }
  return { accepted, rejected };
}

function applyCollaborationFileScope(fileOperationResult, state, agent) {
  const collaboration = collaborationRequirementStatus(state);
  if (!collaboration.pending || !collaboration.beforeFirstMutation || agent?.id !== state?.executorId) return fileOperationResult;
  const accepted = [];
  const rejected = [...(fileOperationResult.rejected || [])];
  for (const proposal of fileOperationResult.accepted || []) {
    const mutation = !["read", "list"].includes(String(proposal.op || "").toLowerCase());
    if (!mutation) {
      accepted.push(proposal);
      continue;
    }
    rejected.push({
      ...proposal,
      code: "collaboration_prerequisite_pending",
      reason: collaboration.nextAction
    });
  }
  return { accepted, rejected };
}

function delegationPathAllowed(value, allowedPaths = []) {
  const candidate = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return (allowedPaths || []).some((allowed) => {
    const root = String(allowed || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return root && (candidate === root || candidate.startsWith(`${root}/`));
  });
}

function formatDisplayText(agent, response) {
  const content = response.status === "skip"
    ? (response.reason || "No new objection.")
    : response.status === "error" || response.status === "unavailable"
      ? (response.reason || "Agent unavailable.")
      : (response.argument || response.position || "I have an update.");
  return `${agent.name}\u8bf4\uff1a${content}`;
}

function limitMemoryCandidates(candidates) {
  const seen = new Set();
  const cleaned = [];
  for (const candidate of candidates ?? []) {
    const text = String(candidate ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
    if (cleaned.length >= 5) break;
  }
  return cleaned;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  throw error;
}

function redactGroupForSession(group) {
  return {
    ...group,
    agents: group.agents.map((agent) => {
      const { apiKey, ...safeAgent } = agent;
      return {
        ...safeAgent,
        ...(apiKey ? { apiKeySet: true } : {})
      };
    })
  };
}
