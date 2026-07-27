import { isReviewerLike } from "./objectionLedger.js";
import { formatFileAttachmentsForPrompt, normalizeFileAttachments } from "./attachments.js";
import { estimateMessagesTokens, estimateTokens, hasCoreOverflow, resolveEffectiveLimits } from "./tokenLimits.js";
import { formatTaskStateForPrompt } from "./taskState.js";

const DEFAULT_RECENT_MESSAGES = 6;
const DEFAULT_ACTIVE_WORKING_MEMORY_TOKENS = 900;
const MAX_ACTIVE_WORKING_MEMORY_TOKENS = 1400;
const MAX_ACTIVE_WORKING_MEMORY_ROUND_ANCHORS = 8;
const MAX_ACTIVE_WORKING_MEMORY_MEMBER_ANCHORS = 2;
const DEFAULT_ARCHIVE_CONTEXT_ITEMS = 5;
const DEFAULT_ARCHIVE_CONTEXT_TOKENS = 900;
const MAX_TOOL_CONTEXT_STRING_CHARS = 4000;
const DEFAULT_EVIDENCE_STRING_CHARS = 1600;
const MAX_EXECUTION_EVIDENCE_TOKEN_RATIO = 0.45;
const EXECUTION_EVIDENCE_RESERVE_TOKENS = 160;
// This is a result-view safeguard, not a claimed provider context capacity.
// Unknown provider limits must not erase fresh tool evidence or create an
// artificial core-overflow failure.
const UNKNOWN_LIMIT_EVIDENCE_TOKENS = 2400;

export function buildMemberContext(agent, session, options = {}) {
  const limits = resolveEffectiveLimits(agent, options.groupSettings || {}, options.providerUsageCalibration);
  const originalQuestion = session.question || options.question || "";
  const latestBossInstruction = options.latestBossInstruction || "";
  const transcriptVisibility = normalizeTranscriptVisibility(options.transcriptVisibility);
  const priorityPolicy = buildContextPriorityPolicy(options);
  const continuationSelection = selectContinuationContext(normalizeContinuationContext(options.continuationContext), priorityPolicy);
  const summarySelection = selectSummaryContext(options, priorityPolicy, agent, session);
  const candidateMessages = selectVisibleMessages([
    ...(Array.isArray(session.interimMessages) ? session.interimMessages : []),
    ...(Array.isArray(session.messages) ? session.messages : [])
  ].sort((a, b) => new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()), agent, transcriptVisibility);
  const transcriptSelection = excludeInvalidatedContextItems(candidateMessages, (message, index) => transcriptSource(message, String(session?.id || "active-session"), index), priorityPolicy);
  const visibleMessages = transcriptSelection.items;
  const latestArtifacts = selectLatestArtifacts(selectVisibleArtifacts(session.artifacts || [], agent, transcriptVisibility));
  const unresolvedObjections = selectVisibleObjections(session.unresolvedObjections || {}, agent, transcriptVisibility);
  const visibleFileOperationExecutionResults = selectVisibleFileOperationResults(session.fileOperationExecutionResults || [], agent, transcriptVisibility);
  const visibleToolExecutionResults = selectVisibleToolResults(session.toolExecutionResults || [], agent, transcriptVisibility);
  const visibleRejectedToolRequests = selectVisibleToolResults(session.rejectedToolRequests || [], agent, transcriptVisibility);
  const currentTurnGroups = {
    toolExecutionResults: selectVisibleToolResults(options.currentTurnToolResults || [], agent, transcriptVisibility),
    rejectedToolRequests: selectVisibleToolResults(options.currentTurnRejectedToolRequests || [], agent, transcriptVisibility)
  };
  const attachedFiles = normalizeFileAttachments(options.attachments || []);
  const retrievedSelection = excludeInvalidatedContextItems(options.retrievedContext || [], retrievedContextSource, priorityPolicy);
  const hotCacheSelection = excludeInvalidatedContextItems(options.publicEventHotCache?.events || [], (item) => contextSource("public_event", item?.eventId || item?.sequence, {
    sessionId: item?.sessionId,
    eventId: item?.eventId,
    sourcePath: item?.sourcePath,
    round: item?.round,
    sourceType: item?.type
  }), priorityPolicy);
  const stable = {
    roleIdentity: roleIdentity(agent),
    roleAssignment: roleAssignmentLine(agent),
    memberName: agent.name,
    roleInstructions: agent.instructions || agent.roleDescription || "",
    globalRequirement: options.globalRequirement || "",
    harnessSummary: options.harnessSummary || "",
    contextPriorityPolicy: formatContextPriorityPolicy(priorityPolicy)
  };
  const coreBase = {
    originalQuestion,
    latestBossInstruction,
    latestArtifacts,
    unresolvedObjections,
    executionStandard: options.executionStandard || "",
    verificationStandard: options.verificationStandard || "",
    executionCheckpointEvidence: normalizeExecutionCheckpointEvidence(session.executionState?.checkpointEvidence),
    fileOperationExecutionResults: [],
    toolExecutionResults: [],
    rejectedToolRequests: [],
    taskState: options.taskState || {},
    attachedFiles
  };
  const summaries = {
    memberShortSummary: summarySelection.member.text,
    groupSharedSummary: summarySelection.group.text,
    compressedTranscriptChunks: summarySelection.chunks,
    publicMemorySummary: summarySelection.publicMemory.text,
    summaryContext: summarySelection,
    continuationContext: continuationSelection.context,
    continuationContextSelection: continuationSelection,
    retrievedContext: buildRetrievedContextPack(retrievedSelection.items, {
      maxItems: options.retrievedContextLimit || options.groupSettings?.contextArchiveInjectionLimit || options.groupSettings?.contextSearchLimit,
      maxTokens: options.retrievedContextMaxTokens || options.groupSettings?.contextArchiveInjectionTokens,
      tokenEstimateOptions: limits
    }),
    historyCatalogue: normalizeHistoryCatalogue(options.historyCatalogue),
    publicEventHotCache: normalizePublicEventHotCache({ ...(options.publicEventHotCache || {}), events: hotCacheSelection.items }, options.groupSettings?.publicEventHotCacheLimit),
    privateBossMessages: Array.isArray(options.privateBossMessages) ? options.privateBossMessages : [],
    enabledSkills: String(options.enabledSkills || "").trim()
  };
  const requestedRecentTranscript = selectRecentTranscript(visibleMessages, options.recentMessageLimit ?? options.groupSettings?.recentMessageLimit);
  const activeWorkingMemory = buildActiveWorkingMemory({
    messages: visibleMessages,
    recentTranscript: requestedRecentTranscript,
    sessionId: String(session?.id || "active-session"),
    limits,
    configuredMaxTokens: options.activeWorkingMemoryTokens ?? options.groupSettings?.activeWorkingMemoryTokens
  });
  summaries.activeWorkingMemory = activeWorkingMemory;
  const stableMessages = contextMessagesFromStable(stable);
  const currentTurnEvidenceBudget = resolveCurrentTurnEvidenceBudget({
    limits,
    stableMessages,
    coreBase,
    summaries
  });
  const currentTurnEvidence = buildCurrentTurnEvidencePack(currentTurnGroups, currentTurnEvidenceBudget, limits);
  const currentTurnSignatures = new Set(currentTurnEvidence.sourceRecords.map((item) => currentTurnEvidenceIdentity(item.kind, item.item)));
  const currentTurnMessages = contextMessagesFromCurrentTurnEvidence(currentTurnEvidence);
  const executionEvidenceBudget = resolveExecutionEvidenceBudget({
    limits,
    stableMessages,
    currentTurnMessages,
    coreBase,
    summaries
  });
  const executionEvidence = buildExecutionEvidencePack({
    fileOperationExecutionResults: visibleFileOperationExecutionResults,
    toolExecutionResults: visibleToolExecutionResults.filter((item) => !currentTurnSignatures.has(currentTurnEvidenceIdentity("tool", item))),
    rejectedToolRequests: visibleRejectedToolRequests.filter((item) => !currentTurnSignatures.has(currentTurnEvidenceIdentity("rejected", item)))
  }, executionEvidenceBudget, limits);
  const currentInstructionSource = contextSource("session_question", String(session?.id || "active-session"), {
    sessionId: String(session?.id || "active-session")
  });
  const provisionalInvalidationSourceRefs = buildInvalidationSourceRefs({
    session,
    recentTranscript: requestedRecentTranscript,
    retrievedContext: summaries.retrievedContext.items,
    summarySources: summarySelection.sources,
    continuationSources: continuationSelection.sources,
    publicEvents: summaries.publicEventHotCache.events,
    activeWorkingMemorySources: activeWorkingMemory.sources
  });
  const core = {
    ...coreBase,
    fileOperationExecutionResults: executionEvidence.fileOperationExecutionResults,
    toolExecutionResults: executionEvidence.toolExecutionResults,
    rejectedToolRequests: executionEvidence.rejectedToolRequests,
    executionEvidenceCompression: executionEvidence.compression,
    currentInstructionSource,
    invalidationSourceRefs: provisionalInvalidationSourceRefs
  };
  let coreMessages = contextMessagesFromCore(core);
  const summaryMessages = contextMessagesFromSummaries(summaries);
  const recentTranscript = fitRecentTranscriptToLimit({
    stableMessages,
    currentTurnMessages,
    coreMessages,
    summaryMessages,
    recentTranscript: requestedRecentTranscript,
    limits
  });
  // Source pointers must refer only to content that is actually retained in
  // this prompt. The first pass budgets conservatively; this pass removes
  // pointers for transcript entries that did not fit before final accounting.
  core.invalidationSourceRefs = buildInvalidationSourceRefs({
    session,
    recentTranscript,
    retrievedContext: summaries.retrievedContext.items,
    summarySources: summarySelection.sources,
    continuationSources: continuationSelection.sources,
    publicEvents: summaries.publicEventHotCache.events,
    activeWorkingMemorySources: activeWorkingMemory.sources
  });
  coreMessages = contextMessagesFromCore(core);
  const recentMessages = recentTranscript.map((message) => ({
    role: "user",
    content: formatTranscriptMessage(message)
  }));
  const tokenEstimate = {
    stable: estimateMessagesTokens(stableMessages, limits),
    currentTurnEvidence: estimateMessagesTokens(currentTurnMessages, limits),
    core: estimateMessagesTokens(coreMessages, limits),
    summaries: estimateMessagesTokens(summaryMessages, limits),
    recentTranscript: estimateMessagesTokens(recentMessages, limits)
  };
  const nonCompressibleCoreTokens = tokenEstimate.stable + tokenEstimate.currentTurnEvidence + tokenEstimate.core;

  const context = {
    agentId: agent.id,
    agentName: agent.name,
    mandatoryRedTeam: Boolean(agent.mandatoryRedTeam),
    transcriptVisibility,
    limits,
    stable,
    core,
    summaries,
    currentTurnEvidence,
    recentTranscript,
    compression: {
      applied: recentTranscript.length < requestedRecentTranscript.length,
      originalRecentMessages: requestedRecentTranscript.length,
      keptRecentMessages: recentTranscript.length,
      droppedRecentMessages: requestedRecentTranscript.length - recentTranscript.length,
      targetTokens: compressionTargetTokens(limits)
    },
    archiveContextCompression: summaries.retrievedContext.compression,
    currentTurnEvidenceCompression: currentTurnEvidence.compression,
    executionEvidenceCompression: executionEvidence.compression,
    tokenEstimate: {
      ...tokenEstimate,
      nonCompressibleCore: nonCompressibleCoreTokens,
      total: tokenEstimate.stable + tokenEstimate.currentTurnEvidence + tokenEstimate.core + tokenEstimate.summaries + tokenEstimate.recentTranscript
    },
    coreOverflow: hasCoreOverflow(nonCompressibleCoreTokens, limits),
    priorityPolicy,
    providerCacheBreakpoint: "after_original_question",
    currentInstructionSource: core.currentInstructionSource,
    invalidationSourceRefs: core.invalidationSourceRefs
  };
  context.contextReceipt = buildContextReceiptDraft({
    agent,
    session,
    options,
    context,
    visibleMessages,
    requestedRecentTranscript,
    recentTranscript,
    executionEvidence,
    currentTurnEvidence,
    invalidatedSources: [
      ...transcriptSelection.invalidated,
      ...retrievedSelection.invalidated,
      ...hotCacheSelection.invalidated,
      ...summarySelection.invalidated,
      ...continuationSelection.invalidated
    ]
  });
  return context;
}

export function materializeContextReceipt(context, details = {}) {
  const draft = context?.contextReceipt || {};
  const inputMessages = Array.isArray(details.inputMessages) ? details.inputMessages : [];
  const inputChars = inputMessages.reduce((total, message) => total + contextMessageChars(message), 0);
  return {
    ...structuredClone(draft),
    id: `${String(details.sessionId || "session")}::context::${Number(details.modelCallIndex || 0)}`,
    call: {
      sessionId: String(details.sessionId || ""),
      modelCallIndex: Number(details.modelCallIndex || 0),
      phase: String(details.phase || ""),
      round: Number(details.round || 0),
      toolIteration: Number(details.toolIteration || 0),
      agentId: String(details.agentId || context?.agentId || ""),
      inputMessageCount: inputMessages.length,
      inputChars,
      estimatedInputTokens: estimateMessagesTokens(inputMessages, context?.limits || {}),
      inputEstimateMultiplier: Number(context?.limits?.inputEstimateMultiplier || 1)
    }
  };
}

function buildContextReceiptDraft({ agent, session, options, context, visibleMessages, requestedRecentTranscript, recentTranscript, executionEvidence, currentTurnEvidence, invalidatedSources = [] }) {
  const sections = buildContextPromptSections(context);
  const sourcesBySection = contextSourcesBySection({ agent, session, options, context, recentTranscript, executionEvidence });
  const totalTokens = sections.reduce((total, section) => total + estimateTokens(section.content, context.limits), 0);
  const targetTokens = compressionTargetTokens(context.limits) || context.limits.effectiveInputLimit;
  const sectionReceipts = sections.map((section) => {
    const tokens = estimateTokens(section.content, context.limits);
    const id = contextSectionId(section.title);
    return {
      id,
      title: section.title,
      chars: section.content.length,
      estimatedTokens: tokens,
      retainedTokenShare: totalTokens ? Number((tokens / totalTokens).toFixed(6)) : 0,
      sourceCount: (sourcesBySection[id] || []).length,
      sources: sourcesBySection[id] || []
    };
  });
  const sectionDecisions = sectionReceipts.flatMap((section) => section.sources.map((source) => ({
    section: section.id,
    source,
    status: "injected",
    reason: `retained_in_${section.id}`
  })));
  const decisions = mergeReceiptDecisions(sectionDecisions, [
    ...buildTranscriptReceiptDecisions(session, visibleMessages, requestedRecentTranscript, recentTranscript),
    ...(executionEvidence.receipt?.decisions || []),
    ...(currentTurnEvidence.receipt?.decisions || []),
    ...(context.summaries.retrievedContext.receipt?.decisions || []),
    ...(context.summaries.summaryContext?.decisions || []),
    ...(context.summaries.activeWorkingMemory?.decisions || []),
    ...(context.summaries.continuationContextSelection?.decisions || [])
  ]);
  return {
    schema: "ai-council.context-receipt.v1",
    builder: "buildMemberContext",
    agentId: String(agent?.id || ""),
    transcriptVisibility: context.transcriptVisibility,
    budget: {
      contextWindow: context.limits.contextWindow ?? null,
      effectiveInputLimit: context.limits.effectiveInputLimit ?? null,
      inputLimitKnown: Boolean(context.limits.inputLimitKnown),
      inputLimitSource: context.limits.inputLimitSource || "unknown",
      compressionTargetTokens: targetTokens ?? null,
      inputEstimateMultiplier: Number(context.limits.inputEstimateMultiplier || 1),
      inputEstimateCalibration: context.limits.inputEstimateCalibration || { status: "unavailable", sampleCount: 0 },
      estimatedContextTokens: Number(context.tokenEstimate.total || 0),
      nonCompressibleCoreTokens: Number(context.tokenEstimate.nonCompressibleCore || 0),
      coreOverflow: Boolean(context.coreOverflow)
    },
    sections: sectionReceipts,
    decisions,
    observability: {
      notRetrieved: "not_observed_by_buildMemberContext; only retrieval candidates supplied to this call can be classified",
      exactSourceLoading: "use retained session/event/archive pointers; receipt stores no prompt or private-message content"
    },
    policy: {
      conflicts: context.priorityPolicy.conflicts,
      invalidatedSources,
      priorityDecisions: [
        ...context.priorityPolicy.priorityDecisions,
        {
          rule: "existing_context_builder_section_order",
          selectedSections: sectionReceipts.map((section) => section.id)
        }
      ]
    },
    privacy: {
      privateBossMessages: context.summaries.privateBossMessages.length ? "injected_source_redacted" : "none",
      credentialContent: "never_recorded"
    }
  };
}

function mergeReceiptDecisions(base, specific) {
  const byKey = new Map();
  for (const decision of base) byKey.set(receiptDecisionKey(decision), decision);
  for (const decision of specific) byKey.set(receiptDecisionKey(decision), decision);
  return [...byKey.values()];
}

function receiptDecisionKey(decision = {}) {
  const source = decision.source || {};
  return [decision.section || "", source.type || "", source.id || ""].join("\u001f");
}

function buildContextPriorityPolicy(options = {}) {
  const invalidations = normalizeContextInvalidations(options.contextInvalidations || options.contextPolicy?.invalidations);
  return {
    tiers: [
      "current_user_instruction",
      "active_user_confirmed_requirement",
      "current_file_test_git_tool_evidence",
      "current_task_execution_state",
      "non_invalidated_retained_user_statement",
      "member_message",
      "attributed_summary",
      "inference"
    ],
    invalidations,
    conflicts: invalidations.map((item) => ({
      source: item.source,
      supersededBy: item.supersededBy,
      reason: item.reason
    })),
    priorityDecisions: [{
      rule: "current_instruction_outranks_retained_history",
      selectedSourceTypes: ["session_question", "latest_boss_instruction"],
      lowerPrioritySourceTypes: ["member_message", "retrieved_context", "public_event", "member_summary", "group_summary"]
    }]
  };
}

function normalizeContextInvalidations(value) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map((entry) => {
    const source = normalizeContextSourceReference(entry?.source || entry);
    const supersededBy = normalizeContextSourceReference(entry?.supersededBy || entry?.superseded_by);
    return {
      source,
      supersededBy,
      reason: String(entry?.reason || "explicit_source_invalidation").trim()
    };
  }).filter((item) => item.source.type && item.source.id && item.supersededBy.type && item.supersededBy.id);
}

function normalizeContextSourceReference(value = {}) {
  return {
    type: String(value?.type || value?.sourceType || "").trim(),
    id: String(value?.id || value?.eventId || value?.sourceId || "").trim()
  };
}

function excludeInvalidatedContextItems(items, sourceFor, policy) {
  const kept = [];
  const invalidated = [];
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    const source = sourceFor(item, index);
    const invalidation = matchingContextInvalidation(policy, source);
    if (!invalidation) {
      kept.push(item);
      continue;
    }
    invalidated.push({
      source,
      supersededBy: invalidation.supersededBy,
      reason: invalidation.reason,
      status: "invalidated"
    });
  }
  return { items: kept, invalidated };
}

function matchingContextInvalidation(policy = {}, source = {}) {
  return (Array.isArray(policy.invalidations) ? policy.invalidations : []).find((candidate) => (
    sameContextSource(candidate?.source, source)
  ));
}

function sameContextSource(left = {}, right = {}) {
  const leftType = String(left?.type || "");
  const rightType = String(right?.type || "");
  const leftId = String(left?.id || "");
  const rightId = String(right?.id || "");
  if (!leftType || !rightType || !leftId || !rightId) return false;
  if (leftType === rightType && leftId === rightId) return true;
  // A retained journal event can be surfaced either by archive retrieval or
  // by the hot public-event cache. They share the event id, so an accepted
  // replacement must suppress both prompt representations without deleting
  // the underlying historical record.
  const eventViews = new Set(["retrieved_context", "public_event"]);
  return leftId === rightId && eventViews.has(leftType) && eventViews.has(rightType);
}

function selectSummaryContext(options, policy, agent, session) {
  const sessionId = String(session?.id || "active-session");
  const member = selectAttributedSummary({
    text: options.memberShortSummary,
    record: options.memberShortSummaryRecord,
    cacheSource: contextSource("member_summary", agent?.id || agent?.name || "unknown", {
      sessionId,
      sourcePath: "members/private_memory/short-summary.md"
    }),
    section: "summaries"
  }, policy);
  const group = selectAttributedSummary({
    text: options.groupSharedSummary,
    record: options.groupSharedSummaryRecord,
    cacheSource: contextSource("group_summary", sessionId, {
      sessionId,
      sourcePath: "shared/cache/shared-summary.md"
    }),
    section: "summaries"
  }, policy);
  const chunks = (Array.isArray(options.compressedTranscriptChunks) ? options.compressedTranscriptChunks : [])
    .map((chunk, index) => {
      const selected = selectAttributedSummary({
        text: chunk?.summary,
        record: chunk,
        cacheSource: contextSource("compressed_transcript_chunk", chunk?.id || `${sessionId}:chunk:${index}`, {
          sessionId: String(chunk?.sourceSessionId || sessionId),
          sourcePath: "shared/cache/compressed-transcript.jsonl"
        }),
        section: "summaries"
      }, policy);
      return { chunk, selected };
    });
  const publicMemory = selectAttributedSummary({
    text: options.publicMemorySummary,
    cacheSource: contextSource("public_memory_summary", sessionId, {
      sessionId,
      sourcePath: "shared/memory/public-memory.json"
    }),
    section: "summaries"
  }, policy);
  const eligibleChunks = chunks.filter((item) => item.selected.text);
  const renderedChunkEntries = eligibleChunks.slice(-3);
  const omittedChunkDecisions = eligibleChunks.slice(0, -3).map((item) => ({
    section: "summaries",
    source: item.selected.sources[0],
    status: "retrieved_but_omitted",
    reason: "compressed_transcript_limit"
  }));
  return {
    member,
    group,
    chunks: renderedChunkEntries.map((item) => item.chunk),
    publicMemory,
    sources: [
      ...member.sources,
      ...group.sources,
      ...renderedChunkEntries.flatMap((item) => item.selected.sources),
      ...publicMemory.sources
    ],
    decisions: [
      ...member.decisions,
      ...group.decisions,
      ...chunks.flatMap((item) => item.selected.decisions),
      ...omittedChunkDecisions,
      ...publicMemory.decisions
    ],
    invalidated: [
      ...member.invalidated,
      ...group.invalidated,
      ...chunks.flatMap((item) => item.selected.invalidated),
      ...publicMemory.invalidated
    ]
  };
}

function selectContinuationContext(context, policy) {
  if (!context?.previousSessionId) return { context: null, sources: [], decisions: [], invalidated: [] };
  const cacheSource = contextSource("continuation", context.previousSessionId, {
    sessionId: context.previousSessionId,
    sourcePath: context.sourcePath
  });
  const sourceRefs = normalizeSummarySourceRefs(context.sourceRefs);
  const candidates = [cacheSource, ...sourceRefs];
  const invalidatedMatches = candidates.map((source) => ({
    source,
    invalidation: matchingContextInvalidation(policy, source)
  })).filter((item) => item.invalidation);
  if (invalidatedMatches.length) {
    return {
      context: continuationReferenceOnly(context),
      sources: [cacheSource],
      decisions: invalidatedMatches.map((item) => ({
        section: "cycle_continuation",
        source: item.source,
        status: "invalidated",
        reason: "source_invalidated_in_continuation"
      })),
      invalidated: invalidatedMatches.map((item) => ({
        source: item.source,
        supersededBy: item.invalidation.supersededBy,
        reason: item.invalidation.reason,
        status: "invalidated"
      }))
    };
  }
  if (policy.invalidations.length && context.provenance !== "attributed") {
    return {
      context: continuationReferenceOnly(context),
      sources: [cacheSource],
      decisions: [{
        section: "cycle_continuation",
        source: cacheSource,
        status: "shortened",
        reason: "continuation_provenance_missing_under_invalidation"
      }],
      invalidated: []
    };
  }
  return { context, sources: candidates, decisions: [], invalidated: [] };
}

function continuationReferenceOnly(context) {
  return {
    previousSessionId: context.previousSessionId,
    sourcePath: context.sourcePath,
    sourceRefs: context.sourceRefs,
    provenance: context.provenance,
    previousQuestion: "",
    previousStatus: "",
    finalState: "",
    finalAnswer: "",
    summary: "",
    blockingIssues: [],
    risks: [],
    nextActions: [],
    participantMessages: [],
    recentMessages: [],
    recentActivity: []
  };
}

function selectAttributedSummary(candidate, policy) {
  const record = candidate.record && typeof candidate.record === "object" ? candidate.record : {};
  const text = String(candidate.text || record.text || record.summary || "").trim();
  if (!text) return { text: "", sources: [], decisions: [], invalidated: [] };
  const sourceRefs = normalizeSummarySourceRefs(record.sourceRefs || record.sources);
  const provenance = String(record.provenance || (sourceRefs.length ? "attributed" : "unattributed")).trim();
  const invalidatedMatches = sourceRefs.map((source) => ({
    source,
    invalidation: matchingContextInvalidation(policy, source)
  })).filter((item) => item.invalidation);
  if (invalidatedMatches.length) {
    const invalidated = invalidatedMatches.map(({ source, invalidation }) => ({
      source,
      supersededBy: invalidation.supersededBy,
      reason: invalidation.reason,
      status: "invalidated"
    }));
    return {
      text: "",
      sources: [],
      decisions: invalidated.map((item) => ({
        section: candidate.section,
        source: item.source,
        status: "invalidated",
        reason: "source_invalidated_in_attributed_summary"
      })),
      invalidated
    };
  }
  if (policy.invalidations.length && provenance !== "attributed") {
    return {
      text: "",
      sources: [],
      decisions: [{
        section: candidate.section,
        source: candidate.cacheSource,
        status: "retrieved_but_omitted",
        reason: "summary_provenance_missing_under_invalidation"
      }],
      invalidated: []
    };
  }
  return {
    text,
    sources: [candidate.cacheSource, ...sourceRefs],
    decisions: [],
    invalidated: []
  };
}

function normalizeSummarySourceRefs(value) {
  const seen = new Set();
  const refs = [];
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    const type = String(item?.type || item?.sourceType || "").trim();
    const id = String(item?.id || item?.eventId || item?.sourceId || "").trim();
    if (!type || !id || seen.has(`${type}\u001f${id}`)) continue;
    seen.add(`${type}\u001f${id}`);
    refs.push({ type, id });
  }
  return refs;
}

function formatContextPriorityPolicy(policy = {}) {
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (!tiers.length) return "";
  return `Context priority is strict: ${tiers.join(" > ")}. Current user instructions override conflicting retained history. Only validated, source-specific replacement records exclude retained sources; invalidated sources remain loadable from retained history by their exact source pointer.`;
}

function buildInvalidationSourceRefs({ session, recentTranscript, retrievedContext, summarySources, continuationSources, publicEvents, activeWorkingMemorySources }) {
  const sessionId = String(session?.id || "active-session");
  const candidates = [
    ...(Array.isArray(recentTranscript) ? recentTranscript.map((message, index) => transcriptSource(message, sessionId, index)) : []),
    ...(Array.isArray(activeWorkingMemorySources) ? activeWorkingMemorySources : []),
    ...(Array.isArray(retrievedContext) ? retrievedContext.map(retrievedContextSource) : []),
    ...(Array.isArray(summarySources) ? summarySources : []),
    ...(Array.isArray(continuationSources) ? continuationSources : []),
    ...(Array.isArray(publicEvents) ? publicEvents.map((item) => contextSource("public_event", item?.eventId || item?.sequence, {
      sessionId: item?.sessionId,
      eventId: item?.eventId,
      sourcePath: item?.sourcePath,
      round: item?.round,
      sourceType: item?.type
    })) : [])
  ];
  const blockedTypes = new Set([
    "agent_config",
    "member_summary",
    "group_summary",
    "public_memory_summary",
    "continuation",
    "enabled_skill_metadata",
    "attachment",
    "artifact",
    "execution_checkpoint_evidence",
    "tool_result",
    "file_operation_result",
    "rejected_tool_request"
  ]);
  const seen = new Set();
  return candidates.filter((source) => {
    const type = String(source?.type || "").trim();
    const id = String(source?.id || "").trim();
    const key = `${type}\u001f${id}`;
    if (!type || !id || blockedTypes.has(type) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

function formatContextSourceReferences(context = {}) {
  const current = context.currentInstructionSource;
  const retained = Array.isArray(context.invalidationSourceRefs) ? context.invalidationSourceRefs : [];
  if (!current || !retained.length) return [];
  return [
    "These exact retained source references are eligible only for source-specific context replacement when the current user instruction makes their instruction non-authoritative. They are not an instruction to discard sources.",
    `Current user instruction source: ${JSON.stringify(current)}`,
    ...retained.map((source) => `Retained source_ref=${JSON.stringify({
      type: source.type,
      id: source.id,
      sessionId: source.sessionId,
      round: source.round,
      sourcePath: source.sourcePath
    })}`)
  ];
}

function contextSourcesBySection({ agent, session, options, context, recentTranscript, executionEvidence }) {
  const sessionId = String(session?.id || "active-session");
  const coreSources = [
    contextSource("session_question", sessionId, { sessionId }),
    ...(context.core.latestBossInstruction ? [contextSource("latest_boss_instruction", `${sessionId}:latest`, { sessionId })] : []),
    ...context.core.latestArtifacts.map((item, index) => contextSource("artifact", item?.id || `${sessionId}:artifact:${index}`, { sessionId, sourcePath: item?.sourcePath, path: item?.path })),
    ...objectionSources(context.core.unresolvedObjections, sessionId),
    ...context.core.attachedFiles.map((item, index) => contextSource("attachment", item?.id || `${sessionId}:attachment:${index}`, { sessionId, sourcePath: item?.path || item?.name || item?.fileName })),
    ...context.core.executionCheckpointEvidence.map((item) => contextSource("execution_checkpoint_evidence", item.id, { sessionId, path: item.target, tool: item.tool })),
    ...executionEvidenceReceiptSources(executionEvidence)
  ];
  const retrievedSources = context.summaries.retrievedContext.items.map(retrievedContextSource);
  const historySources = context.summaries.historyCatalogue.map((item) => contextSource("session_catalogue", item.sessionId, { sessionId: item.sessionId }));
  const hotCacheSources = context.summaries.publicEventHotCache.events.map((item) => contextSource("public_event", item.eventId || item.sequence, {
    sessionId: item.sessionId,
    eventId: item.eventId,
    sourcePath: item.sourcePath,
    round: item.round,
    sourceType: item.type
  }));
  const continuation = context.summaries.continuationContext;
  return {
    stable_context: [contextSource("agent_config", agent?.id || agent?.name || "unknown", { sessionId, sourcePath: "group.agent" })],
    current_turn_tool_evidence: context.currentTurnEvidence.receipt.sources,
    non_compressible_core: coreSources,
    summaries: [
      ...(context.summaries.summaryContext?.sources || [])
    ],
    active_working_memory: context.summaries.activeWorkingMemory?.sources || [],
    relevant_archived_context: retrievedSources,
    group_history_catalogue: historySources,
    recent_public_activity_cache: hotCacheSources,
    cycle_continuation: context.summaries.continuationContextSelection?.sources
      || (continuation?.previousSessionId ? [contextSource("continuation", continuation.previousSessionId, { sessionId: continuation.previousSessionId, sourcePath: continuation.sourcePath })] : []),
    context_source_references: context.invalidationSourceRefs || [],
    private_boss_messages: [],
    enabled_skills: context.summaries.enabledSkills ? [contextSource("enabled_skill_metadata", sessionId, { sessionId })] : [],
    recent_transcript: recentTranscript.map((message, index) => transcriptSource(message, sessionId, index))
  };
}

function buildTranscriptReceiptDecisions(session, visibleMessages, requestedRecentTranscript, recentTranscript) {
  const sessionId = String(session?.id || "active-session");
  const requested = new Set(requestedRecentTranscript);
  const injected = new Set(recentTranscript);
  return visibleMessages.map((message, index) => ({
    section: "recent_transcript",
    source: transcriptSource(message, sessionId, index),
    status: injected.has(message) ? "injected" : "retrieved_but_omitted",
    reason: injected.has(message)
      ? "selected_recent_transcript"
      : requested.has(message)
        ? "context_token_budget"
        : "recent_message_limit"
  }));
}

function executionEvidenceReceiptSources(executionEvidence) {
  return (executionEvidence.receipt?.decisions || [])
    .filter((item) => item.status === "injected" || item.status === "shortened")
    .map((item) => item.source);
}

function objectionSources(value, sessionId) {
  return Object.entries(value || {}).flatMap(([agentId, items]) => (Array.isArray(items) ? items : [items]).map((item, index) => {
    const id = typeof item === "object" ? item.id || item.issue || index : index;
    return contextSource("objection", `${agentId}:${id}`, { sessionId });
  }));
}

function transcriptSource(message, sessionId, index) {
  return contextSource("member_message", message?.id || `${sessionId}:message:${message?.modelCallIndex || index}`, {
    sessionId,
    agentId: message?.agentId,
    round: message?.round
  });
}

function retrievedContextSource(item) {
  return contextSource("retrieved_context", item?.eventId || item?.sourcePath || `${item?.sessionId || "unknown"}:${item?.round || 0}`, {
    sessionId: item?.sessionId,
    eventId: item?.eventId,
    sourcePath: item?.sourcePath,
    round: item?.round,
    sourceType: item?.sourceType
  });
}

function contextSource(type, id, details = {}) {
  const source = { type, id: String(id || "unknown") };
  for (const key of ["sessionId", "eventId", "sourcePath", "path", "agentId", "round", "sourceType"]) {
    const value = details[key];
    if (value !== undefined && value !== null && value !== "") source[key] = value;
  }
  return source;
}

function contextSectionId(title) {
  return String(title || "context").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function contextMessageChars(message = {}) {
  if (typeof message.content === "string") return message.content.length;
  return JSON.stringify(message.content || "").length;
}

export function buildContextPromptSections(context) {
  return [
    ["Stable context", [
      `Role: ${context.stable.roleIdentity}`,
      `Current assignment: ${context.stable.roleAssignment}`,
      `Member: ${context.stable.memberName}`,
      context.stable.roleInstructions ? `Role instructions: ${context.stable.roleInstructions}` : "",
      context.stable.harnessSummary ? `Harness summary: ${context.stable.harnessSummary}` : "",
      context.stable.globalRequirement ? `Boss global requirement: ${context.stable.globalRequirement}` : "",
      context.stable.contextPriorityPolicy ? `Context priority: ${context.stable.contextPriorityPolicy}` : ""
    ]],
    ["Current-turn tool evidence", [
      context.currentTurnEvidence.records.length
        ? "These are the immediately preceding tool results. They are newer and authoritative over task summaries, retained history, and earlier tool evidence. Use these exact values for the next action."
        : "",
      context.currentTurnEvidence.toolExecutionResults.length
        ? `Tool execution results (current turn): ${JSON.stringify(context.currentTurnEvidence.toolExecutionResults)}`
        : "",
      context.currentTurnEvidence.rejectedToolRequests.length
        ? `Rejected tool requests (current turn): ${JSON.stringify(context.currentTurnEvidence.rejectedToolRequests)}`
        : ""
    ]],
    ["Non-compressible core", [
      context.core.latestBossInstruction ? `Latest boss instruction: ${context.core.latestBossInstruction}` : "",
      `Latest artifacts: ${JSON.stringify(context.core.latestArtifacts)}`,
      `Unresolved objections: ${JSON.stringify(context.core.unresolvedObjections)}`,
      context.core.executionStandard ? `Execution standard: ${context.core.executionStandard}` : "",
      context.core.verificationStandard ? `Verification standard: ${context.core.verificationStandard}` : "",
      context.core.executionCheckpointEvidence?.length ? `Current execution checkpoint evidence (newer than task-state history): ${JSON.stringify(context.core.executionCheckpointEvidence)}` : "",
      context.core.attachedFiles?.length ? `User attached files:\n${formatFileAttachmentsForPrompt(context.core.attachedFiles)}` : "",
      context.core.fileOperationExecutionResults?.length ? `File operation execution results: ${JSON.stringify(context.core.fileOperationExecutionResults)}` : "",
      context.core.toolExecutionResults?.length ? `Tool execution results: ${JSON.stringify(context.core.toolExecutionResults)}` : "",
      context.core.rejectedToolRequests?.length ? `Rejected tool requests: ${JSON.stringify(context.core.rejectedToolRequests)}` : "",
      formatExecutionEvidenceCompression(context.core.executionEvidenceCompression),
      formatTaskStateForPrompt(context.core.taskState) ? `Task state ledger:\n${formatTaskStateForPrompt(context.core.taskState)}` : ""
    ]],
    ["Context source references", formatContextSourceReferences(context)],
    ["Summaries", [
      context.summaries.memberShortSummary ? `Member summary: ${context.summaries.memberShortSummary}` : "",
      context.summaries.groupSharedSummary ? `Group summary: ${context.summaries.groupSharedSummary}` : "",
      ...formatCompressedTranscriptChunks(context.summaries.compressedTranscriptChunks),
      context.summaries.publicMemorySummary ? `Public memory summary: ${context.summaries.publicMemorySummary}` : ""
    ]],
    ["Active working memory", formatActiveWorkingMemory(context.summaries.activeWorkingMemory)],
    ["Relevant archived context", formatRetrievedContext(context.summaries.retrievedContext)],
    ["Group history catalogue", formatHistoryCatalogue(context.summaries.historyCatalogue)],
    ["Recent public activity cache", formatPublicEventHotCache(context.summaries.publicEventHotCache)],
    ["Cycle continuation", formatContinuationContext(context.summaries.continuationContext)],
    ["Private boss messages", context.summaries.privateBossMessages.map(formatPrivateBossMessage)],
    ["Enabled skills", context.summaries.enabledSkills ? [context.summaries.enabledSkills] : []],
    ["Recent transcript", context.recentTranscript.map(formatTranscriptMessage)]
  ].map(([title, lines]) => ({
    title,
    content: lines.filter(Boolean).join("\n")
  })).filter((section) => section.content);
}

function selectLatestArtifacts(artifacts) {
  const latestByKey = new Map();
  for (const artifact of artifacts) {
    const key = `${artifact.type || "text"}:${artifact.title || artifact.source_agent_id || artifact.id || "artifact"}`;
    const previous = latestByKey.get(key);
    if (!previous || (artifact.round || 0) >= (previous.round || 0)) {
      latestByKey.set(key, artifact);
    }
  }
  return [...latestByKey.values()];
}

function normalizeTranscriptVisibility(value) {
  return value === "own" ? "own" : "full";
}

function selectVisibleMessages(messages, agent, visibility) {
  if (visibility === "full") return messages;
  return messages.filter((message) => message.agentId === agent.id);
}

function selectVisibleArtifacts(artifacts, agent, visibility) {
  if (visibility === "full") return artifacts;
  return artifacts.filter((artifact) => artifact.source_agent_id === agent.id || artifact.agentId === agent.id);
}

function selectVisibleObjections(unresolvedObjections, agent, visibility) {
  if (visibility === "full") return unresolvedObjections;
  const own = unresolvedObjections?.[agent.id];
  return own ? { [agent.id]: own } : {};
}

function selectVisibleFileOperationResults(results, agent, visibility) {
  return visibility === "full" ? results : results.filter((item) => {
    const source = item.source_agent_id || item.sourceAgentId || item.proposedBy?.seatId || item.proposedBy?.id;
    return source === agent.id;
  });
}

function selectVisibleToolResults(results, agent, visibility) {
  return visibility === "full" ? results : results.filter((item) => {
    const source = item.source_agent_id || item.sourceAgentId || item.proposedBy?.seatId || item.proposedBy?.id;
    return source === agent.id;
  });
}

function normalizeExecutionCheckpointEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    id: String(item?.id || "").trim(),
    tool: String(item?.tool || "").trim(),
    status: String(item?.status || "").trim(),
    target: String(item?.target || "").trim(),
    outcome: String(item?.outcome || "").trim()
  })).filter((item) => item.id && item.tool).slice(-6);
}

function resolveExecutionEvidenceBudget({ limits, stableMessages, currentTurnMessages, coreBase, summaries }) {
  if (!limits?.inputLimitKnown) return UNKNOWN_LIMIT_EVIDENCE_TOKENS;
  const targetTokens = evidenceTargetTokens(limits);
  const mandatoryTokens = estimateMessagesTokens([
    ...stableMessages,
    ...currentTurnMessages,
    ...contextMessagesFromCore(coreBase),
    ...contextMessagesFromSummaries(summaries)
  ], limits);
  const available = Math.max(0, targetTokens - mandatoryTokens - EXECUTION_EVIDENCE_RESERVE_TOKENS);
  const ratioLimit = evidenceRatioLimit(limits);
  return Math.max(0, Math.min(available, ratioLimit));
}

function resolveCurrentTurnEvidenceBudget({ limits, stableMessages, coreBase, summaries }) {
  if (!limits?.inputLimitKnown) return UNKNOWN_LIMIT_EVIDENCE_TOKENS;
  const targetTokens = evidenceTargetTokens(limits);
  const mandatoryTokens = estimateMessagesTokens([
    ...stableMessages,
    ...contextMessagesFromCore(coreBase),
    ...contextMessagesFromSummaries(summaries)
  ], limits);
  const available = Math.max(0, targetTokens - mandatoryTokens - EXECUTION_EVIDENCE_RESERVE_TOKENS);
  const ratioLimit = evidenceRatioLimit(limits);
  return Math.max(0, Math.min(available, ratioLimit));
}

function evidenceTargetTokens(limits) {
  return compressionTargetTokens(limits)
    || limits?.effectiveInputLimit
    || UNKNOWN_LIMIT_EVIDENCE_TOKENS;
}

function evidenceRatioLimit(limits) {
  const inputLimit = Number(limits?.effectiveInputLimit || 0);
  return inputLimit
    ? Math.max(0, Math.floor(inputLimit * MAX_EXECUTION_EVIDENCE_TOKEN_RATIO))
    : UNKNOWN_LIMIT_EVIDENCE_TOKENS;
}

function buildExecutionEvidencePack(groups, maxTokens, tokenEstimateOptions = {}) {
  const rawFileResults = Array.isArray(groups.fileOperationExecutionResults) ? groups.fileOperationExecutionResults : [];
  const rawToolResults = Array.isArray(groups.toolExecutionResults) ? groups.toolExecutionResults : [];
  const rawRejected = Array.isArray(groups.rejectedToolRequests) ? groups.rejectedToolRequests : [];
  const dedupedFileResults = dedupeSimilarFileOperationResults(rawFileResults);
  const dedupedToolResults = dedupeSimilarToolResults(rawToolResults);
  const dedupedRejected = dedupeSimilarToolResults(rawRejected);
  let sequence = 0;
  const candidates = [
    ...dedupedFileResults.map((item) => executionEvidenceCandidate("file", item, sequence++)),
    ...dedupedToolResults.map((item) => executionEvidenceCandidate("tool", item, sequence++)),
    ...dedupedRejected.map((item) => executionEvidenceCandidate("rejected", item, sequence++))
  ];
  markPriorityExecutionEvidence(candidates);
  candidates.sort(compareExecutionEvidenceCandidate);
  const kept = [];
  let estimatedTokens = 0;
  let shortenedCount = 0;

  for (const candidate of candidates) {
    const remaining = Math.max(0, maxTokens - estimatedTokens);
    const forceKeep = remaining > 0 && candidate.priority >= 6;
    const fitted = fitExecutionEvidenceCandidate(candidate, remaining, { forceKeep, tokenEstimateOptions });
    if (!fitted) continue;
    kept.push({ ...candidate, record: fitted.record, shortened: fitted.shortened });
    estimatedTokens += fitted.tokens;
    if (fitted.shortened) shortenedCount += 1;
  }
  kept.sort((a, b) => a.sequence - b.sequence);
  const byKind = (kind) => kept.filter((item) => item.kind === kind).map((item) => item.record);
  const originalCount = rawFileResults.length + rawToolResults.length + rawRejected.length;
  const dedupedCount = candidates.length;
  const keptCount = kept.length;
  const omittedCount = Math.max(0, dedupedCount - keptCount);
  const duplicateCount = Math.max(0, originalCount - dedupedCount);

  const keptBySequence = new Map(kept.map((item) => [item.sequence, item]));
  const receiptDecisions = [
    ...deduplicatedEvidenceReceiptDecisions("file_operation_result", rawFileResults, fileOperationResultSignature),
    ...deduplicatedEvidenceReceiptDecisions("tool_result", rawToolResults, toolResultSignature),
    ...deduplicatedEvidenceReceiptDecisions("rejected_tool_request", rawRejected, toolResultSignature),
    ...candidates.map((candidate) => {
      const retained = keptBySequence.get(candidate.sequence);
      return {
        section: "non_compressible_core",
        source: executionEvidenceSource(candidate.kind, candidate.item, candidate.sequence),
        status: retained ? (retained.shortened ? "shortened" : "injected") : "retrieved_but_omitted",
        reason: retained
          ? (retained.shortened ? "evidence_value_compacted" : "execution_evidence_priority")
          : "execution_evidence_token_budget"
      };
    })
  ];
  return {
    fileOperationExecutionResults: byKind("file"),
    toolExecutionResults: byKind("tool"),
    rejectedToolRequests: byKind("rejected"),
    compression: {
      maxTokens,
      estimatedTokens,
      originalCount,
      dedupedCount,
      keptCount,
      omittedCount,
      duplicateCount,
      shortenedCount,
      originalByKind: {
        fileOperations: rawFileResults.length,
        tools: rawToolResults.length,
        rejected: rawRejected.length
      },
      keptByKind: {
        fileOperations: byKind("file").length,
        tools: byKind("tool").length,
        rejected: byKind("rejected").length
      },
      applied: duplicateCount > 0 || omittedCount > 0 || shortenedCount > 0,
      source: "complete raw results remain in session storage"
    },
    receipt: { decisions: receiptDecisions }
  };
}

function buildCurrentTurnEvidencePack(groups = {}, maxTokens = Number.POSITIVE_INFINITY, tokenEstimateOptions = {}) {
  const sourceRecords = [
    ...dedupeSimilarToolResults(Array.isArray(groups.toolExecutionResults) ? groups.toolExecutionResults : []).map((item) => ({ kind: "tool", item })),
    ...dedupeSimilarToolResults(Array.isArray(groups.rejectedToolRequests) ? groups.rejectedToolRequests : []).map((item) => ({ kind: "rejected", item }))
  ];
  const candidates = sourceRecords.map(({ kind, item }, sequence) => executionEvidenceCandidate(kind, item, sequence));
  markPriorityExecutionEvidence(candidates);
  candidates.sort(compareExecutionEvidenceCandidate);
  const kept = [];
  let estimatedTokens = 0;
  let shortenedCount = 0;
  for (const candidate of candidates) {
    const remaining = Math.max(0, maxTokens - estimatedTokens);
    const forceKeep = remaining > 0 && (candidate.priority >= 6 || kept.length === 0);
    const fitted = Number.isFinite(maxTokens)
      ? fitExecutionEvidenceCandidate(candidate, remaining, { forceKeep, tokenEstimateOptions })
      : compactExecutionEvidenceRecord(candidate.kind, candidate.item, MAX_TOOL_CONTEXT_STRING_CHARS);
    if (!fitted) continue;
    const tokens = Number.isFinite(fitted.tokens) ? fitted.tokens : estimateTokens(JSON.stringify(fitted.record), tokenEstimateOptions);
    kept.push({ ...candidate, record: fitted.record, shortened: fitted.shortened, tokens });
    estimatedTokens += tokens;
    if (fitted.shortened) shortenedCount += 1;
  }
  kept.sort((a, b) => a.sequence - b.sequence);
  const records = kept.map((item) => item.record);
  const toolExecutionResults = kept.filter((item) => item.kind === "tool").map((item) => item.record);
  const rejectedToolRequests = kept.filter((item) => item.kind === "rejected").map((item) => item.record);
  const sources = sourceRecords.map(({ kind, item }, index) => executionEvidenceSource(kind, item, index));
  const keptBySequence = new Map(kept.map((item) => [item.sequence, item]));
  const omittedCount = Math.max(0, sourceRecords.length - kept.length);
  return {
    records,
    toolExecutionResults,
    rejectedToolRequests,
    sourceRecords,
    compression: {
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : null,
      estimatedTokens,
      originalCount: sourceRecords.length,
      keptCount: kept.length,
      omittedCount,
      shortenedCount,
      applied: omittedCount > 0 || shortenedCount > 0,
      source: "complete raw results remain in session storage"
    },
    receipt: {
      sources,
      decisions: sources.map((source, sequence) => {
        const retained = keptBySequence.get(sequence);
        return {
          section: "current_turn_tool_evidence",
          source,
          status: retained ? (retained.shortened ? "shortened" : "injected") : "retrieved_but_omitted",
          reason: retained
            ? (retained.shortened ? "immediate_tool_result_compacted" : "protected_immediate_tool_result")
            : "immediate_tool_result_token_budget"
        };
      })
    }
  };
}

function currentTurnEvidenceIdentity(kind, item = {}) {
  const source = executionEvidenceSource(kind, item, 0);
  return `${source.type}\u001f${source.id}`;
}

function deduplicatedEvidenceReceiptDecisions(kind, items, signatureFor) {
  const seen = new Set();
  const decisions = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const signature = signatureFor(item);
    if (signature && seen.has(signature)) {
      decisions.push({
        section: "non_compressible_core",
        source: executionEvidenceSource(kind, item, index),
        status: "deduplicated",
        reason: "newer_equivalent_execution_result_retained"
      });
      continue;
    }
    if (signature) seen.add(signature);
  }
  return decisions.reverse();
}

function executionEvidenceSource(kind, item = {}, index = 0) {
  const id = item.id || item.proposalId || `${item.source_agent_id || item.sourceAgentId || item.agentId || "unknown"}:${item.tool || item.op || kind}:${index}`;
  const sourceType = kind === "file" ? "file_operation_result"
    : kind === "tool" ? "tool_result"
      : kind === "rejected" ? "rejected_tool_request"
        : kind;
  return contextSource(sourceType, id, {
    agentId: item.source_agent_id || item.sourceAgentId || item.agentId,
    sourcePath: item.sourcePath,
    path: item.path || item.targetPath,
    round: item.round
  });
}

function executionEvidenceCandidate(kind, item, sequence) {
  const failed = kind === "rejected" || ["failed", "rejected", "skipped_policy", "unavailable"].includes(String(item?.status || ""));
  return {
    kind,
    item,
    sequence,
    source: String(item?.source_agent_id || item?.sourceAgentId || item?.agentId || item?.proposedBy?.seatId || item?.proposedBy?.id || "unknown"),
    verification: kind === "file" || ["execute_command", "run_tests", "git_operation"].includes(String(item?.tool || "")),
    priority: failed ? 4 : kind === "file" ? 3 : 2
  };
}

function markPriorityExecutionEvidence(candidates) {
  const latestBySource = new Map();
  const latestVerificationBySource = new Map();
  for (const candidate of candidates) {
    latestBySource.set(candidate.source, candidate);
    if (candidate.verification) latestVerificationBySource.set(candidate.source, candidate);
  }
  for (const candidate of latestVerificationBySource.values()) candidate.priority = Math.max(candidate.priority, 6);
  for (const candidate of latestBySource.values()) candidate.priority = Math.max(candidate.priority, 7);
}

function compareExecutionEvidenceCandidate(a, b) {
  return b.priority - a.priority || b.sequence - a.sequence;
}

function fitExecutionEvidenceCandidate(candidate, remainingTokens, options = {}) {
  if (remainingTokens <= 0) return null;
  const charLadder = options.forceKeep
    ? [DEFAULT_EVIDENCE_STRING_CHARS, 800, 320, 120, 48, 16]
    : [DEFAULT_EVIDENCE_STRING_CHARS, 800, 320, 120];
  for (const maxStringChars of charLadder) {
    const compacted = compactExecutionEvidenceRecord(candidate.kind, candidate.item, maxStringChars);
    const tokens = estimateTokens(JSON.stringify(compacted.record), options.tokenEstimateOptions);
    if (tokens <= remainingTokens) return { ...compacted, tokens };
  }
  if (options.forceKeep && remainingTokens >= 24) {
    return minimalExecutionEvidenceRecord(candidate.kind, candidate.item, remainingTokens, options.tokenEstimateOptions);
  }
  return null;
}

function minimalExecutionEvidenceRecord(kind, item = {}, remainingTokens, tokenEstimateOptions = {}) {
  const base = kind === "file"
    ? {
      proposalId: item.proposalId || item.id,
      op: item.op || item.operation || item.action,
      path: item.path || item.targetPath,
      status: item.status,
      error: compactContextString(item.error || item.reason || "", 80)
    }
    : {
      id: item.id,
      tool: item.tool,
      status: item.status || (kind === "rejected" ? "rejected" : undefined),
      path: item.path,
      command: item.command,
      url: item.url,
      query: item.query,
      error: compactContextString(item.error || item.reason || "", 80),
      result: slimToolResultForEvidence(item.result || {}, {}, { ultra: true })
    };
  let record = removeEmptyEvidenceValues(base);
  let tokens = estimateTokens(JSON.stringify(record), tokenEstimateOptions);
  if (tokens <= remainingTokens) {
    return { record, shortened: true, tokens };
  }
  // Strip result body entirely and keep only outcome facts.
  if (kind !== "file") {
    const result = item.result || {};
    record = removeEmptyEvidenceValues({
      id: item.id,
      tool: item.tool,
      status: item.status,
      path: item.path,
      command: compactContextString(item.command || "", 60),
      error: compactContextString(item.error || "", 60),
      result: removeEmptyEvidenceValues({
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdoutChars: typeof result.stdout === "string" ? result.stdout.length : undefined,
        stderrChars: typeof result.stderr === "string" ? result.stderr.length : undefined,
        contentChars: typeof result.content === "string" ? result.content.length : undefined,
        observedArtifacts: summarizeWorkspaceChangesForEvidence(result.workspaceChanges || {}).observedArtifacts
      })
    });
    tokens = estimateTokens(JSON.stringify(record), tokenEstimateOptions);
    if (tokens <= remainingTokens) return { record, shortened: true, tokens };
  }
  record = removeEmptyEvidenceValues({
    id: item.id || item.proposalId,
    tool: item.tool || item.op || kind,
    status: item.status,
    note: "evidence_omitted_for_token_budget_see_session_storage"
  });
  tokens = estimateTokens(JSON.stringify(record), tokenEstimateOptions);
  if (tokens <= remainingTokens) return { record, shortened: true, tokens };
  return null;
}

function compactExecutionEvidenceRecord(kind, item, maxStringChars) {
  const record = kind === "file"
    ? fileOperationEvidenceRecord(item)
    : toolEvidenceRecord(item, kind === "rejected");
  const compacted = compactEvidenceValue(record, maxStringChars);
  return { record: compacted.value, shortened: compacted.shortened };
}

function fileOperationEvidenceRecord(item = {}) {
  return removeEmptyEvidenceValues({
    proposalId: item.proposalId || item.id,
    op: item.op || item.operation || item.action,
    path: item.path || item.targetPath,
    status: item.status,
    code: item.code,
    error: item.error,
    reason: item.reason,
    round: item.round,
    source_agent_id: item.source_agent_id || item.sourceAgentId || item.proposedBy?.seatId || item.proposedBy?.id,
    source_agent_name: item.source_agent_name || item.sourceAgentName || item.proposedBy?.name,
    commitHash: item.commitHash,
    verification: item.verification,
    content: item.content,
    entries: item.entries,
    createdAt: item.createdAt
  });
}

function toolEvidenceRecord(item = {}, rejected = false) {
  const request = removeEmptyEvidenceValues({
    id: item.id,
    tool: item.tool,
    status: item.status || (rejected ? "rejected" : undefined),
    code: item.code,
    error: item.error,
    reason: item.reason,
    round: item.round,
    source_agent_id: item.source_agent_id || item.sourceAgentId || item.agentId,
    source_agent_name: item.source_agent_name || item.sourceAgentName,
    query: item.query,
    url: item.url,
    path: item.path,
    destination: item.destination,
    command: item.command,
    language: item.language,
    packageName: item.packageName,
    manager: item.manager,
    runner: item.runner,
    cwd: item.cwd,
    shell: item.shell,
    pattern: item.pattern,
    root: item.root,
    sessionId: item.sessionId,
    method: item.method,
    action: item.action,
    branch: item.branch,
    remote: item.remote,
    paths: item.paths,
    selector: item.selector,
    databasePath: item.databasePath,
    sql: item.sql,
    serverId: item.serverId,
    catalogId: item.catalogId,
    packageSpec: item.packageSpec,
    binName: item.binName,
    mcpToolName: item.mcpToolName,
    resourceUri: item.resourceUri,
    promptName: item.promptName,
    mode: item.mode,
    background: item.background,
    timeoutMs: item.timeoutMs,
    createdAt: item.createdAt
  });
  const rawResult = item.tool === "skill_read" ? skillReadEvidenceResult(item.result || {}) : item.result || {};
  const result = slimToolResultForEvidence(rawResult, request);
  return removeEmptyEvidenceValues({ ...request, result });
}

function slimToolResultForEvidence(result = {}, request = {}, options = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const ultra = Boolean(options.ultra);
  // Preserve unknown tool-specific fields; only shrink known bulky structures.
  const slim = { ...result };
  if (typeof slim.stdout === "string" && ultra) slim.stdout = compactContextString(slim.stdout, 48);
  if (typeof slim.stderr === "string" && ultra) slim.stderr = compactContextString(slim.stderr, 48);
  if (Array.isArray(slim.entries)) slim.entries = slim.entries.slice(0, ultra ? 5 : 20);
  if (slim.environment && typeof slim.environment === "object") {
    slim.environment = removeEmptyEvidenceValues({
      pathAdditions: Array.isArray(slim.environment.pathAdditions) ? slim.environment.pathAdditions.slice(0, 8) : undefined,
      corrections: Array.isArray(slim.environment.corrections) ? slim.environment.corrections.slice(0, 8) : undefined
    });
  }
  if (slim.workspaceChanges) {
    slim.workspaceChanges = summarizeWorkspaceChangesForEvidence(slim.workspaceChanges);
  }
  // Drop nested snapshot blobs that are never useful in prompts.
  if (slim.before && typeof slim.before === "object" && "scannedEntries" in slim.before) delete slim.before;
  if (slim.after && typeof slim.after === "object" && "scannedEntries" in slim.after) delete slim.after;
  return removeDuplicateEvidenceValues(removeEmptyEvidenceValues(slim), request);
}

function summarizeWorkspaceChangesForEvidence(changes = {}) {
  if (!changes || typeof changes !== "object") return undefined;
  const pickPaths = (value, limit = 20) => {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, limit).map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.path || item.relativePath || item.absolutePath || item.name || item;
      }
      return item;
    });
  };
  return removeEmptyEvidenceValues({
    source: changes.source,
    status: changes.status,
    complete: changes.complete,
    truncated: changes.truncated,
    error: changes.error,
    created: pickPaths(changes.created),
    modified: pickPaths(changes.modified),
    deleted: pickPaths(changes.deleted),
    observedArtifacts: pickPaths(changes.observedArtifacts),
    observedArtifactsComplete: changes.observedArtifactsComplete
  });
}

function skillReadEvidenceResult(result = {}) {
  const skill = result.skill || {};
  return {
    ok: result.ok,
    source: result.source,
    skill: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      sha256: skill.sha256,
      instructionOffset: skill.instructionOffset,
      nextOffset: skill.nextOffset,
      instructionsBytes: skill.instructionsBytes,
      totalInstructionsBytes: skill.totalInstructionsBytes,
      truncated: skill.truncated,
      instructionChunks: chunkContextText(skill.instructions, 1200)
    }
  };
}

function chunkContextText(value, maxChars) {
  const text = String(value || "");
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += maxChars) chunks.push(text.slice(offset, offset + maxChars));
  return chunks;
}

function removeDuplicateEvidenceValues(value, request) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    if (!(key in request)) return true;
    return JSON.stringify(request[key]) !== JSON.stringify(item);
  }));
}

function removeEmptyEvidenceValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null || item === "") return false;
    if (Array.isArray(item) && item.length === 0) return false;
    if (typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 0) return false;
    return true;
  }));
}

function compactEvidenceValue(value, maxStringChars, depth = 0) {
  if (typeof value === "string") {
    return {
      value: compactContextString(value, maxStringChars),
      shortened: value.length > maxStringChars
    };
  }
  if (!value || typeof value !== "object") return { value, shortened: false };
  if (depth > 5) return { value: "[truncated nested object]", shortened: true };
  if (Array.isArray(value)) {
    const limit = 20;
    let shortened = value.length > limit;
    const kept = value.slice(0, limit).map((item) => {
      const compacted = compactEvidenceValue(item, maxStringChars, depth + 1);
      shortened = shortened || compacted.shortened;
      return compacted.value;
    });
    if (value.length > limit) kept.push(`[truncated ${value.length - limit} items]`);
    return { value: kept, shortened };
  }
  let shortened = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const compacted = compactEvidenceValue(item, maxStringChars, depth + 1);
    shortened = shortened || compacted.shortened;
    return [key, compacted.value];
  });
  return { value: Object.fromEntries(entries), shortened };
}

function dedupeSimilarFileOperationResults(results) {
  const seen = new Set();
  const kept = [];
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const item = results[index];
    const signature = fileOperationResultSignature(item);
    if (signature && seen.has(signature)) continue;
    if (signature) seen.add(signature);
    kept.push(item);
  }
  return kept.reverse();
}

function fileOperationResultSignature(item = {}) {
  const op = String(item.op || item.operation || item.action || "");
  const path = String(item.path || item.targetPath || "").trim();
  if (!op || !path) return "";
  const source = String(item.source_agent_id || item.sourceAgentId || item.agentId || item.proposedBy?.seatId || item.proposedBy?.id || "");
  return [source, op, path].join("\u001f");
}

function dedupeSimilarToolResults(results) {
  const seen = new Set();
  const kept = [];
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const item = results[index];
    const signature = toolResultSignature(item);
    if (signature && seen.has(signature)) continue;
    if (signature) seen.add(signature);
    kept.push(item);
  }
  return kept.reverse();
}

function toolResultSignature(item = {}) {
  const tool = String(item.tool || "");
  if (!tool) return "";
  const source = String(item.source_agent_id || item.sourceAgentId || item.agentId || "");
  const keyParts = [
    item.path,
    item.query,
    item.url,
    item.command,
    item.cwd,
    item.shell,
    item.databasePath,
    item.sql,
    item.sessionId,
    item.serverId,
    item.mcpToolName,
    item.packageName,
    item.manager,
    item.runner
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (!keyParts.length) return "";
  return [source, tool, ...keyParts].join("\u001f");
}

function compactContextString(value, maxChars = MAX_TOOL_CONTEXT_STRING_CHARS) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  const markerReserve = Math.min(80, Math.max(30, Math.floor(maxChars / 4)));
  const usable = Math.max(20, maxChars - markerReserve);
  const headLength = Math.max(10, Math.floor(usable * 0.35));
  const tailLength = Math.max(10, usable - headLength);
  return `${text.slice(0, headLength)}\n...[tool output truncated ${text.length - headLength - tailLength} chars]...\n${text.slice(text.length - tailLength)}`;
}

function formatExecutionEvidenceCompression(compression = {}) {
  if (!compression.originalCount) return "";
  return `Execution evidence pack: kept=${compression.keptCount}/${compression.dedupedCount} from ${compression.originalCount} stored records; estimatedTokens=${compression.estimatedTokens}/${compression.maxTokens}; duplicates=${compression.duplicateCount}; omitted=${compression.omittedCount}; shortened=${compression.shortenedCount}. Complete raw results remain in session storage; this prompt contains a bounded evidence view, not the full raw outputs.`;
}

function selectRecentTranscript(messages, limit = DEFAULT_RECENT_MESSAGES) {
  const count = limit === undefined || limit === null ? DEFAULT_RECENT_MESSAGES : Number(limit);
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : DEFAULT_RECENT_MESSAGES;
  if (safeCount === 0) return [];
  return messages.slice(-safeCount);
}

// This is an ephemeral, replace-on-build view over the active session, not a
// second history store. It keeps durable handoffs plus a small cross-member
// window visible when a long run has pushed them out of the raw recent window.
function buildActiveWorkingMemory({ messages, recentTranscript, sessionId, limits, configuredMaxTokens }) {
  const recent = new Set(Array.isArray(recentTranscript) ? recentTranscript : []);
  const candidates = (Array.isArray(messages) ? messages : []).map((message, index) => ({
    message,
    index,
    source: transcriptSource(message, sessionId, index),
    structural: hasStructuredWorkingMemorySignal(message),
    substantive: hasSubstantiveWorkingMemoryContent(message)
  })).filter((item) => !recent.has(item.message));
  const tokenBudget = resolveActiveWorkingMemoryTokenBudget(limits, configuredMaxTokens);
  if (!candidates.length || tokenBudget <= 0) {
    return {
      entries: [],
      sources: [],
      decisions: candidates.map((item) => workingMemoryOmissionDecision(item, tokenBudget <= 0 ? "active_working_memory_disabled_or_no_budget" : "active_working_memory_no_candidates")),
      tokenBudget,
      estimatedTokens: 0,
      candidateCount: candidates.length,
      source: "derived_from_active_session"
    };
  }

  const nominations = new Map();
  const nominate = (item, reason) => {
    if (!item?.substantive && !item?.structural) return;
    const existing = nominations.get(item.source.id);
    if (existing) {
      existing.reasons.add(reason);
      return;
    }
    nominations.set(item.source.id, { ...item, reasons: new Set([reason]) });
  };

  let structuralCount = 0;
  for (const item of [...candidates].reverse()) {
    if (!item.structural) continue;
    nominate(item, "structured_handoff_or_contract");
    structuralCount += 1;
    if (structuralCount >= MAX_ACTIVE_WORKING_MEMORY_ROUND_ANCHORS) break;
  }

  const memberAnchors = new Map();
  for (const item of [...candidates].reverse()) {
    if (!item.substantive) continue;
    const memberId = String(item.message?.agentId || item.message?.agentName || "unknown");
    const count = memberAnchors.get(memberId) || 0;
    if (count >= MAX_ACTIVE_WORKING_MEMORY_MEMBER_ANCHORS) continue;
    nominate(item, "latest_member_work");
    memberAnchors.set(memberId, count + 1);
  }

  const roundAnchors = new Set();
  for (const item of [...candidates].reverse()) {
    if (!item.substantive) continue;
    const round = String(item.message?.round ?? "unknown");
    if (roundAnchors.has(round)) continue;
    nominate(item, "latest_round_work");
    roundAnchors.add(round);
    if (roundAnchors.size >= MAX_ACTIVE_WORKING_MEMORY_ROUND_ANCHORS) break;
  }
  if (!nominations.size) nominate(candidates.at(-1), "latest_available_record");

  const priority = [...nominations.values()].sort((left, right) => {
    const leftWeight = (left.structural ? 4 : 0) + (left.reasons.has("latest_member_work") ? 2 : 0) + (left.reasons.has("latest_round_work") ? 1 : 0);
    const rightWeight = (right.structural ? 4 : 0) + (right.reasons.has("latest_member_work") ? 2 : 0) + (right.reasons.has("latest_round_work") ? 1 : 0);
    return rightWeight - leftWeight || right.index - left.index;
  });
  const included = new Map();
  let estimatedTokens = 0;
  for (const item of priority) {
    const entry = activeWorkingMemoryEntry(item);
    const entryTokens = estimateTokens(formatActiveWorkingMemoryEntry(entry), limits);
    if (estimatedTokens + entryTokens > tokenBudget) continue;
    included.set(item.source.id, entry);
    estimatedTokens += entryTokens;
  }
  const entries = [...included.values()].sort((left, right) => left.index - right.index);
  return {
    entries,
    sources: entries.map((entry) => entry.source),
    decisions: candidates.map((item) => {
      const entry = included.get(item.source.id);
      return entry
        ? {
            section: "active_working_memory",
            source: item.source,
            status: "injected",
            reason: `active_working_memory_${entry.reasons.join("_")}`
          }
        : workingMemoryOmissionDecision(item, nominations.has(item.source.id)
          ? "active_working_memory_token_budget"
          : "active_working_memory_not_selected");
    }),
    tokenBudget,
    estimatedTokens,
    candidateCount: candidates.length,
    source: "derived_from_active_session"
  };
}

function resolveActiveWorkingMemoryTokenBudget(limits = {}, configuredMaxTokens) {
  const configured = Number(configuredMaxTokens);
  if (Number.isFinite(configured)) return Math.max(0, Math.min(MAX_ACTIVE_WORKING_MEMORY_TOKENS, Math.floor(configured)));
  const target = compressionTargetTokens(limits);
  if (!target) return DEFAULT_ACTIVE_WORKING_MEMORY_TOKENS;
  return Math.max(240, Math.min(DEFAULT_ACTIVE_WORKING_MEMORY_TOKENS, Math.floor(target * 0.12)));
}

function hasStructuredWorkingMemorySignal(message = {}) {
  const response = message?.response || {};
  return Boolean(
    response.task_contract
    || response.delegation_handoff
    || response.task_delegations?.length
    || response.objection_items?.length
    || response.artifacts?.length
  );
}

function hasSubstantiveWorkingMemoryContent(message = {}) {
  if (hasStructuredWorkingMemorySignal(message)) return true;
  if (message?.interim) return false;
  const response = message?.response || {};
  return Boolean(String(response.argument || response.reason || response.position || "").trim());
}

function activeWorkingMemoryEntry(item = {}) {
  return {
    index: item.index,
    source: item.source,
    agentName: String(item.message?.agentName || item.message?.agentId || "Member"),
    round: Number(item.message?.round || 0),
    phase: String(item.message?.phase || ""),
    status: String(item.message?.response?.status || ""),
    reasons: [...item.reasons],
    excerpt: compactContextString(activeWorkingMemoryExcerpt(item.message), 560)
  };
}

function activeWorkingMemoryExcerpt(message = {}) {
  const response = message?.response || {};
  const parts = [formatTranscriptMessage(message)];
  if (response.task_contract && typeof response.task_contract === "object") {
    const contract = response.task_contract;
    parts.push(`Task contract: mode=${contract.mode || ""}; objective=${contract.objective || ""}; next_action=${contract.next_action || contract.nextAction || ""}`);
  }
  if (Array.isArray(response.task_delegations) && response.task_delegations.length) {
    parts.push(`Delegations: ${response.task_delegations.map((item) => `${item.id || item.delegation_id || "?"}:${item.assignee || item.agentId || "?"}:${item.kind || ""}:${item.task || item.objective || ""}`).join(" | ")}`);
  }
  if (response.delegation_handoff && typeof response.delegation_handoff === "object") {
    parts.push(`Delegation handoff: ${response.delegation_handoff.delegation_id || "?"}; ${response.delegation_handoff.summary || ""}`);
  }
  if (Array.isArray(response.objection_items) && response.objection_items.length) {
    parts.push(`Objections: ${response.objection_items.map((item) => item.issue || item.id || item.reason || "").filter(Boolean).join(" | ")}`);
  }
  return parts.filter(Boolean).join("\n");
}

function formatActiveWorkingMemory(value = {}) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  if (!entries.length) return [];
  return [
    `Replaceable active-session working set derived from ${value.candidateCount || entries.length} older visible records. It is not a second memory store; raw records remain in the session and can be loaded by exact source reference.`,
    ...entries.map(formatActiveWorkingMemoryEntry)
  ];
}

function formatActiveWorkingMemoryEntry(entry = {}) {
  const source = entry.source || {};
  const metadata = [
    `source_ref=${JSON.stringify({ type: source.type, id: source.id, sessionId: source.sessionId, round: source.round })}`,
    `round=${entry.round || "?"}`,
    `member=${entry.agentName}`,
    entry.phase ? `phase=${entry.phase}` : "",
    entry.status ? `status=${entry.status}` : "",
    entry.reasons?.length ? `selected=${entry.reasons.join(",")}` : ""
  ].filter(Boolean).join(" ");
  return `${metadata}\n${entry.excerpt}`;
}

function workingMemoryOmissionDecision(item = {}, reason) {
  return {
    section: "active_working_memory",
    source: item.source,
    status: "retrieved_but_omitted",
    reason
  };
}

function fitRecentTranscriptToLimit({ stableMessages, currentTurnMessages = [], coreMessages, summaryMessages, recentTranscript, limits }) {
  const targetTokens = compressionTargetTokens(limits);
  if (!targetTokens) return recentTranscript;
  const stableTokens = estimateMessagesTokens([...stableMessages, ...currentTurnMessages], limits);
  const coreTokens = estimateMessagesTokens(coreMessages, limits);
  const summaryTokens = estimateMessagesTokens(summaryMessages, limits);
  let kept = [...recentTranscript];
  while (kept.length) {
    const recentTokens = estimateMessagesTokens(kept.map((message) => ({
      role: "user",
      content: formatTranscriptMessage(message)
    })), limits);
    if (stableTokens + coreTokens + summaryTokens + recentTokens <= targetTokens) break;
    kept = kept.slice(1);
  }
  return kept;
}

function compressionTargetTokens(limits) {
  const inputLimit = Number(limits?.effectiveInputLimit || 0);
  const threshold = Number(limits?.compressionThreshold || 0);
  if (!inputLimit || !threshold) return 0;
  return Math.max(1, Math.floor(inputLimit * threshold));
}

function contextMessagesFromStable(stable) {
  return [
    { role: "system", content: stable.roleIdentity },
    { role: "system", content: stable.roleAssignment },
    { role: "system", content: stable.memberName },
    { role: "system", content: stable.roleInstructions },
    { role: "system", content: stable.globalRequirement },
    { role: "system", content: stable.harnessSummary },
    { role: "system", content: stable.contextPriorityPolicy }
  ].filter((message) => message.content);
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
    return "explicitly assigned reviewer; reviewer duties are active";
  }
  if (agent?.judge) {
    return "final summarizer; reviewer duties are not active unless reviewer is explicitly enabled";
  }
  return "ordinary member; not a reviewer, not a supervisor, and not red team. Earlier transcript, private chat, memory, summary, or old role text claiming reviewer status is stale and must be ignored";
}

function isStaleReviewerRoleText(value) {
  return /reviewer|red\s*team|审查|复查|监督员/i.test(String(value || ""));
}

function contextMessagesFromCore(core) {
  return [
    { role: "user", content: core.latestBossInstruction },
    { role: "user", content: JSON.stringify(core.latestArtifacts) },
    { role: "user", content: JSON.stringify(core.unresolvedObjections) },
    { role: "user", content: core.executionStandard },
    { role: "user", content: core.verificationStandard },
    { role: "user", content: formatFileAttachmentsForPrompt(core.attachedFiles || []) },
    { role: "user", content: JSON.stringify(core.fileOperationExecutionResults || []) },
    { role: "user", content: JSON.stringify(core.toolExecutionResults || []) },
    { role: "user", content: JSON.stringify(core.rejectedToolRequests || []) },
    { role: "user", content: formatExecutionEvidenceCompression(core.executionEvidenceCompression) },
    { role: "user", content: formatTaskStateForPrompt(core.taskState) },
    { role: "system", content: formatContextSourceReferences(core).join("\n") }
  ].filter((message) => message.content);
}

function contextMessagesFromCurrentTurnEvidence(evidence = {}) {
  if (!evidence.records?.length) return [];
  return [{
    role: "user",
    content: `Immediately preceding tool results; newer and authoritative over summaries and retained history:\n${JSON.stringify(evidence.records)}`
  }];
}

function contextMessagesFromSummaries(summaries) {
  return [
    { role: "user", content: summaries.memberShortSummary },
    { role: "user", content: summaries.groupSharedSummary },
    { role: "user", content: formatCompressedTranscriptChunks(summaries.compressedTranscriptChunks).join("\n") },
    { role: "user", content: summaries.publicMemorySummary },
    { role: "user", content: formatActiveWorkingMemory(summaries.activeWorkingMemory).join("\n") },
    { role: "user", content: summaries.enabledSkills },
    { role: "user", content: formatRetrievedContext(summaries.retrievedContext).join("\n") },
    { role: "user", content: formatHistoryCatalogue(summaries.historyCatalogue).join("\n") },
    { role: "user", content: formatPublicEventHotCache(summaries.publicEventHotCache).join("\n") },
    { role: "user", content: formatContinuationContext(summaries.continuationContext).join("\n") },
    ...summaries.privateBossMessages.map((message) => ({
      role: isFromBoss(message) ? "user" : "assistant",
      content: formatPrivateBossMessage(message)
    }))
  ].filter((message) => message.content);
}

function formatCompressedTranscriptChunks(chunks = []) {
  return (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => chunk?.summary)
    .slice(-3)
    .map((chunk) => `Compressed rounds ${chunk.fromRound ?? "?"}-${chunk.toRound ?? "?"}: ${chunk.summary}`);
}

function normalizeHistoryCatalogue(items) {
  return (Array.isArray(items) ? items : []).slice(0, 20).map((item) => ({
    sessionId: String(item?.sessionId || "").trim(),
    question: String(item?.question || "").trim().slice(0, 220),
    roundCount: Number(item?.roundCount || 0),
    finalState: String(item?.finalState || "").trim(),
    completedAt: String(item?.completedAt || item?.createdAt || "").trim()
  })).filter((item) => item.sessionId && item.question);
}

function formatHistoryCatalogue(items) {
  const normalized = normalizeHistoryCatalogue(items);
  if (!normalized.length) return [];
  return [
    "Saved public group discussions are available on demand. Use search_context to find details by words, or load_context with a sessionId and optional round to read the full public record, including shared tool and file-operation results. Do not claim an older discussion was read unless its tool result is present.",
    ...normalized.map((item, index) => `${index + 1}. session=${item.sessionId} rounds=${item.roundCount || 0}${item.finalState ? ` state=${item.finalState}` : ""}${item.completedAt ? ` completed=${item.completedAt}` : ""}\nQuestion: ${item.question}`)
  ];
}

function normalizePublicEventHotCache(value, configuredLimit) {
  const events = Array.isArray(value?.events) ? value.events : [];
  const maxEvents = clampInteger(configuredLimit ?? 12, 1, 40);
  return {
    sourceJournalPath: String(value?.sourceJournalPath || ""),
    events: events.slice(-maxEvents).map((item) => ({
      eventId: String(item?.eventId || ""),
      sequence: Number(item?.sequence || 0),
      type: String(item?.type || ""),
      occurredAt: String(item?.occurredAt || ""),
      sessionId: String(item?.sessionId || ""),
      round: Number(item?.round || 0),
      actorName: String(item?.actorName || item?.actorId || ""),
      status: String(item?.status || ""),
      tool: String(item?.tool || ""),
      text: String(item?.text || "").trim().slice(0, 700),
      sourcePath: String(item?.sourcePath || "")
    })).filter((item) => item.eventId && item.text)
  };
}

function formatPublicEventHotCache(value) {
  const cache = normalizePublicEventHotCache(value);
  if (!cache.events.length) return [];
  return [
    `Recent retained public events from ${cache.sourceJournalPath || "the group event journal"}. These are compact previews with exact eventId pointers; use load_context with eventId for the full event.`,
    ...cache.events.map((item) => [
      `event=${item.eventId} seq=${item.sequence} type=${item.type}${item.actorName ? ` actor=${item.actorName}` : ""}${item.tool ? ` tool=${item.tool}` : ""}${item.status ? ` status=${item.status}` : ""}${item.occurredAt ? ` at=${item.occurredAt}` : ""}`,
      item.sourcePath ? `Source: ${item.sourcePath}` : "",
      `Preview: ${item.text}`
    ].filter(Boolean).join("\n"))
  ];
}

function buildRetrievedContextPack(items, options = {}) {
  if (items && typeof items === "object" && Array.isArray(items.items) && items.compression) return items;
  const maxItems = clampInteger(options.maxItems || DEFAULT_ARCHIVE_CONTEXT_ITEMS, 1, 12);
  const maxTokens = clampInteger(options.maxTokens || DEFAULT_ARCHIVE_CONTEXT_TOKENS, 120, 4000);
  const normalized = normalizeRetrievedContext(items)
    .sort(compareRetrievedContextHit);
  const dedupeResult = dedupeRetrievedContext(normalized);
  const deduped = dedupeResult.items;
  const kept = [];
  const omitted = [];
  let estimatedTokens = 0;
  let truncatedSnippets = 0;
  const tokenEstimateOptions = options.tokenEstimateOptions || {};

  for (const item of deduped) {
    if (kept.length >= maxItems) {
      omitted.push({ item, reason: "archive_item_limit" });
      continue;
    }
    let candidate = { ...item };
    let snippetWasTrimmed = false;
    let formatted = formatRetrievedContextItem(candidate, kept.length + 1);
    let tokens = estimateTokens(formatted, tokenEstimateOptions);
    if (estimatedTokens + tokens > maxTokens) {
      const remaining = maxTokens - estimatedTokens - estimateTokens(formatRetrievedContextItem({ ...candidate, snippet: "" }, kept.length + 1), tokenEstimateOptions);
      if (remaining <= 40) {
        omitted.push({ item, reason: "archive_token_budget" });
        continue;
      }
      const trimmed = trimTextToEstimatedTokens(candidate.snippet, remaining, tokenEstimateOptions);
      if (!trimmed || trimmed === candidate.snippet) {
        omitted.push({ item, reason: "archive_token_budget" });
        continue;
      }
      candidate = { ...candidate, snippet: trimmed, snippetTruncated: true };
      snippetWasTrimmed = true;
      formatted = formatRetrievedContextItem(candidate, kept.length + 1);
      tokens = estimateTokens(formatted, tokenEstimateOptions);
      if (estimatedTokens + tokens > maxTokens && kept.length) {
        omitted.push({ item, reason: "archive_token_budget" });
        continue;
      }
    }
    kept.push(candidate);
    if (snippetWasTrimmed) truncatedSnippets += 1;
    estimatedTokens += tokens;
  }

  const droppedCount = Math.max(0, deduped.length - kept.length);
  const retainedByKey = new Map(kept.map((item) => [retrievedContextKey(item), item]));
  const receiptDecisions = [
    ...dedupeResult.duplicates.map((item) => ({
      section: "relevant_archived_context",
      source: retrievedContextSource(item),
      status: "deduplicated",
      reason: "equivalent_archive_hit_retained"
    })),
    ...deduped.map((item) => {
      const retained = retainedByKey.get(retrievedContextKey(item));
      return {
        section: "relevant_archived_context",
        source: retrievedContextSource(item),
        status: retained ? (retained.snippetTruncated ? "shortened" : "injected") : "retrieved_but_omitted",
        reason: retained
          ? (retained.snippetTruncated ? "archive_snippet_token_budget" : "archive_ranked_selection")
          : (omitted.find((entry) => retrievedContextKey(entry.item) === retrievedContextKey(item))?.reason || "archive_token_budget")
      };
    })
  ];
  return {
    source: "local_context_archive",
    items: kept,
    compression: {
      maxItems,
      maxTokens,
      originalCount: normalized.length,
      dedupedCount: deduped.length,
      keptCount: kept.length,
      droppedCount,
      truncatedSnippets,
      estimatedTokens,
      applied: droppedCount > 0 || truncatedSnippets > 0
    },
    receipt: { decisions: receiptDecisions }
  };
}

function normalizeRetrievedContext(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).map((item) => ({
    source: String(item?.source || "local_context_archive"),
    sourceType: String(item?.sourceType || ""),
    eventId: String(item?.eventId || ""),
    sessionId: String(item?.sessionId || ""),
    round: Number(item?.round || 0) || undefined,
    question: String(item?.question || ""),
    finalState: String(item?.finalState || ""),
    snippet: String(item?.snippet || "").trim(),
    sourcePath: String(item?.sourcePath || ""),
    score: Number(item?.score || 0),
    createdAt: String(item?.createdAt || ""),
    completedAt: String(item?.completedAt || "")
  })).filter((item) => item.snippet);
}

function formatRetrievedContext(items) {
  const pack = buildRetrievedContextPack(items);
  const normalized = Array.isArray(pack.items) ? pack.items : [];
  if (!normalized.length) return [];
  const compression = pack.compression || {};
  return [
    "Compact snippets loaded by local keyword search from saved public session archives. These are source pointers, not full source facts. If more detail is needed, request load_context with sessionId and optional round.",
    `Archive context budget: kept=${compression.keptCount ?? normalized.length}/${compression.dedupedCount ?? normalized.length} estimatedTokens=${compression.estimatedTokens ?? "unknown"}/${compression.maxTokens ?? "unknown"}${compression.droppedCount ? ` dropped=${compression.droppedCount}` : ""}${compression.truncatedSnippets ? ` truncated=${compression.truncatedSnippets}` : ""}.`,
    ...normalized.map((item, index) => formatRetrievedContextItem(item, index + 1))
  ];
}

function formatRetrievedContextItem(item, index) {
  return [
    `Archive hit ${index}: session=${item.sessionId || "unknown"}${item.round ? ` round=${item.round}` : ""} type=${item.sourceType || "unknown"} score=${item.score}`,
    item.question ? `Question: ${item.question}` : "",
    item.finalState ? `Final state: ${item.finalState}` : "",
    item.sourcePath ? `Source path: ${item.sourcePath}` : "",
    `Snippet: ${item.snippet}${item.snippetTruncated ? " [truncated]" : ""}`
  ].filter(Boolean).join("\n");
}

function compareRetrievedContextHit(a, b) {
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return dateValue(b.completedAt || b.createdAt) - dateValue(a.completedAt || a.createdAt);
}

function dedupeRetrievedContext(items) {
  const seen = new Set();
  const kept = [];
  const duplicates = [];
  for (const item of items) {
    const key = retrievedContextKey(item);
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return { items: kept, duplicates };
}

function retrievedContextKey(item = {}) {
  return [
    item.sessionId || "unknown",
    item.round || 0,
    item.sourceType || "unknown",
    item.sourcePath || item.eventId || String(item.snippet || "").slice(0, 80)
  ].join("|");
}

function trimTextToEstimatedTokens(text, maxTokens, tokenEstimateOptions = {}) {
  const value = String(text || "").trim();
  if (!value || estimateTokens(value, tokenEstimateOptions) <= maxTokens) return value;
  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = value.slice(0, mid).trimEnd();
    if (estimateTokens(`${candidate}...`, tokenEstimateOptions) <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best ? `${best}...` : "";
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function dateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeContinuationContext(value) {
  if (!value || typeof value !== "object") return null;
  return {
    previousSessionId: String(value.previousSessionId || value.sessionId || "").trim(),
    previousQuestion: String(value.previousQuestion || value.question || "").trim(),
    previousStatus: String(value.previousStatus || value.status || "").trim(),
    finalState: String(value.finalState || value.final_state || "").trim(),
    finalAnswer: String(value.finalAnswer || value.answer || "").trim(),
    summary: String(value.summary || "").trim(),
    sourcePath: String(value.sourcePath || value.source_path || "").trim(),
    blockingIssues: normalizeTextList(value.blockingIssues || value.blocking_issues),
    risks: normalizeTextList(value.risks || value.unresolved_risks),
    nextActions: normalizeTextList(value.nextActions || value.next_actions),
    participantMessages: normalizeContinuationMessages(value.participantMessages || value.participant_messages, 12),
    recentMessages: normalizeContinuationMessages(value.recentMessages || value.recent_messages, 12),
    recentActivity: normalizeTextList(value.recentActivity || value.recent_activity).slice(0, 12),
    sourceRefs: normalizeSummarySourceRefs(value.sourceRefs || value.sources),
    provenance: String(value.provenance || (normalizeSummarySourceRefs(value.sourceRefs || value.sources).length ? "attributed" : "unattributed")).trim()
  };
}

function formatContinuationContext(context) {
  if (!context) return [];
  return [
    context.previousSessionId ? `Previous session: ${context.previousSessionId}` : "",
    context.sourcePath ? `Saved public source: ${context.sourcePath}` : "",
    context.previousQuestion ? `Previous question: ${context.previousQuestion}` : "",
    context.previousStatus ? `Previous session status: ${context.previousStatus}` : "",
    context.finalState ? `Previous final state: ${context.finalState}` : "",
    context.finalAnswer ? `Previous final answer: ${context.finalAnswer}` : "",
    context.summary ? `Previous compressed summary: ${context.summary}` : "",
    ...context.blockingIssues.map((item) => `Previous blocking issue: ${item}`),
    ...context.risks.map((item) => `Previous risk: ${item}`),
    ...context.nextActions.map((item) => `Previous next action: ${item}`),
    ...context.participantMessages.map((message) => `Previous participant latest: ${formatContinuationMessage(message)}`),
    ...context.recentMessages.map((message) => `Previous recent message: ${formatContinuationMessage(message)}`),
    ...context.recentActivity.map((item) => `Previous real activity: ${item}`),
    context.previousSessionId ? `Use load_context with sessionId=${context.previousSessionId} and an optional round whenever exact older public messages or execution records are needed.` : ""
  ].filter(Boolean);
}

function normalizeContinuationMessages(value, limit) {
  return (Array.isArray(value) ? value : []).slice(-limit).map((message) => ({
    round: Number(message?.round || 0),
    agentId: String(message?.agentId || message?.agent_id || "").trim(),
    agentName: String(message?.agentName || message?.agent_name || message?.agentId || "").trim(),
    status: String(message?.status || "unknown").trim(),
    text: String(message?.text || message?.argument || message?.reason || "").trim().slice(0, 420),
    createdAt: String(message?.createdAt || message?.created_at || "").trim()
  })).filter((message) => message.agentName || message.text);
}

function formatContinuationMessage(message) {
  return [
    message.round ? `R${message.round}` : "",
    message.agentName || message.agentId || "unknown member",
    `[${message.status || "unknown"}]`,
    message.text || "(no public text)"
  ].filter(Boolean).join(" ");
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

function isFromBoss(message) {
  return !message.from || message.from === "boss";
}

function formatPrivateBossMessage(message) {
  const when = message.createdAt || "unknown time";
  if (isFromBoss(message)) {
    return `Private from boss to you at ${when}: ${message.text || ""}`;
  }
  return `Your earlier private reply to boss at ${when}: ${message.text || ""}`;
}

function formatTranscriptMessage(message) {
  const response = message.response || {};
  if (response.status === "skip") return `Round ${message.round} / ${message.agentName}: skip`;
  if (response.status === "error" || response.status === "unavailable") {
    return `Round ${message.round} / ${message.agentName}: ${response.status}: ${response.reason || ""}`;
  }
  return `Round ${message.round} / ${message.agentName}: ${response.argument || response.position || ""}`;
}
