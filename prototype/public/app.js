const MAX_AGENT_SEATS = 7;

const state = {
  group: null,
  groupPath: "",
  groupIndex: { groups: [], lastGroupId: "" },
  appSettings: { groupsRoot: "./workspace-ui", firstRunComplete: false },
  selectedGroupId: "",
  groupSearch: "",
  lang: "zh",
  globalRequirement: "",
  permissions: loadJson("ai-council-permissions", { defaultTier: "text", seatTiers: {} }),
  roundState: "idle",
  currentRoundController: null,
  currentRoundQuestion: "",
  currentAgentId: "",
  currentAgentName: "",
  pausedAgentId: "",
  pausedAgentName: "",
  roundSequence: 0,
  cycleContinuation: null,
  conversationMode: loadScopedValue("conversation-mode", "table", null),
  draftFilter: "",
  lastFinalAnswer: "",
  lastSession: null,
  streamMessages: [],
  partialMessages: {},
  agentStatuses: {},
  seatHealthStatuses: {},
  seatHealthChecking: false,
  contextStatuses: {},
  usageSnapshot: null,
  fileOperations: { pending: [], audit: [] },
  seatOverrides: {},
  customSeats: {},
  owner: loadScopedJson("owner", {}, null),
  mutedSeats: {},
  privateChats: {},
  providerPresets: [],
  decisionHistory: loadScopedJson("decision-history", [], null),
  autonomousRounds: Number(loadScopedValue("autonomous-rounds", 10, null)),
  windowLayout: loadScopedJson("window-layout", defaultWindowLayout(), null),
  uiLayout: normalizeUiLayout(loadJson("ai-council-ui-layout", defaultUiLayout())),
  uiLayoutSaveTimer: null,
  selectedSeatId: "",
  draftRequestId: 0,
  busyCount: 0
};

const i18n = {
  zh: {
    ready: "\u5c31\u7eea\u3002",
    rootFolder: "\u6839\u76ee\u5f55",
    groupFolder: "\u5c0f\u7ec4\u6587\u4ef6\u5939",
    members: "\u6210\u5458",
    groupPath: "\u5c0f\u7ec4\u8def\u5f84",
    groupNameLabel: "\u5c0f\u7ec4\u540d\u79f0",
    groupNamePlaceholder: "\u4f8b\u5982\uff1a\u6211\u7684 AI \u5c0f\u7ec4",
    groupsRoot: "\u6240\u6709\u5c0f\u7ec4\u6587\u4ef6\u5939",
    actualGroupPath: "\u5b9e\u9645\u8def\u5f84",
    groupsRootNote: "\u65b0\u5efa\u5c0f\u7ec4\u9ed8\u8ba4\u653e\u5728\u4e0a\u9762\u7684\u603b\u6587\u4ef6\u5939\u4e0b\u3002\u300c\u9009\u62e9\u300d\u7528\u4e8e\u66f4\u6362\u603b\u6587\u4ef6\u5939\u6216\u8f7d\u5165\u5df2\u6709\u5c0f\u7ec4\u3002",
    chooseFolder: "\u9009\u62e9",
    createGroup: "\u521b\u5efa",
    load: "\u52a0\u8f7d",
    noGroup: "\u672a\u52a0\u8f7d\u5c0f\u7ec4",
    modeTable: "\u684c\u9762",
    modeSide: "\u53f3\u4fa7",
    zoom: "\u7f29\u653e",
    autonomousRounds: "\u81ea\u4e3b\u8f6e\u6b21",
    checkAllSeats: "\u68c0\u67e5\u6240\u6709\u5e2d\u4f4d",
    checkingSeats: "\u6b63\u5728\u68c0\u67e5\u5e2d\u4f4d...",
    seatHealthOk: "\u5e2d\u4f4d\u5065\u5eb7\uff08{source}\uff09",
    seatHealthFailed: "\u5e2d\u4f4d\u6545\u969c\uff1a{error}\uff08{source}\uff09",
    seatHealthSummary: "\u5e2d\u4f4d\u68c0\u67e5\u5b8c\u6210\uff1a{ok} \u4e2a\u53ef\u7528\uff0c{failed} \u4e2a\u9700\u6ce8\u610f\u3002",
    unhealthySeatsWarning: "\u68c0\u6d4b\u5230\u4ee5\u4e0b\u5e2d\u4f4d\u53ef\u80fd\u65e0\u6cd5\u4f7f\u7528\uff1a{names}\u3002\u7ee7\u7eed\u540e\u672c\u8f6e\u5c06\u8df3\u8fc7\u8fd9\u4e9b\u5e2d\u4f4d\u3002\u786e\u8ba4\u7ee7\u7eed\uff1f",
    unhealthySeatsSkipped: "\u672c\u8f6e\u5df2\u8df3\u8fc7\u6545\u969c\u5e2d\u4f4d\uff1a{names}\u3002",
    noAvailableSeatsAfterHealthCheck: "\u6ca1\u6709\u53ef\u7528\u5e2d\u4f4d\uff1a\u6545\u969c\u5e2d\u4f4d\u672c\u8f6e\u5df2\u8df3\u8fc7\uff0c\u672a\u542f\u52a8\u8ba8\u8bba\u3002",
    pauseDiscussion: "\u6682\u505c\u8ba8\u8bba",
    resumeDiscussion: "\u7ee7\u7eed\u8ba8\u8bba",
    continuePreviousCycle: "\u7eed\u63a5\u4e0a\u4e00\u8f6e",
    continuationNotice: "\u5df2\u7eed\u63a5\u4e0a\u4e00\u8f6e\uff1a{state}\u3002",
    continuationPlaceholder: "\u7ee7\u7eed\u4e0a\u4e00\u8f6e\u8ba8\u8bba...",
    bossInterjection: "\u8001\u677f\u63d2\u8bdd",
    bossInput: "\u8001\u677f\u5148\u53d1\u8bdd",
    sendInterjection: "\u53d1\u9001",
    stopAll: "\u5168\u4f53\u505c\u6b62",
    stopOne: "\u5355\u4e2a\u505c\u6b62",
    globalRequirement: "\u5168\u5c40\u8981\u6c42",
    globalRequirementPlaceholder: "\u7ed9\u6240\u6709 AI \u7684\u7ea6\u675f",
    confirm: "\u786e\u8ba4",
    permissionTier: "\u6743\u9650",
    applyAllPermissions: "\u5168\u4f53\u5e94\u7528",
    modifyPermission: "\u4fee\u6539\u6743\u9650",
    permissionText: "\u6587\u672c",
    permissionTool: "\u5de5\u5177",
    permissionFull: "\u5b8c\u5168",
    tableCenterHint: "\u5706\u684c\u8ba8\u8bba",
    noMessages: "\u6682\u65e0\u6d88\u606f\u3002",
    noGroupLoaded: "\u5c1a\u672a\u52a0\u8f7d\u5c0f\u7ec4\u3002",
    ownerLabel: "\u8001\u677f",
    conversation: "\u5bf9\u8bdd\u8bb0\u5f55",
    decisions: "\u603b\u7ed3",
    fileOperations: "\u6587\u4ef6\u63d0\u8bae",
    refresh: "\u5237\u65b0",
    noFileOperations: "\u6682\u65e0\u6587\u4ef6\u64cd\u4f5c\u63d0\u8bae\u3002",
    approveFileOperation: "\u6279\u51c6\u63d0\u8bae",
    autoApproveFileOperation: "\u81ea\u52a8\u6279\u51c6",
    executeFileOperation: "\u6267\u884c\u5e76\u63d0\u4ea4",
    fileOperationApproved: "\u6587\u4ef6\u63d0\u8bae\u5df2\u6279\u51c6\u3002",
    fileOperationExecuted: "\u5df2\u6267\u884c\u5e76\u63d0\u4ea4\u3002",
    fileOperationDangerConfirm: "\u8fd9\u4e2a\u64cd\u4f5c\u53ef\u80fd\u8986\u76d6\u6216\u5220\u9664\u6587\u4ef6\uff0c\u786e\u8ba4\u7ee7\u7eed\uff1f",
    fileOperationAutoConfirm: "\u4ec5\u5b8c\u5168\u6743\u9650\u6a21\u5f0f\u4e0b\u7684\u975e\u5371\u9669\u5199\u5165\u624d\u4f1a\u81ea\u52a8\u6279\u51c6\u3002\u786e\u8ba4\uff1f",
    fileOperationAudit: "\u6700\u8fd1\u8bb0\u5f55",
    commitHash: "\u63d0\u4ea4",
    fileOperationPreview: "\u9884\u89c8",
    confirmDecision: "\u4fdd\u5b58\u672c\u6b21\u7ed3\u8bba",
    confirmDecisionTitle: "\u628a\u5f53\u524d\u6700\u7ec8\u7ed3\u8bba\u4fdd\u5b58\u5230\u51b3\u8bae\u5386\u53f2\uff0c\u4e0d\u81ea\u52a8\u6267\u884c\u3002",
    noDecisions: "\u6682\u65e0\u51b3\u8bae\u3002",
    prepareStandards: "\u751f\u6210\u6267\u884c\u6807\u51c6",
    prepareStandardsTitle: "\u751f\u6210\u6267\u884c\u6807\u51c6\u548c\u68c0\u6d4b\u6807\u51c6\uff0c\u4e0d\u6267\u884c\u6587\u4ef6\u64cd\u4f5c\u3002",
    approveStandards: "\u786e\u8ba4\u6807\u51c6",
    approveStandardsTitle: "\u786e\u8ba4\u8fd9\u4e9b\u6807\u51c6\u53ef\u7528\u4e8e\u540e\u7eed\u9a8c\u6536\uff0c\u4e0d\u6267\u884c\u6587\u4ef6\u64cd\u4f5c\u3002",
    noStandards: "\u5c1a\u672a\u51c6\u5907\u6267\u884c\u6807\u51c6\u3002",
    standardsReady: "\u6267\u884c\u6807\u51c6\u5f85\u6279\u51c6\uff0c\u672a\u6267\u884c\u3002",
    standardsApproved: "\u6807\u51c6\u5df2\u6279\u51c6\uff0c\u4ecd\u672a\u81ea\u52a8\u6267\u884c\u3002",
    standardsStatus: "\u72b6\u6001",
    executionStandard: "\u6267\u884c\u6807\u51c6",
    verificationStandard: "\u68c0\u6d4b\u6807\u51c6",
    approveStandardsConfirm: "\u53ea\u6279\u51c6\u6807\u51c6\uff0c\u4e0d\u542f\u52a8\u6267\u884c\u3002\u786e\u8ba4\uff1f",
    recorderDraft: "\u8bb0\u5f55\u8349\u7a3f",
    recorderSeat: "\u8bb0\u5f55\u5e2d",
    reviewers: "\u590d\u67e5\u5e2d",
    content: "\u5185\u5bb9",
    createDraft: "\u521b\u5efa\u8349\u7a3f",
    createFromFinal: "\u7ed3\u8bba\u521b\u5efa\u8349\u7a3f",
    filterAll: "\u5168\u90e8",
    filterReview: "\u5f85\u590d\u67e5",
    filterChanges: "\u9700\u4fee\u6539",
    filterApproval: "\u5f85\u6279\u51c6",
    filterApproved: "\u5df2\u6279\u51c6",
    replaceMemberTitle: "\u66ff\u6362\u6210\u5458",
    seat: "\u5e2d\u4f4d",
    nextName: "\u65b0\u540d\u79f0",
    newPrivateFolder: "\u65b0\u79c1\u4eba\u6587\u4ef6\u5939",
    folderName: "\u6587\u4ef6\u5939\u540d",
    replace: "\u66ff\u6362",
    muteRound: "\u672c\u8f6e\u7981\u8a00",
    muteForever: "\u6c38\u4e45\u7981\u8a00",
    unmute: "\u89e3\u9664\u7981\u8a00",
    kick: "\u8e22\u51fa\u5706\u684c",
    configureApi: "\u4fee\u6539API\u914d\u7f6e",
    configureSeat: "\u914d\u7f6e\u5e2d\u4f4d",
    configureOwner: "\u914d\u7f6e\u8001\u677f",
    ownerName: "\u8001\u677f\u540d\u79f0",
    apiUrl: "API URL",
    apiKey: "API Key",
    providerPreset: "Provider",
    toolsSettings: "\u5de5\u5177",
    memberManagement: "\u6210\u5458\u7ba1\u7406",
    minimizePanel: "\u6700\u5c0f\u5316",
    closePanel: "\u5173\u95ed",
    resizeTranscript: "\u8c03\u6574\u5bf9\u8bdd\u533a",
    useOfficialUrl: "\u4f7f\u7528\u5b98\u65b9 URL",
    checkProviderHealth: "\u68c0\u67e5\u8fde\u63a5",
    detectModels: "\u68c0\u6d4b\u6a21\u578b",
    providerDetected: "\u68c0\u6d4b\u5230 {count} \u4e2a\u6a21\u578b\uff08\u6765\u6e90\uff1a{source}\uff09",
    providerDetectFailed: "\u68c0\u6d4b\u5931\u8d25\uff08\u6765\u6e90\uff1a{source}\uff09{error}",
    providerHealthOk: "\u8fde\u63a5\u53ef\u7528\uff1a{count} \u4e2a\u6a21\u578b\uff08\u6765\u6e90\uff1a{source}\uff09",
    providerHealthFailed: "\u8fde\u63a5\u4e0d\u53ef\u7528\uff08\u6765\u6e90\uff1a{source}\uff09{error}",
    clearGroupApiKeys: "\u6e05\u9664\u672c\u7ec4 Key",
    groupApiKeysCleared: "\u672c\u7ec4 API Key \u5df2\u6e05\u9664\u3002",
    modelName: "\u6a21\u578b\u540d",
    modelPlaceholder: "deepseek-chat",
    detectedModels: "\u68c0\u6d4b\u5230\u7684\u6a21\u578b",
    noDetectedModels: "\u5148\u68c0\u6d4b\u6a21\u578b",
    selectDetectedModel: "\u9009\u62e9\u68c0\u6d4b\u5230\u7684\u6a21\u578b",
    apiPermissionNote: "\u6a21\u578b API \u53ea\u63a5\u6536\u6587\u672c\u6d88\u606f\uff0c\u4e0d\u4f1a\u83b7\u5f97\u672c\u5730\u6587\u4ef6\u8bfb\u5199\u6743\u9650\u3002",
    roleName: "\u89d2\u8272\u540d\u79f0",
    setReviewer: "\u8bbe\u4e3a\u5ba1\u67e5\u8005",
    reviewIntensity: "\u5ba1\u67e5\u529b\u5ea6",
    reviewIntensityLevels: {
      1: "1 \u5bbd\u677e\uff1a\u4ec5\u4e25\u91cd\u963b\u788d\u76ee\u6807\u7684\u95ee\u9898\u624d\u5426\u51b3\uff08\u6bcf\u8f6e\u6700\u591a 2 \u6761\u65b0\u5f02\u8bae\uff09",
      2: "2 \u9002\u4e2d\uff1a\u91cd\u8981\u7f3a\u9677\u4e0e\u5173\u952e\u8fb9\u754c\u95ee\u9898\u53ef\u5426\u51b3\uff08\u6bcf\u8f6e\u6700\u591a 5 \u6761\uff09",
      3: "3 \u4e25\u683c\uff1a\u53ef\u63d0\u51fa\u8be6\u7ec6\u98ce\u9669\uff0c\u4f46\u987b\u533a\u5206\u5fc5\u6539\u4e0e\u5efa\u8bae\uff08\u6bcf\u8f6e\u6700\u591a 8 \u6761\uff09"
    },
    avatar: "\u5934\u50cf",
    cancel: "\u53d6\u6d88",
    save: "\u4fdd\u5b58",
    recentGroups: "\u6700\u8fd1\u5c0f\u7ec4",
    groupsTitle: "\u5c0f\u7ec4",
    pinnedGroups: "\u7f6e\u9876",
    newGroup: "\u65b0\u5efa\u5c0f\u7ec4",
    searchGroups: "\u641c\u7d22\u5c0f\u7ec4",
    openGroup: "\u6253\u5f00",
    pinGroup: "\u7f6e\u9876",
    unpinGroup: "\u53d6\u6d88\u7f6e\u9876",
    renameGroup: "\u91cd\u547d\u540d",
    removeGroupRecord: "\u5220\u9664\u8bb0\u5f55",
    renameGroupPrompt: "\u8f93\u5165\u65b0\u5c0f\u7ec4\u540d\u79f0",
    groupRecordRemoved: "\u5c0f\u7ec4\u8bb0\u5f55\u5df2\u79fb\u9664\uff0c\u6587\u4ef6\u5939\u672a\u5220\u9664\u3002",
    noRecentGroups: "\u6682\u65e0\u6700\u8fd1\u5c0f\u7ec4",
    createGroupDone: "\u5c0f\u7ec4\u5df2\u521b\u5efa\u3002",
    groupLoaded: "\u5c0f\u7ec4\u5df2\u52a0\u8f7d\u3002",
    globalRequirementSaved: "\u5168\u5c40\u8981\u6c42\u5df2\u786e\u8ba4\u3002",
    permissionSaved: "\u6743\u9650\u5df2\u4fdd\u5b58\u3002",
    gitRequired: "\u542f\u7528\u5de5\u5177\u6743\u9650\u9700\u8981 Git \u4ed3\u5e93\u3002",
    highRiskPermissionConfirm: "\u5207\u5230\u5de5\u5177/\u5b8c\u5168\u6743\u9650\u9700\u8981 Git commit \u4ea4\u63a5\uff0c\u786e\u8ba4\u7ee7\u7eed\uff1f",
    popOut: "\u5f39\u51fa",
    fullscreen: "\u5168\u5c4f",
    restoreWindow: "\u8fd8\u539f",
    resizeTable: "\u8c03\u6574\u684c\u9762",
    councilRunning: "\u5706\u684c\u6b63\u5728\u8ba8\u8bba...",
    councilFinished: "\u8ba8\u8bba\u5b8c\u6210\u3002",
    roundWaitingBoss: "\u7b49\u5f85\u8001\u677f\u53d1\u8bdd\u3002",
    roundPaused: "\u5df2\u6682\u505c\u5f53\u524d AI\u3002",
    roundStopped: "\u672c\u8f6e\u5df2\u505c\u6b62\u3002",
    agentStopped: "{name}\u5df2\u505c\u6b62\u3002",
    resumeCurrentAgent: "\u7ee7\u7eed {name}\u3002",
    continuingNextSeat: "\u5df2\u8df3\u5230\u4e0b\u4e00\u5e2d\u3002",
    noNextSeat: "\u5df2\u5230\u672c\u8f6e\u6700\u540e\u4e00\u5e2d\u3002",
    stopOnlyCurrentAgent: "\u53ea\u80fd\u505c\u6b62\u6b63\u5728\u8f93\u51fa\u7684 AI\u3002",
    roundInterjected: "\u8001\u677f\u5df2\u63d2\u8bdd\uff0c\u4ece 1 \u53f7\u4f4d\u91cd\u5f00\u672c\u8f6e\u3002",
    emptyBossInput: "\u8bf7\u5148\u8f93\u5165\u8001\u677f\u53d1\u8bdd\u3002",
    emptyCouncil: "\u8bf7\u5148\u70b9\u51fb\u7a7a\u5e2d\u63a5\u5165\u81f3\u5c11\u4e00\u4e2a AI\u3002",
    draftCreated: "\u8349\u7a3f\u5df2\u521b\u5efa\u3002",
    draftPrepared: "\u7ed3\u8bba\u5df2\u586b\u5165\u8349\u7a3f\u3002",
    reviewSaved: "\u590d\u67e5\u5df2\u4fdd\u5b58\u3002",
    reviewRejected: "\u590d\u67e5\u5df2\u62d2\u7edd\u3002",
    draftFinalized: "\u8349\u7a3f\u5df2\u6279\u51c6\u3002",
    memberReplaced: "\u6210\u5458\u5df2\u66ff\u6362\u3002",
    errorPrefix: "\u51fa\u9519\uff1a",
    createGroupError: "\u8bf7\u5148\u521b\u5efa\u5c0f\u7ec4\u3002",
    loadGroupError: "\u8bf7\u5148\u52a0\u8f7d\u5c0f\u7ec4\u3002",
    noDrafts: "\u6682\u65e0\u8349\u7a3f\u3002",
    noFinal: "\u8bf7\u5148\u8fd0\u884c\u8ba8\u8bba\u3002",
    noDecision: "\u6ca1\u6709\u53ef\u6572\u5b9a\u7684\u7ed3\u8bba\u3002",
    decisionConfirmed: "\u51b3\u8bae\u5df2\u7559\u5b58\uff0c\u672a\u81ea\u52a8\u6267\u884c\u6587\u4ef6\u5199\u5165\u3002",
    approveReview: "\u590d\u67e5\u901a\u8fc7",
    rejectReview: "\u8981\u6c42\u4fee\u6539",
    finalize: "\u6700\u7ec8\u6279\u51c6",
    round: "\u7b2c {round} \u8f6e",
    roleFallback: "\u672a\u8bbe\u89d2\u8272",
    emptySeat: "\u7a7a\u4f4d",
    clickToAdd: "\u70b9\u51fb\u63a5\u5165",
    boss: "\u8001\u677f",
    thinking: "\u601d\u8003\u4e2d",
    done: "\u5b8c\u6210/\u8ba4\u540c",
    cancelled: "\u53d6\u6d88/\u4e2d\u65ad",
    idle: "\u5f85\u547d",
    spoke: "\u5df2\u53d1\u8a00",
    dissent: "\u6709\u4fdd\u7559",
    degraded: "\u8c03\u7528\u5931\u8d25",
    contextNormal: "\u4e0a\u4e0b\u6587\u6b63\u5e38",
    contextWarning: "\u63a5\u8fd1\u4e0a\u9650",
    contextCompress: "\u9700\u8981\u538b\u7f29",
    contextStop: "\u8d85\u8fc7\u9608\u503c",
    contextOverflow: "\u6838\u5fc3\u8d85\u9650",
    contextUsage: "\u4e0a\u4e0b\u6587\uff1a{status} {total}/{limit}",
    coreOverflow: "\u6838\u5fc3 {core}/{limit}",
    budgetUsage: "\u9884\u7b97\uff1a{status}",
    budgetWarning: "\u63a5\u8fd1\u4e0a\u9650",
    budgetConfirm: "\u9700\u786e\u8ba4",
    budgetPause: "\u8d85\u8fc7\u9884\u7b97",
    usageTitle: "\u672c\u7ec4\u7528\u91cf",
    usageEmpty: "\u6682\u65e0\u7528\u91cf\u8bb0\u5f55\u3002",
    usageCalls: "\u8c03\u7528",
    usageInput: "\u8f93\u5165",
    usageOutput: "\u8f93\u51fa",
    usageUnavailable: "\u4e0d\u53ef\u7528",
    consensus: "\u5171\u8bc6 {score}%",
    finalStateReady: "\u53ef\u6267\u884c",
    finalStateRisks: "\u53ef\u7528\uff0c\u4f46\u6709\u98ce\u9669",
    finalStateNeedsRevision: "\u5f85\u4fee\u8ba2",
    finalStateFailed: "\u672a\u6536\u655b",
    blockingIssues: "\u963b\u65ad\u95ee\u9898",
    finalAnswer: "\u6700\u7ec8\u7ed3\u8bba",
    minorityReport: "\u672a\u89e3\u51b3\u5f02\u8bae",
    risks: "\u98ce\u9669",
    nextActions: "\u4e0b\u4e00\u6b65",
    noItems: "\u65e0",
    pause: "\u5df2\u6682\u505c\u5f53\u524d AI\u3002",
    resume: "\u7ee7\u7eed\u5f53\u524d AI\u3002",
    interruptedByBoss: "\uff08\u88ab\u8001\u677f\u6253\u65ad\uff09",
    stoppedByBoss: "\uff08\u88ab\u8001\u677f\u505c\u6b62\uff09",
    partialSuffix: "\uff08\u672a\u5b8c\u6210\uff09",
    mutedRoundSystem: "{name}\u672c\u8f6e\u5df2\u7981\u8a00\u3002",
    mutedForeverSystem: "{name}\u5df2\u6c38\u4e45\u7981\u8a00\u3002",
    unmutedSystem: "{name}\u5df2\u89e3\u9664\u7981\u8a00\u3002",
    kickedSystem: "{name}\u5df2\u88ab\u8e22\u51fa\u5706\u684c\u3002",
    configuredSystem: "{name}\u5df2\u63a5\u5165\u5706\u684c\u3002"
    ,privateChat: "\u79c1\u804a"
    ,privateInstruction: "\u5355\u72ec\u6307\u4ee4"
    ,privateChatButton: "\u79c1\u804a"
    ,privateSent: "\u5df2\u5411{name}\u4e0b\u53d1\u5355\u72ec\u6307\u4ee4\u3002"
    ,noPrivateMessages: "\u6682\u65e0\u79c1\u804a\u6307\u4ee4\u3002"
    ,ownerSaid: "\u8001\u677f\u8bf4"
    ,memberSaid: "\u6210\u5458\u8bf4"
    ,permissionChecked: "\u6743\u9650\u5df2\u786e\u8ba4\uff1a\u6a21\u578b API \u65e0\u672c\u5730\u6587\u4ef6\u5de5\u5177\uff1b\u672c\u5730\u5199\u5165\u4ec5\u9650\u5de5\u4f5c\u533a\u3002"
    ,folderPickerUnavailable: "\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u76f4\u63a5\u9009\u62e9\u6587\u4ef6\u5939\uff0c\u8bf7\u5728\u8def\u5f84\u6846\u4e2d\u8f93\u5165\u6216\u7c98\u8d34\u8def\u5f84\u3002"
  },
  en: {
    ready: "Ready.",
    rootFolder: "Root folder",
    groupFolder: "Group folder",
    members: "Members",
    groupPath: "Group path",
    groupNameLabel: "Group name",
    groupNamePlaceholder: "For example: My AI council",
    groupsRoot: "All groups folder",
    actualGroupPath: "Actual path",
    groupsRootNote: "New groups are created under this parent folder. Choose can change the parent folder or point to an existing group.",
    chooseFolder: "Choose",
    createGroup: "Create",
    load: "Load",
    noGroup: "No group loaded",
    modeTable: "Table",
    modeSide: "Panel",
    zoom: "Zoom",
    autonomousRounds: "Rounds",
    checkAllSeats: "Check All Seats",
    checkingSeats: "Checking seats...",
    seatHealthOk: "Seat healthy ({source})",
    seatHealthFailed: "Seat failed: {error} ({source})",
    seatHealthSummary: "Seat check complete: {ok} available, {failed} need attention.",
    unhealthySeatsWarning: "Detected unhealthy seats: {names}. Continuing will skip them for this round. Continue?",
    unhealthySeatsSkipped: "Skipped unhealthy seats for this round: {names}.",
    noAvailableSeatsAfterHealthCheck: "No available seats: unhealthy seats were skipped for this round, so the discussion did not start.",
    pauseDiscussion: "Pause",
    resumeDiscussion: "Resume",
    continuePreviousCycle: "Continue previous cycle",
    continuationNotice: "Continuing from the previous cycle: {state}.",
    continuationPlaceholder: "Continue the previous cycle...",
    bossInterjection: "Boss interjection",
    bossInput: "Boss speaks first",
    sendInterjection: "Send",
    stopAll: "Stop all",
    stopOne: "Stop one",
    globalRequirement: "Global requirement",
    globalRequirementPlaceholder: "Constraint for all AI",
    confirm: "Confirm",
    permissionTier: "Permission",
    applyAllPermissions: "Apply all",
    modifyPermission: "Permission",
    permissionText: "Text",
    permissionTool: "Tools",
    permissionFull: "Full",
    tableCenterHint: "Round table",
    noMessages: "No messages yet.",
    noGroupLoaded: "No group loaded.",
    ownerLabel: "Boss",
    conversation: "Transcript",
    decisions: "Summary",
    fileOperations: "File proposals",
    refresh: "Refresh",
    noFileOperations: "No file operation proposals.",
    approveFileOperation: "Approve",
    autoApproveFileOperation: "Auto approve",
    executeFileOperation: "Execute + commit",
    fileOperationApproved: "File proposal approved.",
    fileOperationExecuted: "Executed and committed.",
    fileOperationDangerConfirm: "This may overwrite or delete files. Continue?",
    fileOperationAutoConfirm: "Only non-dangerous writes in full mode can be auto-approved. Continue?",
    fileOperationAudit: "Recent log",
    commitHash: "Commit",
    fileOperationPreview: "Preview",
    confirmDecision: "Save final answer",
    confirmDecisionTitle: "Save the current final answer to decision history without starting execution.",
    noDecisions: "No decisions yet.",
    prepareStandards: "Generate execution standards",
    prepareStandardsTitle: "Generate execution and verification standards without executing file operations.",
    approveStandards: "Confirm standards",
    approveStandardsTitle: "Confirm these standards for later verification without executing file operations.",
    noStandards: "No execution standards prepared.",
    standardsReady: "Execution standards are pending approval. No execution started.",
    standardsApproved: "Standards approved. No execution was started.",
    standardsStatus: "Status",
    executionStandard: "Execution standard",
    verificationStandard: "Verification standard",
    approveStandardsConfirm: "Approve standards only, without starting execution?",
    recorderDraft: "Recorder Draft",
    recorderSeat: "Recorder seat",
    reviewers: "Reviewers",
    content: "Content",
    createDraft: "Create draft",
    createFromFinal: "Create draft from final",
    filterAll: "All",
    filterReview: "Review",
    filterChanges: "Changes",
    filterApproval: "Approval",
    filterApproved: "Approved",
    replaceMemberTitle: "Replace Member",
    seat: "Seat",
    nextName: "Next name",
    newPrivateFolder: "New private folder",
    folderName: "Folder name",
    replace: "Replace",
    muteRound: "Mute this round",
    muteForever: "Mute always",
    unmute: "Unmute",
    kick: "Kick out",
    configureApi: "Configure API",
    configureSeat: "Configure seat",
    configureOwner: "Configure boss",
    ownerName: "Boss name",
    apiUrl: "API URL",
    apiKey: "API Key",
    providerPreset: "Provider",
    toolsSettings: "Tools",
    memberManagement: "Member management",
    minimizePanel: "Minimize",
    closePanel: "Close",
    resizeTranscript: "Resize transcript",
    useOfficialUrl: "Use official URL",
    checkProviderHealth: "Check connection",
    detectModels: "Detect models",
    providerDetected: "Detected {count} models (source: {source})",
    providerDetectFailed: "Detection failed (source: {source}) {error}",
    providerHealthOk: "Connection OK: {count} models (source: {source})",
    providerHealthFailed: "Connection unavailable (source: {source}) {error}",
    clearGroupApiKeys: "Clear group keys",
    groupApiKeysCleared: "Current group API keys cleared.",
    modelName: "Model",
    modelPlaceholder: "deepseek-chat",
    detectedModels: "Detected models",
    noDetectedModels: "Detect models first",
    selectDetectedModel: "Choose a detected model",
    apiPermissionNote: "The model API receives text only and does not get local file read/write permissions.",
    roleName: "Role name",
    setReviewer: "Set as reviewer",
    reviewIntensity: "Review intensity",
    reviewIntensityLevels: {
      1: "1 Light: only severe goal-blocking issues block (max 2 new objections/round)",
      2: "2 Medium: important defects and key boundary issues block (max 5/round)",
      3: "3 Strict: detailed risks allowed but must separate must-fix from nice-to-have (max 8/round)"
    },
    avatar: "Avatar",
    cancel: "Cancel",
    save: "Save",
    recentGroups: "Recent groups",
    groupsTitle: "Groups",
    pinnedGroups: "Pinned",
    newGroup: "New group",
    searchGroups: "Search groups",
    openGroup: "Open",
    pinGroup: "Pin",
    unpinGroup: "Unpin",
    renameGroup: "Rename",
    removeGroupRecord: "Remove record",
    renameGroupPrompt: "Enter a new group name",
    groupRecordRemoved: "Group record removed. Folder was not deleted.",
    noRecentGroups: "No recent groups",
    createGroupDone: "Group created.",
    groupLoaded: "Group loaded.",
    globalRequirementSaved: "Global requirement confirmed.",
    permissionSaved: "Permissions saved.",
    gitRequired: "Git repository required before enabling tool permissions.",
    highRiskPermissionConfirm: "Tool/full permissions require Git commit handoff. Continue?",
    popOut: "Pop out",
    fullscreen: "Fullscreen",
    restoreWindow: "Restore",
    resizeTable: "Resize table",
    councilRunning: "Round table is running...",
    councilFinished: "Council finished.",
    roundWaitingBoss: "Waiting for the boss.",
    roundPaused: "Current AI paused.",
    roundStopped: "Round stopped.",
    agentStopped: "{name} stopped.",
    resumeCurrentAgent: "Resuming {name}.",
    continuingNextSeat: "Continuing from the next seat.",
    noNextSeat: "This was the last seat in the round.",
    stopOnlyCurrentAgent: "Only the currently running AI can be stopped.",
    roundInterjected: "Boss interjected. Restarting from seat 1.",
    emptyBossInput: "Type the boss message first.",
    emptyCouncil: "Seat at least one AI first.",
    draftCreated: "Draft created.",
    draftPrepared: "Final answer copied into draft.",
    reviewSaved: "Review saved.",
    reviewRejected: "Review rejected.",
    draftFinalized: "Draft approved.",
    memberReplaced: "Member replaced.",
    errorPrefix: "Error: ",
    createGroupError: "Create a group first.",
    loadGroupError: "Load a group first.",
    noDrafts: "No drafts.",
    noFinal: "Run a council first.",
    noDecision: "No final answer to confirm.",
    decisionConfirmed: "Decision saved. No file write or execution was started.",
    approveReview: "Approve review",
    rejectReview: "Request changes",
    finalize: "Finalize",
    round: "Round {round}",
    roleFallback: "No role",
    emptySeat: "Empty",
    clickToAdd: "Click to add",
    boss: "Boss",
    thinking: "Thinking",
    done: "Done / agree",
    cancelled: "Cancelled",
    idle: "Idle",
    spoke: "Spoke",
    dissent: "Reserved",
    degraded: "Failed",
    contextNormal: "Context normal",
    contextWarning: "Near context limit",
    contextCompress: "Compression needed",
    contextStop: "Over threshold",
    contextOverflow: "Core overflow",
    contextUsage: "Context: {status} {total}/{limit}",
    coreOverflow: "core {core}/{limit}",
    budgetUsage: "Budget: {status}",
    budgetWarning: "Near limit",
    budgetConfirm: "Confirm",
    budgetPause: "Over budget",
    usageTitle: "Group usage",
    usageEmpty: "No usage yet.",
    usageCalls: "Calls",
    usageInput: "Input",
    usageOutput: "Output",
    usageUnavailable: "Unavailable",
    consensus: "Consensus {score}%",
    finalStateReady: "Ready",
    finalStateRisks: "Usable with risks",
    finalStateNeedsRevision: "Needs revision",
    finalStateFailed: "Failed to converge",
    blockingIssues: "Blocking issues",
    finalAnswer: "Final answer",
    minorityReport: "Unresolved dissent",
    risks: "Risks",
    nextActions: "Next actions",
    noItems: "None",
    pause: "Current AI paused.",
    resume: "Current AI resumed.",
    interruptedByBoss: "(interrupted by boss)",
    stoppedByBoss: "(stopped by boss)",
    partialSuffix: "(partial)",
    mutedRoundSystem: "{name} is muted for this round.",
    mutedForeverSystem: "{name} is muted permanently.",
    unmutedSystem: "{name} is unmuted.",
    kickedSystem: "{name} was kicked out.",
    configuredSystem: "{name} joined the table."
    ,privateChat: "Private chat"
    ,privateInstruction: "Private instruction"
    ,privateChatButton: "Chat"
    ,privateSent: "Private instruction sent to {name}."
    ,noPrivateMessages: "No private instructions yet."
    ,ownerSaid: "Boss said"
    ,memberSaid: "Member said"
    ,permissionChecked: "Permissions checked: model APIs have no local file tools; local writes are restricted to the workspace root."
    ,folderPickerUnavailable: "This browser cannot choose a folder directly. Type or paste the path instead."
  }
};

const $ = (id) => document.getElementById(id);

init();

function init() {
  wireEvents();
  applyLanguage();
  applyConversationMode();
  applyOwner();
  applyUiLayout();
  initPermissionControls();
  applyWindowLayout();
  renderRecentGroups();
  renderDecisionHistory();
  loadProviderPresets().catch(() => {});
  loadAppSettings().then(() => refreshGroupIndex()).then(loadLastGroup).catch(() => loadLastGroup());
  checkPermissions();
  renderMembers([]);
  setRoundState("idle");
}

function wireEvents() {
  $("createGroup").addEventListener("click", () => createGroup().catch(() => {}));
  $("loadGroup").addEventListener("click", () => loadGroup().catch(() => {}));
  $("createDraft").addEventListener("click", () => createDraft().catch(() => {}));
  $("createFromFinal").addEventListener("click", () => createDraftFromFinal().catch(() => {}));
  $("replaceMember").addEventListener("click", () => replaceMember().catch(() => {}));
  $("confirmDecision").addEventListener("click", confirmDecision);
  $("prepareStandards").addEventListener("click", () => prepareExecutionStandards().catch(() => {}));
  $("approveStandards").addEventListener("click", () => approveExecutionStandards().catch(() => {}));
  $("refreshFileOperations").addEventListener("click", () => refreshFileOperations().catch(() => {}));
  $("fileOperationsPanel").addEventListener("click", handleFileOperationAction);
  $("saveGlobalRequirement").addEventListener("click", () => saveGlobalRequirement().catch(() => {}));
  $("applyGlobalPermission").addEventListener("click", () => applyGlobalPermission().catch(() => {}));
  $("checkAllSeats").addEventListener("click", () => checkAllSeatsHealth({ manual: true }).catch((error) => setStatusText(`${t("errorPrefix")}${error.message}`)));
  $("pauseCouncil").addEventListener("click", togglePause);
  $("stopCouncil").addEventListener("click", stopAll);
  $("tableZoom").addEventListener("input", updateTableZoom);
  $("autonomousRounds").addEventListener("input", updateAutonomousRounds);
  document.querySelectorAll("[data-resize-edge]").forEach((handle) => {
    handle.addEventListener("pointerdown", startTableResize);
  });
  document.querySelectorAll("[data-window-drag]").forEach((handle) => {
    handle.addEventListener("pointerdown", startWindowDrag);
  });
  document.querySelectorAll("[data-window-action]").forEach((button) => {
    button.addEventListener("click", handleWindowAction);
  });
  document.querySelectorAll("[data-open-panel]").forEach((button) => {
    button.addEventListener("click", handleOpenToolPanel);
  });
  document.querySelectorAll("[data-panel-drag]").forEach((handle) => {
    handle.addEventListener("pointerdown", startToolPanelDrag);
  });
  document.querySelectorAll("[data-panel-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", startToolPanelResize);
  });
  $("toolPanels").addEventListener("click", handleToolPanelAction);
  $("rightPanelResize").addEventListener("pointerdown", startRightPanelResize);
  window.addEventListener("resize", handleUiViewportChange);
  window.addEventListener("beforeunload", saveUiLayout);
  $("chooseGroupFolder").addEventListener("click", chooseGroupFolder);
  $("groupFolderName").addEventListener("input", updateGroupPathPreview);
  $("groupsRoot").addEventListener("input", updateGroupPathPreview);
  $("newGroupFromSidebar").addEventListener("click", openGroupDialog);
  $("groupSearch").addEventListener("input", updateGroupSearch);
  $("pinnedGroups").addEventListener("click", openSidebarGroup);
  $("sidebarGroups").addEventListener("click", openSidebarGroup);
  $("pinnedGroups").addEventListener("contextmenu", openGroupContextMenu);
  $("sidebarGroups").addEventListener("contextmenu", openGroupContextMenu);
  $("groupMenu").addEventListener("click", handleGroupMenuAction);
  $("sendBossInterjection").addEventListener("click", sendBossInterjection);
  $("bossInterjection").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendBossInterjection();
    }
  });
  $("modeTable").addEventListener("click", () => setConversationMode("table"));
  $("modeSide").addEventListener("click", () => setConversationMode("side"));
  $("langZh").addEventListener("click", () => setLanguage("zh"));
  $("langEn").addEventListener("click", () => setLanguage("en"));
  $("recentGroups").addEventListener("click", openRecentGroup);
  $("drafts").addEventListener("click", handleDraftAction);
  $("membersList").addEventListener("click", handleSeatClick);
  document.addEventListener("pointerdown", handleSeatRightPress, true);
  document.addEventListener("mousedown", handleSeatRightPress, true);
  document.addEventListener("contextmenu", handleContextMenu, true);
  $("seatMenu").addEventListener("click", handleSeatMenuAction);
  $("saveSeatConfig").addEventListener("click", saveSeatConfig);
  $("clearGroupApiKeys").addEventListener("click", clearCurrentGroupApiKeys);
  $("dialogReviewer").addEventListener("change", updateReviewIntensityDisplay);
  $("dialogReviewIntensity").addEventListener("input", updateReviewIntensityDisplay);
  $("dialogProviderPreset").addEventListener("change", handleProviderPresetChange);
  $("useOfficialProviderUrl").addEventListener("click", useOfficialProviderUrl);
  $("checkProviderHealth").addEventListener("click", () => checkProviderHealth().catch((error) => setProviderDetectionStatus(error.message || "provider health check failed", true)));
  $("detectProviderModels").addEventListener("click", () => detectProviderModels().catch((error) => setProviderDetectionStatus(error.message || "model discovery failed", true)));
  $("dialogModelCandidates").addEventListener("change", handleDetectedModelChoice);
  $("sendPrivateInstruction").addEventListener("click", () => sendPrivateInstruction().catch((error) => setStatus(error.message || "private chat failed")));
  $("ownerAvatar").addEventListener("click", openOwnerDialog);
  $("saveOwnerConfig").addEventListener("click", saveOwnerConfig);
  $("ownerLabel").addEventListener("input", saveOwnerLabel);
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#seatMenu")) $("seatMenu").hidden = true;
    if (!event.target.closest("#groupMenu")) $("groupMenu").hidden = true;
  });
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => setDraftFilter(button.dataset.filter || ""));
  });
}


function handleUiViewportChange() {
  applyUiLayout();
  saveUiLayoutDebounced();
}

function handleOpenToolPanel(event) {
  const panelId = event.currentTarget.dataset.openPanel;
  if (!panelId) return;
  openToolPanel(panelId);
}

function handleToolPanelAction(event) {
  const button = event.target.closest("button[data-panel-action]");
  if (!button) return;
  const panelId = button.dataset.panelTarget;
  if (!panelId) return;
  const action = button.dataset.panelAction;
  if (action === "close") closeToolPanel(panelId);
  if (action === "minimize") minimizeToolPanel(panelId);
}

function openToolPanel(panelId) {
  state.uiLayout.panels[panelId] = {
    ...(state.uiLayout.panels[panelId] || {}),
    open: true,
    minimized: false
  };
  applyUiLayout();
  saveUiLayout();
}

function closeToolPanel(panelId) {
  state.uiLayout.panels[panelId] = {
    ...(state.uiLayout.panels[panelId] || {}),
    open: false,
    minimized: false
  };
  applyUiLayout();
  saveUiLayout();
}

function minimizeToolPanel(panelId) {
  state.uiLayout.panels[panelId] = {
    ...(state.uiLayout.panels[panelId] || {}),
    open: false,
    minimized: true
  };
  applyUiLayout();
  saveUiLayout();
}

function restoreToolPanel(panelId) {
  openToolPanel(panelId);
}

function applyUiLayout() {
  updateCommandBarHeight();
  state.uiLayout.panels = state.uiLayout.panels || {};
  const rightWidth = clampUiDimension(Number(state.uiLayout.rightPanelWidth || 420), 320, 420, Math.max(340, window.innerWidth - 520));
  state.uiLayout.rightPanelWidth = rightWidth;
  document.documentElement.style.setProperty("--right-panel-w", `${rightWidth}px`);
  document.querySelectorAll("[data-tool-panel]").forEach((panel) => {
    const panelId = panel.dataset.toolPanel;
    const record = state.uiLayout.panels?.[panelId] || {};
    panel.hidden = !record.open;
    if (record.open) applyToolPanelGeometry(panel, panelId, record);
  });
  document.querySelectorAll("[data-open-panel]").forEach((button) => {
    const record = state.uiLayout.panels?.[button.dataset.openPanel] || {};
    button.classList.toggle("is-active", Boolean(record.open || record.minimized));
  });
  renderPanelTray();
}


function updateCommandBarHeight() {
  const bar = document.querySelector(".command-bar");
  if (!bar) return;
  document.documentElement.style.setProperty("--command-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}

function applyToolPanelGeometry(panel, panelId, record) {
  const fallback = defaultToolPanelGeometry(panelId);
  const width = clampUiDimension(Number(record.width || fallback.width), 320, fallback.width, Math.max(320, window.innerWidth - 24));
  const height = clampUiDimension(Number(record.height || fallback.height), 260, fallback.height, Math.max(260, window.innerHeight - 24));
  const left = clamp(Number(record.left ?? fallback.left), 12, Math.max(12, window.innerWidth - width - 12));
  const top = clamp(Number(record.top ?? fallback.top), 54, Math.max(54, window.innerHeight - height - 12));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.right = "auto";
  panel.style.width = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(height)}px`;
}

function defaultToolPanelGeometry(panelId) {
  const wide = panelId === "decisions";
  const width = wide ? 680 : 430;
  const height = panelId === "settings" ? 640 : wide ? 680 : 420;
  return {
    left: Math.max(12, window.innerWidth - (state.uiLayout.rightPanelWidth || 420) - width - 28),
    top: 88,
    width,
    height
  };
}

function startToolPanelDrag(event) {
  if (event.target.closest("button,input,select,textarea,summary")) return;
  const panelId = event.currentTarget.dataset.panelDrag;
  const panel = document.querySelector(`[data-tool-panel="${panelId}"]`);
  if (!panel || panel.hidden) return;
  event.preventDefault();
  const rect = panel.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const onMove = (moveEvent) => {
    const record = state.uiLayout.panels[panelId] || {};
    const width = rect.width;
    const height = rect.height;
    record.left = Math.round(clamp(rect.left + moveEvent.clientX - startX, 12, Math.max(12, window.innerWidth - width - 12)));
    record.top = Math.round(clamp(rect.top + moveEvent.clientY - startY, 54, Math.max(54, window.innerHeight - height - 12)));
    state.uiLayout.panels[panelId] = record;
    applyToolPanelGeometry(panel, panelId, record);
    saveUiLayoutDebounced();
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    saveUiLayout();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function startToolPanelResize(event) {
  const panelId = event.currentTarget.dataset.panelResize;
  const panel = document.querySelector(`[data-tool-panel="${panelId}"]`);
  if (!panel || panel.hidden) return;
  event.preventDefault();
  const rect = panel.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const onMove = (moveEvent) => {
    const record = state.uiLayout.panels[panelId] || {};
    record.left = Math.round(rect.left);
    record.top = Math.round(rect.top);
    record.width = Math.round(clampUiDimension(rect.width + moveEvent.clientX - startX, 320, rect.width, Math.max(320, window.innerWidth - rect.left - 12)));
    record.height = Math.round(clampUiDimension(rect.height + moveEvent.clientY - startY, 260, rect.height, Math.max(260, window.innerHeight - rect.top - 12)));
    state.uiLayout.panels[panelId] = record;
    applyToolPanelGeometry(panel, panelId, record);
    saveUiLayoutDebounced();
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    saveUiLayout();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}
function renderPanelTray() {
  const tray = $("panelTray");
  if (!tray) return;
  tray.innerHTML = "";
  for (const [panelId, record] of Object.entries(state.uiLayout.panels || {})) {
    if (!record.minimized) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = panelLabel(panelId);
    button.addEventListener("click", () => restoreToolPanel(panelId));
    tray.appendChild(button);
  }
}

function panelLabel(panelId) {
  if (panelId === "members") return t("members");
  if (panelId === "requirement") return t("globalRequirement");
  if (panelId === "decisions") return t("decisions");
  if (panelId === "settings") return t("toolsSettings");
  return panelId;
}

function startRightPanelResize(event) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = state.uiLayout.rightPanelWidth || 420;
  const onMove = (moveEvent) => {
    const nextWidth = clampUiDimension(startWidth - (moveEvent.clientX - startX), 320, startWidth, Math.max(340, window.innerWidth - 520));
    state.uiLayout.rightPanelWidth = Math.round(nextWidth);
    document.documentElement.style.setProperty("--right-panel-w", `${state.uiLayout.rightPanelWidth}px`);
    saveUiLayoutDebounced();
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    saveUiLayout();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function saveUiLayout() {
  if (state.uiLayoutSaveTimer) {
    clearTimeout(state.uiLayoutSaveTimer);
    state.uiLayoutSaveTimer = null;
  }
  saveJson("ai-council-ui-layout", state.uiLayout);
}

function saveUiLayoutDebounced() {
  if (state.uiLayoutSaveTimer) clearTimeout(state.uiLayoutSaveTimer);
  state.uiLayoutSaveTimer = setTimeout(saveUiLayout, 500);
}
function openGroupDialog() {
  const dialog = $("groupDialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  updateGroupPathPreview();
  setTimeout(() => $("groupFolderName")?.focus(), 0);
}

function closeGroupDialog() {
  const dialog = $("groupDialog");
  if (dialog?.open) dialog.close();
}
async function loadAppSettings() {
  try {
    state.appSettings = await api("/api/app-settings");
  } catch {
    state.appSettings = { groupsRoot: "./workspace-ui", firstRunComplete: false };
  }
  applyGroupSettingsForm();
}

async function saveAppSettings() {
  const groupsRoot = $("groupsRoot").value.trim() || state.appSettings.groupsRoot || "./workspace-ui";
  state.appSettings = await api("/api/app-settings", {
    groupsRoot,
    firstRunComplete: true
  });
  applyGroupSettingsForm();
  return state.appSettings;
}

function applyGroupSettingsForm() {
  if ($("groupsRoot")) $("groupsRoot").value = state.appSettings.groupsRoot || "./workspace-ui";
  if ($("groupFolderName") && !$("groupFolderName").value.trim()) $("groupFolderName").value = "demo-group";
  updateGroupPathPreview();
}

function updateGroupPathPreview() {
  if (!$("groupPath")) return;
  const groupsRoot = $("groupsRoot")?.value.trim() || state.appSettings.groupsRoot || "./workspace-ui";
  const groupName = sanitizeGroupFolderName($("groupFolderName")?.value || "demo-group");
  $("groupPath").value = joinDisplayPath(groupsRoot, groupName || "demo-group");
}

function sanitizeGroupFolderName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function joinDisplayPath(root, name) {
  const cleanRoot = String(root || ".").replace(/[\\/]+$/, "");
  const separator = cleanRoot.includes("\\") ? "\\" : "/";
  return `${cleanRoot}${separator}${name}`;
}
function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem("ai-council-lang", lang);
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.body.dataset.lang = state.lang;
  $("langZh").classList.toggle("active", state.lang === "zh");
  $("langEn").classList.toggle("active", state.lang === "en");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") return;
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    const text = t(node.dataset.i18nTitle);
    node.title = text;
    node.setAttribute("aria-label", text);
  });
  const globalTier = $("globalPermissionTier").value || state.permissions.defaultTier || "text";
  const dialogTier = $("dialogPermissionTier").value || "text";
  fillPermissionSelect($("globalPermissionTier"));
  fillPermissionSelect($("dialogPermissionTier"));
  $("globalPermissionTier").value = globalTier;
  $("dialogPermissionTier").value = dialogTier;
  updateReviewIntensityDisplay();
  syncRuntimeText();
  renderMembers(state.group?.seats || []);
  renderDecisionHistory();
  renderUsageSummary();
}

function syncRuntimeText() {
  $("status").textContent = $("status").dataset.key ? t($("status").dataset.key) : t("ready");
  if (!state.group) $("groupName").textContent = t("noGroup");
  if ($("conversation").classList.contains("empty")) $("conversation").textContent = t("noMessages");
  if ($("tableConversation").classList.contains("empty")) $("tableConversation").textContent = t("noMessages");
  if ($("drafts").classList.contains("empty")) $("drafts").textContent = t("noDrafts");
  if ($("standardsPanel").classList.contains("empty")) $("standardsPanel").textContent = t("noStandards");
  renderRecentGroups();
  renderGroupSidebar();
  renderRoundControls();
}

async function checkPermissions() {
  try {
    const permissions = await api("/api/permissions");
    if (permissions?.modelApi?.canReadLocalFiles === false && permissions?.modelApi?.canWriteLocalFiles === false) {
      appendSystemMessage(t("permissionChecked"));
    }
  } catch {
    // Permission status is informational; discussion controls should still load.
  }
}

function t(key, replacements = {}) {
  let text = i18n[state.lang][key] || key;
  for (const [name, value] of Object.entries(replacements)) {
    text = text.replace(`{${name}}`, value);
  }
  return text;
}

function initPermissionControls() {
  fillPermissionSelect($("globalPermissionTier"));
  fillPermissionSelect($("dialogPermissionTier"));
  $("globalPermissionTier").value = state.permissions.defaultTier || "text";
}

function fillPermissionSelect(select) {
  select.innerHTML = "";
  for (const tier of ["text", "tool", "full"]) {
    const option = document.createElement("option");
    option.value = tier;
    option.textContent = permissionTierLabel(tier);
    select.appendChild(option);
  }
}

function permissionTierLabel(tier) {
  if (tier === "tool") return t("permissionTool");
  if (tier === "full") return t("permissionFull");
  return t("permissionText");
}

function permissionTierNumber(tier) {
  if (tier === "tool") return "2";
  if (tier === "full") return "3";
  return "1";
}

function effectivePermissionTier(seatId) {
  return state.permissions.seatTiers?.[seatId] || state.permissions.defaultTier || "text";
}

async function createGroup() {
  await withBusy("createGroup", async () => {
    const groupFolderName = sanitizeGroupFolderName($("groupFolderName").value || "demo-group");
    if (!groupFolderName) throw new Error(t("createGroupError"));
    $("groupFolderName").value = groupFolderName;
    const settings = await saveAppSettings();
    const group = await api("/api/workspace/init", {
      root: settings.groupsRoot,
      groupFolderName,
      members: []
    });
    $("groupPath").value = group.groupPath;
    state.selectedGroupId = "";
    setGroup(group);
    await rememberGroup(group);
    closeGroupDialog();
    setStatus("createGroupDone");
  });
}

async function chooseGroupFolder() {
  await withBusy("chooseGroupFolder", async () => {
    const result = await api("/api/folder-picker");
    if (result?.path) {
      if (result.containsGroup) {
        $("groupPath").value = result.path;
        applyPathToGroupForm(result.path);
        return;
      }
      $("groupsRoot").value = result.path;
      const lastSegment = result.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      if (lastSegment && !$("groupFolderName").value.trim()) $("groupFolderName").value = lastSegment;
      updateGroupPathPreview();
      await saveAppSettings();
      return;
    }
    setStatus("folderPickerUnavailable");
  });
}

function applyPathToGroupForm(groupPath) {
  const { root, groupFolderName } = splitGroupPath(groupPath);
  if ($("groupsRoot")) $("groupsRoot").value = root;
  if ($("groupFolderName")) $("groupFolderName").value = groupFolderName;
}
function splitGroupPath(groupPath) {
  const normalized = groupPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return { root: ".", groupFolderName: normalized || "demo-group" };
  }
  return {
    root: normalized.slice(0, index),
    groupFolderName: normalized.slice(index + 1) || "demo-group"
  };
}

async function loadGroup() {
  await withBusy("loadGroup", async () => {
    const groupPath = $("groupPath").value.trim();
    if (!groupPath) throw new Error(t("loadGroupError"));
    const group = await api(`/api/group?groupPath=${encodeURIComponent(groupPath)}`);
    setGroup(group);
    await rememberGroup(group);
    closeGroupDialog();
    setStatus("groupLoaded");
  });
}


async function startCouncilRound(question, options = {}) {
  let roundController = null;
  await withBusy(options.control || "sendBossInterjection", async () => {
    const bossText = String(question || "").trim();
    const isContinuation = Boolean(options.continuation);
    const continuationContext = options.continuationContext || (!isContinuation ? state.cycleContinuation : null);
    const isCycleContinuation = Boolean(continuationContext && !isContinuation);
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    if (!bossText) throw new Error(t("emptyBossInput"));
    if (!activeSeats().length) throw new Error(t("emptyCouncil"));
    const skipSeatsThisRound = await confirmUnhealthySeatSkip();
    if (skipSeatsThisRound === null) return;
    if (skipSeatsThisRound.length >= activeSeats().length) {
      appendSystemMessage(t("noAvailableSeatsAfterHealthCheck"));
      setStatus("noAvailableSeatsAfterHealthCheck");
      return;
    }
    if (state.currentRoundController) {
      state.currentRoundController.abort();
    }
    state.roundSequence += 1;
    const sequence = state.roundSequence;
    const controller = new AbortController();
    roundController = controller;
    state.currentRoundController = controller;
    state.currentRoundQuestion = bossText;
    state.currentAgentId = "";
    state.currentAgentName = "";
    if (!isContinuation) {
      $("bossInterjection").value = "";
      if (isCycleContinuation) {
        appendBossMessage(bossText);
        appendSystemMessage(t("continuationNotice", { state: continuationContext.finalState || t("continuePreviousCycle") }));
      } else {
        state.streamMessages = [];
        state.partialMessages = {};
        renderConversation(state.streamMessages);
        appendBossMessage(bossText);
      }
      resetAgentStatuses();
    }
    setRoundState("running");
    setStatus("councilRunning");
    const result = await streamCouncilEvents({
      question: bossText,
      workspaceGroupPath: state.groupPath,
      runtimeGroup: buildRuntimeGroup({ skipSeatsThisRound }),
      maxRounds: state.autonomousRounds,
      globalRequirement: state.globalRequirement,
      continuationContext,
      startAfterAgentId: options.startAfterAgentId || "",
      startAtAgentId: options.startAtAgentId || "",
      resumeInstruction: options.resumeInstruction || ""
    }, { signal: controller.signal });
    if (sequence !== state.roundSequence) return;
    state.pausedAgentId = "";
    state.pausedAgentName = "";
    state.lastSession = result?.session || state.lastSession;
    state.lastFinalAnswer = state.lastSession?.finalDecision?.answer || "";
    state.cycleContinuation = buildCycleContinuationContext(state.lastSession, result);
    updateAgentStatusesFromMessages(state.lastSession?.messages || state.streamMessages);
    renderDecisionPanel(state.lastSession);
    await refreshUsageSummary();
    await refreshFileOperations();
    setRoundState("round_done");
    setStatus("councilFinished");
  }, {
    ignoreAbort: true,
    silent: options.silentBusy,
    onFinally: () => {
      if (state.currentRoundController === roundController) {
        state.currentRoundController = null;
      }
      renderRoundControls();
    }
  });
}

async function createDraft() {
  await withBusy("createDraft", async () => {
    if (!state.groupPath) throw new Error(t("createGroupError"));
    const draft = await api("/api/write-flow/create-draft", {
      groupPath: state.groupPath,
      recorderSeatId: $("recorder").value.trim(),
      reviewerSeatIds: csv($("reviewers").value),
      content: $("draftContent").value
    });
    await refreshDrafts();
    setStatus("draftCreated", draft.draft.id);
  });
}

async function replaceMember() {
  await withBusy("replaceMember", async () => {
    if (!state.groupPath) throw new Error(t("createGroupError"));
    await api("/api/workspace/replace-member", {
      groupPath: state.groupPath,
      seatId: $("replaceSeat").value.trim(),
      nextDisplayName: $("nextName").value.trim(),
      nextModel: $("nextName").value.trim(),
      newPrivateFolder: $("newFolder").checked,
      folderName: $("folderName").value.trim()
    });
    await loadGroup();
    setStatus("memberReplaced");
  });
}

async function saveGlobalRequirement() {
  await withBusy("saveGlobalRequirement", async () => {
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    const value = $("globalRequirement").value.trim();
    const result = await api("/api/group/global-requirement", {
      groupPath: state.groupPath,
      globalRequirement: value
    });
    state.globalRequirement = result.group?.settings?.globalRequirement || "";
    if (state.group) state.group.settings = result.group?.settings || {};
    $("globalRequirement").value = state.globalRequirement;
    setStatus("globalRequirementSaved");
  });
}

async function applyGlobalPermission() {
  await withBusy("applyGlobalPermission", async () => {
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    const tier = $("globalPermissionTier").value;
    await assertPermissionChangeAllowed(tier);
    const seatTiers = {};
    const result = await api("/api/group/permissions", {
      groupPath: state.groupPath,
      defaultTier: tier,
      seatTiers
    });
    state.permissions = result.group?.permissions || { defaultTier: tier, seatTiers };
    if (state.group) state.group.permissions = state.permissions;
    saveJson("ai-council-permissions", state.permissions);
    renderMembers(state.group?.seats || []);
    setStatus("permissionSaved");
  });
}

async function saveSeatPermission(seatId, tier) {
  await assertPermissionChangeAllowed(tier);
  const seatTiers = {
    ...(state.permissions.seatTiers || {}),
    [seatId]: tier
  };
  if (!state.groupPath) {
    state.permissions = { defaultTier: state.permissions.defaultTier || "text", seatTiers };
    saveJson("ai-council-permissions", state.permissions);
    renderMembers(state.group?.seats || []);
    setStatus("permissionSaved");
    return;
  }
  const result = await api("/api/group/permissions", {
    groupPath: state.groupPath,
    defaultTier: state.permissions.defaultTier || "text",
    seatTiers
  });
  state.permissions = result.group?.permissions || { defaultTier: state.permissions.defaultTier || "text", seatTiers };
  if (state.group) state.group.permissions = state.permissions;
  saveJson("ai-council-permissions", state.permissions);
  renderMembers(state.group?.seats || []);
  setStatus("permissionSaved");
}

async function assertPermissionChangeAllowed(tier) {
  if (tier === "text") return;
  const git = await api("/api/git/status");
  if (!git.ok) throw new Error(t("gitRequired"));
  if (!window.confirm(t("highRiskPermissionConfirm"))) {
    throw new Error(t("cancel"));
  }
}

async function refreshDrafts() {
  if (!state.groupPath) return;
  const requestId = state.draftRequestId + 1;
  state.draftRequestId = requestId;
  const endpoint = state.draftFilter === "approved"
    ? `/api/approved?groupPath=${encodeURIComponent(state.groupPath)}`
    : `/api/drafts?groupPath=${encodeURIComponent(state.groupPath)}${state.draftFilter ? `&status=${encodeURIComponent(state.draftFilter)}` : ""}`;
  const drafts = await api(endpoint);
  if (requestId !== state.draftRequestId) return;
  const host = $("drafts");
  host.innerHTML = "";
  if (!drafts.length) {
    host.className = "list empty";
    host.textContent = t("noDrafts");
    return;
  }
  host.className = "list";
  for (const draft of drafts) {
    const node = document.createElement("div");
    node.className = "item";
    const reviewer = draft.reviewerSeatIds?.[0] || "";
    node.innerHTML = `
      <strong>${escapeHtml(draft.id)}</strong>
      <div>${escapeHtml(draft.content)}</div>
      <span class="tag">${escapeHtml(draft.status)}</span>
      <div class="actions">
        ${draft.status === "pending_review" ? `<button data-action="review" data-verdict="approve" data-draft="${escapeHtml(draft.id)}" data-reviewer="${escapeHtml(reviewer)}">${escapeHtml(t("approveReview"))}</button>` : ""}
        ${draft.status === "pending_review" ? `<button data-action="review" data-verdict="reject" data-draft="${escapeHtml(draft.id)}" data-reviewer="${escapeHtml(reviewer)}">${escapeHtml(t("rejectReview"))}</button>` : ""}
        ${draft.status === "pending_user_final_approval" ? `<button data-action="finalize" data-draft="${escapeHtml(draft.id)}">${escapeHtml(t("finalize"))}</button>` : ""}
      </div>
    `;
    host.appendChild(node);
  }
}

function handleDraftAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const draftId = button.dataset.draft;
  if (action === "review") {
    withBusy(button, async () => {
      await api("/api/write-flow/add-review", {
        groupPath: state.groupPath,
        draftId,
        reviewerSeatId: button.dataset.reviewer,
        verdict: button.dataset.verdict,
        comment: button.dataset.verdict === "reject"
          ? (state.lang === "zh" ? "\u9700\u8981\u4fee\u6539\u3002" : "Needs changes.")
          : (state.lang === "zh" ? "\u901a\u8fc7\u3002" : "Approved.")
      });
      setStatus(button.dataset.verdict === "reject" ? "reviewRejected" : "reviewSaved");
      await refreshDrafts();
    }).catch(() => {});
  }
  if (action === "finalize") {
    withBusy(button, async () => {
      await api("/api/write-flow/finalize", {
        groupPath: state.groupPath,
        draftId,
        approvedBy: "user"
      });
      setStatus("draftFinalized");
      await refreshDrafts();
    }).catch(() => {});
  }
}

async function createDraftFromFinal() {
  if (!state.lastFinalAnswer) {
    setStatus("noFinal");
    return;
  }
  await withBusy("createFromFinal", async () => {
    const draft = await api("/api/write-flow/create-draft", {
      groupPath: state.groupPath,
      recorderSeatId: $("recorder").value.trim(),
      reviewerSeatIds: csv($("reviewers").value),
      content: state.lastFinalAnswer
    });
    await refreshDrafts();
    setStatus("draftCreated", draft.draft.id);
  });
}

function setDraftFilter(filter) {
  state.draftFilter = filter;
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", (button.dataset.filter || "") === filter);
  });
  refreshDrafts();
}

function setGroup(group) {
  state.group = group;
  state.groupPath = group.groupPath;
  loadGroupScopedState(group);
  state.globalRequirement = group.settings?.globalRequirement || "";
  $("globalRequirement").value = state.globalRequirement;
  state.permissions = {
    defaultTier: group.permissions?.defaultTier || "text",
    seatTiers: group.permissions?.seatTiers || {}
  };
  saveJson("ai-council-permissions", state.permissions);
  $("globalPermissionTier").value = state.permissions.defaultTier;
  state.agentStatuses = {};
  state.seatHealthStatuses = {};
  state.seatHealthChecking = false;
  state.currentRoundQuestion = "";
  state.lastSession = null;
  state.lastFinalAnswer = "";
  state.cycleContinuation = null;
  $("groupName").textContent = group.groupFolderName;
  $("decisionPanel").className = "decision-panel empty";
  $("decisionPanel").innerHTML = "";
  $("standardsPanel").className = "standards-panel empty";
  $("standardsPanel").textContent = t("noStandards");
  applyConversationMode();
  applyOwner();
  renderDecisionHistory();
  applyWindowLayout();
  renderMembers(group.seats);
  refreshDrafts();
  refreshExecutionStandards().catch(() => {});
  refreshUsageSummary().catch(() => {});
  refreshFileOperations().catch(() => {});
  setRoundState("waiting_boss");
  checkAllSeatsHealth({ silent: true }).catch(() => {});
}

async function rememberGroup(group) {
  const item = { name: group.groupFolderName, path: group.groupPath };
  const recent = getRecentGroups().filter((entry) => entry.path !== item.path);
  recent.unshift(item);
  localStorage.setItem("ai-council-recent-groups", JSON.stringify(recent.slice(0, 5)));
  localStorage.setItem("ai-council-last-group", item.path);
  renderRecentGroups();
  state.groupIndex = await api("/api/groups-index/upsert", {
    id: state.selectedGroupId || "",
    name: item.name,
    path: item.path,
    lastOpenedAt: new Date().toISOString()
  });
  state.selectedGroupId = state.groupIndex.lastGroupId;
  renderGroupSidebar();
}

function getRecentGroups() {
  return loadJson("ai-council-recent-groups", []);
}

function renderRecentGroups() {
  const host = $("recentGroups");
  const recent = getRecentGroups();
  host.innerHTML = "";
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = t("noRecentGroups");
    host.appendChild(empty);
    return;
  }
  const title = document.createElement("p");
  title.className = "muted";
  title.textContent = t("recentGroups");
  host.appendChild(title);
  for (const group of recent) {
    const button = document.createElement("button");
    button.className = "recent-item";
    button.dataset.path = group.path;
    button.type = "button";
    button.textContent = group.name;
    host.appendChild(button);
  }
}

function openRecentGroup(event) {
  const button = event.target.closest("button[data-path]");
  if (!button) return;
  $("groupPath").value = button.dataset.path;
  loadGroup().catch(() => {});
}

async function loadLastGroup() {
  const indexed = state.groupIndex.groups.find((group) => group.id === state.groupIndex.lastGroupId);
  const last = indexed?.path || localStorage.getItem("ai-council-last-group");
  if (last) {
    $("groupPath").value = last;
    applyPathToGroupForm(last);
  }
}

async function refreshGroupIndex() {
  state.groupIndex = await api("/api/groups-index");
  state.selectedGroupId = state.groupIndex.lastGroupId || "";
  renderGroupSidebar();
}

function renderGroupSidebar() {
  const query = state.groupSearch.trim().toLowerCase();
  const groups = (state.groupIndex.groups || []).filter((group) => {
    if (!query) return true;
    return `${group.name} ${group.path}`.toLowerCase().includes(query);
  });
  renderGroupList($("pinnedGroups"), groups.filter((group) => group.pinned));
  renderGroupList($("sidebarGroups"), groups.filter((group) => !group.pinned));
}

function renderGroupList(host, groups) {
  host.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = t("noRecentGroups");
    host.appendChild(empty);
    return;
  }
  for (const group of groups) {
    const button = document.createElement("button");
    button.className = `group-row${group.id === state.selectedGroupId ? " is-active" : ""}`;
    button.type = "button";
    button.dataset.groupId = group.id;
    button.dataset.path = group.path;
    button.innerHTML = `
      <span class="pin">${group.pinned ? "\u25cf" : ""}</span>
      <strong>${escapeHtml(group.name)}</strong>
      <time>${escapeHtml(relativeTime(group.lastOpenedAt || group.updatedAt))}</time>
    `;
    host.appendChild(button);
  }
}

function updateGroupSearch() {
  state.groupSearch = $("groupSearch").value;
  renderGroupSidebar();
}

function openSidebarGroup(event) {
  const button = event.target.closest("button[data-group-id]");
  if (!button) return;
  state.selectedGroupId = button.dataset.groupId;
  $("groupPath").value = button.dataset.path;
  loadGroup().catch(() => {});
}

function openGroupContextMenu(event) {
  const button = event.target.closest("button[data-group-id]");
  if (!button) return;
  event.preventDefault();
  state.selectedGroupId = button.dataset.groupId;
  const group = findIndexedGroup(state.selectedGroupId);
  const pinButton = $("groupMenu").querySelector('[data-group-action="pin"]');
  pinButton.textContent = t(group?.pinned ? "unpinGroup" : "pinGroup");
  $("groupMenu").style.left = `${event.clientX}px`;
  $("groupMenu").style.top = `${event.clientY}px`;
  $("groupMenu").hidden = false;
}

async function handleGroupMenuAction(event) {
  const button = event.target.closest("button[data-group-action]");
  if (!button || !state.selectedGroupId) return;
  const group = findIndexedGroup(state.selectedGroupId);
  if (!group) return;
  const action = button.dataset.groupAction;
  $("groupMenu").hidden = true;
  if (action === "open") {
    $("groupPath").value = group.path;
    await loadGroup();
    return;
  }
  if (action === "pin") {
    state.groupIndex = await api("/api/groups-index/update", {
      id: group.id,
      pinned: !group.pinned
    });
  }
  if (action === "rename") {
    const name = window.prompt(t("renameGroupPrompt"), group.name);
    if (!name) return;
    state.groupIndex = await api("/api/groups-index/update", {
      id: group.id,
      name
    });
  }
  if (action === "removeRecord") {
    state.groupIndex = await api("/api/groups-index/remove", { id: group.id });
    if (state.selectedGroupId === group.id) state.selectedGroupId = state.groupIndex.lastGroupId || "";
    setStatus("groupRecordRemoved");
  }
  renderGroupSidebar();
}

function findIndexedGroup(groupId) {
  return state.groupIndex.groups.find((group) => group.id === groupId);
}

function relativeTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return t("ready");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function setRoundState(nextState) {
  state.roundState = nextState;
  document.body.dataset.roundState = nextState;
  renderRoundControls();
}

function renderRoundControls() {
  const hasGroup = Boolean(state.groupPath);
  const hasAgents = activeSeats().length > 0;
  const isRunning = state.roundState === "running";
  const isPaused = state.roundState === "paused";
  const isBusy = state.busyCount > 0;
  const canStart = hasGroup && hasAgents && !isRunning;
  const canCheckSeats = hasGroup && hasAgents && !state.seatHealthChecking;
  $("pauseCouncil").textContent = isPaused ? t("resumeDiscussion") : t("pauseDiscussion");
  $("pauseCouncil").classList.toggle("is-paused", isPaused);
  $("pauseCouncil").disabled = !(isRunning || isPaused);
  $("stopCouncil").disabled = !(isRunning || isPaused);
  $("checkAllSeats").disabled = !canCheckSeats;
  $("checkAllSeats").textContent = state.seatHealthChecking ? t("checkingSeats") : t("checkAllSeats");
  $("sendBossInterjection").disabled = !hasGroup || !hasAgents || (isBusy && !isRunning && !isPaused);
  $("bossInterjection").placeholder = isRunning
    ? t("bossInterjection")
    : state.cycleContinuation ? t("continuationPlaceholder") : t("bossInput");
}

function renderMembers(seats) {
  const host = $("membersList");
  host.innerHTML = "";
  host.className = "seat-ring";
  const normalized = normalizeSeats(seats);
  normalized.forEach((seat, index) => {
    const node = seat ? renderFilledSeat(seat, index) : renderEmptySeat(index);
    host.appendChild(node);
  });
  renderRoundControls();
}

function normalizeSeats(seats = []) {
  const byPosition = new Map();
  seats.slice(0, MAX_AGENT_SEATS).forEach((seat, index) => {
    const seatId = seat.seatId || seat.id || seatIdForIndex(index);
    const normalizedSeat = { ...seat, seatId };
    if (state.seatOverrides[seatId]?.kicked) return;
    byPosition.set(index, normalizedSeat);
  });
  Object.values(state.customSeats).forEach((seat) => {
    const index = seatIndexFromId(seat.seatId);
    if (index < 0 || index >= MAX_AGENT_SEATS) return;
    if (state.seatOverrides[seat.seatId]?.kicked) return;
    byPosition.set(index, seat);
  });
  return Array.from({ length: MAX_AGENT_SEATS }, (_, index) => byPosition.get(index) || null);
}

function activeSeats() {
  return normalizeSeats(state.group?.seats || []).filter(Boolean);
}

function seatIdForIndex(index) {
  return `seat_${String(index + 1).padStart(2, "0")}`;
}

function seatIndexFromId(seatId) {
  const match = String(seatId || "").match(/seat_(\d+)/);
  return match ? Number(match[1]) - 1 : -1;
}

function renderFilledSeat(seat, index) {
  const role = seat.role || seat.team || t("roleFallback");
  const status = state.agentStatuses[seat.seatId] || state.agentStatuses[seat.displayName] || "idle";
  const contextStatus = getSeatContextStatus(seat);
  const contextClass = contextStatusClass(contextStatus);
  const healthStatus = getSeatHealthStatus(seat.seatId);
  const statusTitle = [seatStatusTitle(status, healthStatus), contextStatusTitle(contextStatus)].filter(Boolean).join(" | ");
  const override = state.seatOverrides[seat.seatId] || {};
  const muted = state.mutedSeats[seat.seatId];
  const reviewer = Boolean(override.reviewer ?? seat.reviewer);
  const displayName = override.roleName || seat.displayName;
  const permissionTier = effectivePermissionTier(seat.seatId);
  const node = document.createElement("div");
  node.className = `seat pos-${index + 1} status-${status}${contextClass ? ` ${contextClass}` : ""}${seat.isCustom ? " is-custom-seat" : ""}${reviewer ? " is-red-team" : ""}${muted === "round" ? " is-muted-round" : ""}${muted === "forever" ? " is-muted-forever" : ""}`;
  node.dataset.seatId = seat.seatId;
  node.innerHTML = `
    <button class="seat-avatar" type="button" title="${escapeHtml(displayName)}">
      <span class="seat-number">${index + 1}</span>
      ${avatarMarkup(displayName, override.avatar)}
      <span class="permission-badge" title="${escapeHtml(t("permissionTier"))}: ${escapeHtml(permissionTierLabel(permissionTier))}">${escapeHtml(permissionTierNumber(permissionTier))}</span>
      <span class="agent-status" title="${escapeHtml(statusTitle)}">${statusMarkup(status, healthStatus)}</span>
    </button>
    <button class="private-chat-button" type="button" data-private-seat="${escapeHtml(seat.seatId)}" title="${escapeHtml(t("privateChatButton"))}" aria-label="${escapeHtml(t("privateChatButton"))}"></button>
    <div class="seat-nameplate">
      <strong>${escapeHtml(displayName)}</strong>
      <span>${escapeHtml(role)}</span>
    </div>
  `;
  return node;
}

function renderEmptySeat(index) {
  const node = document.createElement("div");
  node.className = `seat empty-seat pos-${index + 1}`;
  node.dataset.emptyIndex = String(index);
  node.innerHTML = `
    <button class="empty-avatar" type="button" title="${escapeHtml(t("clickToAdd"))}">
      <span class="seat-number">${index + 1}</span>
      <span class="avatar-initial">+</span>
    </button>
  `;
  return node;
}

function handleSeatClick(event) {
  const privateButton = event.target.closest("[data-private-seat]");
  if (privateButton) {
    event.stopPropagation();
    openPrivateDialog(privateButton.dataset.privateSeat);
    return;
  }
  const seat = event.target.closest(".seat");
  if (!seat) return;
  const seatId = seat.dataset.seatId || seatIdForIndex(Number(seat.dataset.emptyIndex || 0));
  openSeatDialog(seatId);
}

function openPrivateDialog(seatId) {
  const seat = findSeat(seatId);
  if (!seat) return;
  const name = seat.displayName || seatId;
  $("privateSeatId").value = seatId;
  $("privateChatTitle").textContent = `${t("privateChat")}: ${name}`;
  $("privateInstruction").value = "";
  renderPrivateChatLog(seatId);
  $("privateDialog").showModal();
  refreshPrivateChat(seatId).catch(() => {});
}

function renderPrivateChatLog(seatId) {
  const host = $("privateChatLog");
  const messages = state.privateChats[seatId] || [];
  host.innerHTML = "";
  if (!messages.length) {
    host.className = "private-chat-log empty";
    host.textContent = t("noPrivateMessages");
    return;
  }
  host.className = "private-chat-log";
  for (const item of messages) {
    const node = document.createElement("div");
    const isBoss = item.from === "boss" || !item.from;
    node.className = isBoss ? "private-chat-item boss" : "private-chat-item member";
    const who = isBoss ? t("ownerSaid") : (item.seatName || t("memberSaid"));
    node.innerHTML = `<strong>${escapeHtml(item.time || formatTime(item.createdAt))} ${escapeHtml(who)}:</strong><p>${escapeHtml(item.text)}</p>`;
    host.appendChild(node);
  }
}

async function sendPrivateInstruction() {
  const seatId = $("privateSeatId").value;
  const seat = findSeat(seatId);
  const text = $("privateInstruction").value.trim();
  if (!seat || !text) return;
  if (!state.groupPath) throw new Error(t("loadGroupError"));
  const result = await api("/api/private-chat", {
    groupPath: state.groupPath,
    seatId,
    seat: publicSeatPayload(seat),
    text,
    from: "boss",
    runtimeGroup: buildRuntimeGroup()
  });
  $("privateInstruction").value = "";
  await refreshPrivateChat(seatId);
  appendSystemMessage(t("privateSent", { name: seat.displayName || seatId }));
  setStatusText(t("privateSent", { name: seat.displayName || seatId }));
}

async function refreshPrivateChat(seatId) {
  if (!state.groupPath || !seatId) return;
  const seat = findSeat(seatId);
  const seatQuery = seat ? "&seat=" + encodeURIComponent(JSON.stringify(publicSeatPayload(seat))) : "";
  const result = await api("/api/private-chat?groupPath=" + encodeURIComponent(state.groupPath) + "&seatId=" + encodeURIComponent(seatId) + seatQuery);
  state.privateChats[seatId] = (result.messages || []).map(normalizePrivateMessage);
  saveScopedJson("private-chats", state.privateChats);
  renderPrivateChatLog(seatId);
}

function publicSeatPayload(seat = {}) {
  return {
    seatId: seat.seatId || seat.id || "",
    id: seat.id || seat.seatId || "",
    displayName: seat.displayName || "",
    role: seat.role || "",
    model: seat.model || seat.currentModel || ""
  };
}

function normalizePrivateMessage(message = {}) {
  return {
    id: message.id || "",
    from: message.from || "boss",
    seatName: message.seatName || "",
    time: message.time || formatTime(message.createdAt),
    createdAt: message.createdAt || "",
    text: message.text || ""
  };
}

function formatTime(value) {
  if (!value) return new Date().toLocaleString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function openSeatDialog(seatId) {
  state.selectedSeatId = seatId;
  $("dialogSeatId").value = seatId;
  const override = state.seatOverrides[seatId] || {};
  const custom = state.customSeats[seatId] || {};
  const seat = findSeat(seatId) || {};
  $("dialogApiUrl").value = override.apiUrl || custom.apiUrl || seat.apiUrl || "";
  $("dialogApiKey").value = override.apiKey || custom.apiKey || "";
  $("dialogModelName").value = override.model || custom.model || seat.model || "deepseek-chat";
  renderProviderPresetOptions();
  const providerPreset = override.providerPreset || custom.providerPreset || seat.providerPreset || inferProviderPreset($("dialogApiUrl").value);
  if ($("dialogProviderPreset")) $("dialogProviderPreset").value = providerPreset;
  setProviderDetectionStatus("");
  renderDetectedModelOptions([]);
  $("dialogPermissionTier").value = effectivePermissionTier(seatId);
  $("dialogRoleName").value = override.roleName || custom.role || seat.role || seat.displayName || "";
  $("dialogReviewer").checked = Boolean(override.reviewer ?? custom.reviewer ?? seat.reviewer);
  const intensity = Number(override.reviewIntensity || custom.reviewIntensity || 2);
  $("dialogReviewIntensity").value = [1, 2, 3].includes(intensity) ? intensity : 2;
  updateReviewIntensityDisplay();
  $("dialogAvatar").value = "";
  $("seatDialog").showModal();
}

function updateReviewIntensityDisplay() {
  const slider = $("dialogReviewIntensity");
  if (!slider) return;
  const enabled = Boolean($("dialogReviewer")?.checked);
  slider.disabled = !enabled;
  const level = Number(slider.value) || 2;
  const output = $("dialogReviewIntensityValue");
  if (output) output.textContent = String(level);
  const note = $("reviewIntensityNote");
  if (note) {
    const levels = t("reviewIntensityLevels") || {};
    note.textContent = enabled ? (levels[level] || levels[String(level)] || "") : "";
  }
}

function saveSeatConfig() {
  const seatId = $("dialogSeatId").value;
  const roleName = $("dialogRoleName").value.trim();
  const apiUrl = $("dialogApiUrl").value.trim();
  const apiKey = $("dialogApiKey").value.trim();
  const providerPreset = $("dialogProviderPreset").value || inferProviderPreset(apiUrl);
  const model = $("dialogModelName").value.trim() || "deepseek-chat";
  const permissionTier = $("dialogPermissionTier").value;
  const reviewer = Boolean($("dialogReviewer").checked);
  const reviewIntensityRaw = Number($("dialogReviewIntensity").value);
  const reviewIntensity = [1, 2, 3].includes(reviewIntensityRaw) ? reviewIntensityRaw : 2;
  const done = (avatar) => {
    const existing = findSeat(seatId);
    const displayName = roleName || existing?.displayName || seatId;
    state.customSeats[seatId] = {
      ...(state.customSeats[seatId] || {}),
      seatId,
      displayName,
      model,
      role: roleName || existing?.role || t("roleFallback"),
      providerPreset,
      apiUrl,
      apiKey,
      reviewer,
      ...(reviewer ? { reviewIntensity } : {}),
      isCustom: true,
      enabled: true
    };
    state.seatOverrides[seatId] = {
      ...(state.seatOverrides[seatId] || {}),
      kicked: false,
      providerPreset,
      apiUrl,
      apiKey,
      model,
      roleName,
      reviewer,
      ...(reviewer ? { reviewIntensity } : {}),
      ...(avatar ? { avatar } : {})
    };
    delete state.agentStatuses[seatId];
    saveScopedJson("custom-seats", state.customSeats);
    saveScopedJson("seat-overrides", state.seatOverrides);
    saveSeatPermission(seatId, permissionTier)
      .then(() => {
        renderMembers(state.group?.seats || []);
        appendSystemMessage(t("configuredSystem", { name: displayName }));
        $("seatDialog").close();
        checkSeatHealth(findSeat(seatId), { silent: true })
          .then(() => renderMembers(state.group?.seats || []))
          .catch(() => {});
      })
      .catch((error) => {
        $("status").textContent = `${t("errorPrefix")}${error.message}`;
        $("status").dataset.key = "";
      });
  };
  const file = $("dialogAvatar").files?.[0];
  if (file) {
    readFileAsDataUrl(file).then(done);
  } else {
    done();
  }
}

function clearCurrentGroupApiKeys() {
  for (const seat of Object.values(state.customSeats)) {
    delete seat.apiKey;
  }
  for (const override of Object.values(state.seatOverrides)) {
    delete override.apiKey;
  }
  saveScopedJson("custom-seats", state.customSeats);
  saveScopedJson("seat-overrides", state.seatOverrides);
  $("dialogApiKey").value = "";
  setStatus("groupApiKeysCleared");
}

async function loadProviderPresets() {
  const result = await api("/api/providers");
  state.providerPresets = result.providers || [];
  renderProviderPresetOptions();
}

function renderProviderPresetOptions() {
  const select = $("dialogProviderPreset");
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  for (const preset of state.providerPresets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
  if (current) select.value = current;
}

function providerPresetById(id) {
  return state.providerPresets.find((preset) => preset.id === id);
}

function inferProviderPreset(apiUrl) {
  const normalized = String(apiUrl || "").replace(/\/$/, "");
  return state.providerPresets.find((preset) => preset.officialBaseUrl && preset.officialBaseUrl.replace(/\/$/, "") === normalized)?.id || "custom";
}

function handleProviderPresetChange() {
  const preset = providerPresetById($("dialogProviderPreset").value);
  if (preset?.officialBaseUrl && !$("dialogApiUrl").value.trim()) $("dialogApiUrl").value = preset.officialBaseUrl;
  if (preset?.defaultModel && !$("dialogModelName").value.trim()) $("dialogModelName").value = preset.defaultModel;
  setProviderDetectionStatus("");
  renderDetectedModelOptions([]);
}

function useOfficialProviderUrl() {
  const preset = providerPresetById($("dialogProviderPreset").value);
  if (!preset?.officialBaseUrl) return;
  $("dialogApiUrl").value = preset.officialBaseUrl;
  if (preset.defaultModel) $("dialogModelName").value = preset.defaultModel;
  setProviderDetectionStatus("");
  renderDetectedModelOptions([]);
}

async function checkProviderHealth() {
  setProviderDetectionStatus("");
  const result = await api("/api/models/health", providerRequestPayload());
  if (result.ok) {
    setProviderDetectionStatus(t("providerHealthOk", { source: result.source, count: result.modelCount || 0 }));
  } else {
    setProviderDetectionStatus(t("providerHealthFailed", { source: result.source, error: result.error || "" }), true);
  }
}

async function detectProviderModels() {
  setProviderDetectionStatus("");
  const result = await api("/api/models/discover", providerRequestPayload());
  if (result.ok) {
    renderDetectedModelOptions(result.models || [], {
      selected: $("dialogModelName").value.trim() || result.defaultModel || ""
    });
    setProviderDetectionStatus(t("providerDetected", { source: result.source, count: result.models?.length || 0 }));
  } else {
    renderDetectedModelOptions([]);
    setProviderDetectionStatus(t("providerDetectFailed", { source: result.source, error: result.error || "" }), true);
  }
}

function providerRequestPayload() {
  return {
    providerId: $("dialogProviderPreset").value || "custom",
    apiBaseUrl: $("dialogApiUrl").value.trim(),
    apiKey: $("dialogApiKey").value.trim(),
    timeoutMs: 8000
  };
}

function seatProviderRequestPayload(seat) {
  const override = state.seatOverrides[seat.seatId] || {};
  const apiBaseUrl = override.apiUrl || seat.apiUrl || "";
  return {
    providerId: override.providerPreset || seat.providerPreset || inferProviderPreset(apiBaseUrl),
    apiBaseUrl,
    apiKey: override.apiKey || seat.apiKey || "",
    timeoutMs: 8000
  };
}

async function checkSeatHealth(seat, options = {}) {
  if (!seat?.seatId) return null;
  const payload = seatProviderRequestPayload(seat);
  let result;
  if (!payload.apiBaseUrl || !payload.apiKey) {
    result = {
      ok: false,
      source: "local_validation",
      providerId: payload.providerId || "custom",
      apiBaseUrl: payload.apiBaseUrl || "",
      modelCount: 0,
      error: !payload.apiBaseUrl ? "Missing API base URL." : "Missing API key."
    };
  } else {
    result = await api("/api/models/health", payload);
  }
  const health = {
    ok: Boolean(result.ok),
    source: result.source || "unknown",
    error: result.error || "",
    modelCount: Number(result.modelCount || 0),
    checkedAt: Date.now()
  };
  state.seatHealthStatuses[seat.seatId] = health;
  if (!options.silent) renderMembers(state.group?.seats || []);
  return health;
}

async function checkAllSeatsHealth(options = {}) {
  const seats = activeSeats();
  if (!seats.length) return { ok: 0, failed: 0 };
  state.seatHealthChecking = true;
  renderRoundControls();
  if (options.manual) setStatus("checkingSeats");
  try {
    const results = await Promise.all(seats.map(async (seat) => {
      try {
        return { seat, health: await checkSeatHealth(seat, { silent: true }) };
      } catch (error) {
        const health = {
          ok: false,
          source: "error",
          error: error.message,
          modelCount: 0,
          checkedAt: Date.now()
        };
        state.seatHealthStatuses[seat.seatId] = health;
        return { seat, health };
      }
    }));
    renderMembers(state.group?.seats || []);
    const ok = results.filter((item) => item.health?.ok).length;
    const failed = results.length - ok;
    if (options.manual) {
      appendSystemMessage(t("seatHealthSummary", { ok, failed }));
      setStatusText(t("seatHealthSummary", { ok, failed }));
    }
    return { ok, failed };
  } finally {
    state.seatHealthChecking = false;
    renderRoundControls();
  }
}

function renderDetectedModelOptions(models = [], options = {}) {
  const select = $("dialogModelCandidates");
  if (!select) return;
  select.innerHTML = "";
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("noDetectedModels");
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("selectDetectedModel");
  select.appendChild(placeholder);
  for (const model of models) {
    const id = String(model.id || "").trim();
    if (!id) continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = model.owned_by ? `${id} · ${model.owned_by}` : id;
    select.appendChild(option);
  }
  select.disabled = false;
  if (options.selected && Array.from(select.options).some((option) => option.value === options.selected)) {
    select.value = options.selected;
  }
}

function handleDetectedModelChoice() {
  const value = $("dialogModelCandidates").value;
  if (value) $("dialogModelName").value = value;
}

function setProviderDetectionStatus(text, isError = false) {
  const node = $("providerDetectionStatus");
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("error", Boolean(isError));
}

function openSeatMenu(event, seat) {
  state.selectedSeatId = seat.dataset.seatId;
  const menu = $("seatMenu");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.hidden = false;
}

function handleSeatRightPress(event) {
  if (event.button !== 2) return;
  event.preventDefault();
  event.stopPropagation();
  const seat = event.target.closest(".seat[data-seat-id]");
  if (seat) {
    openSeatMenu(event, seat);
    return;
  }
  $("seatMenu").hidden = true;
}

function handleContextMenu(event) {
  event.preventDefault();
  const seat = event.target.closest(".seat[data-seat-id]");
  if (seat) {
    openSeatMenu(event, seat);
    return;
  }
  $("seatMenu").hidden = true;
}

function handleSeatMenuAction(event) {
  const button = event.target.closest("button[data-seat-action]");
  if (!button || !state.selectedSeatId) return;
  const seat = findSeat(state.selectedSeatId);
  const name = seat?.displayName || state.selectedSeatId;
  const action = button.dataset.seatAction;
  if (action === "stopOne") {
    stopSelectedAgent();
    $("seatMenu").hidden = true;
    return;
  }
  if (action === "muteRound") {
    state.mutedSeats[state.selectedSeatId] = "round";
    appendSystemMessage(t("mutedRoundSystem", { name }));
  }
  if (action === "muteForever") {
    state.mutedSeats[state.selectedSeatId] = "forever";
    appendSystemMessage(t("mutedForeverSystem", { name }));
  }
  if (action === "unmute") {
    delete state.mutedSeats[state.selectedSeatId];
    appendSystemMessage(t("unmutedSystem", { name }));
  }
  if (action === "kick") {
    state.seatOverrides[state.selectedSeatId] = { kicked: true };
    delete state.customSeats[state.selectedSeatId];
    delete state.mutedSeats[state.selectedSeatId];
    state.agentStatuses[state.selectedSeatId] = "cancelled";
    appendSystemMessage(t("kickedSystem", { name }));
  }
  if (action === "configure") {
    $("seatMenu").hidden = true;
    openSeatDialog(state.selectedSeatId);
    return;
  }
  if (action === "permission") {
    $("seatMenu").hidden = true;
    openSeatDialog(state.selectedSeatId);
    $("dialogPermissionTier").focus();
    return;
  }
  saveScopedJson("muted-seats", state.mutedSeats);
  saveScopedJson("custom-seats", state.customSeats);
  saveScopedJson("seat-overrides", state.seatOverrides);
  $("seatMenu").hidden = true;
  renderMembers(state.group?.seats || []);
}

function stopSelectedAgent() {
  const seatId = state.selectedSeatId;
  const seat = findSeat(seatId);
  const name = seat?.displayName || state.currentAgentName || seatId;
  if (state.roundState !== "running" || state.currentAgentId !== seatId) {
    setStatus("stopOnlyCurrentAgent");
    return;
  }
  state.currentRoundController?.abort();
  state.currentRoundController = null;
  state.roundSequence += 1;
  state.agentStatuses[seatId] = "cancelled";
  state.agentStatuses[name] = "cancelled";
  appendInterruptedMessage({
    agentId: seatId,
    agentName: name,
    reason: t("stoppedByBoss")
  });
  const hasNext = hasNextActiveSeat(seatId);
  if (hasNext && state.currentRoundQuestion) {
    setRoundState("running");
    setStatus("continuingNextSeat");
    startCouncilRound(state.currentRoundQuestion, {
      control: "sendBossInterjection",
      continuation: true,
      silentBusy: true,
      startAfterAgentId: seatId
    }).catch(() => {});
  } else {
    setRoundState("round_done");
    setStatus("noNextSeat");
  }
  renderMembers(state.group?.seats || []);
  appendSystemMessage(t("agentStopped", { name }));
}

function findSeat(seatId) {
  const normalizedId = String(seatId || "");
  return state.customSeats[normalizedId]
    || activeSeats().find((seat) => seat.seatId === normalizedId || seat.id === normalizedId || seat.displayName === normalizedId)
    || state.group?.seats?.find((seat) => seat.seatId === normalizedId || seat.id === normalizedId || seat.displayName === normalizedId);
}

function buildRuntimeGroup(options = {}) {
  const seats = activeSeats();
  const skipSeatsThisRound = new Set(options.skipSeatsThisRound || []);
  const agents = seats.map((seat) => {
    const override = state.seatOverrides[seat.seatId] || {};
    const configuredProviderPreset = override.providerPreset || seat.providerPreset || inferProviderPreset(override.apiUrl || seat.apiUrl || "");
    const configuredApiBaseUrl = override.apiUrl || seat.apiUrl || "";
    const apiBaseUrl = configuredApiBaseUrl || "mock://local";
    const apiKey = override.apiKey || seat.apiKey || "";
    const role = override.roleName || seat.role || seat.displayName || t("roleFallback");
    const name = override.roleName || seat.displayName || role || seat.seatId;
    const reviewer = Boolean(override.reviewer ?? seat.reviewer);
    const judge = Boolean(override.judge ?? seat.judge);
    const intensityRaw = Number(override.reviewIntensity ?? seat.reviewIntensity);
    const reviewIntensity = [1, 2, 3].includes(intensityRaw) ? intensityRaw : undefined;
    return {
      id: seat.seatId,
      name,
      role,
      team: seat.team || "",
      provider: configuredApiBaseUrl && apiKey ? "openai-compatible" : "mock",
      providerPreset: configuredProviderPreset,
      apiBaseUrl,
      apiKey,
      model: override.model || seat.model || "deepseek-chat",
      weight: Number(seat.weight || 1),
      enabled: !state.mutedSeats[seat.seatId] && !skipSeatsThisRound.has(seat.seatId),
      reviewer,
      mandatoryRedTeam: reviewer,
      judge,
      ...(reviewer && reviewIntensity ? { reviewIntensity } : {})
    };
  });
  return {
    id: state.group?.id || "ui-runtime-council",
    name: state.group?.name || $("groupName").textContent || "UI Runtime Council",
    settings: {
      ...(state.group?.settings || {}),
      allowSoloCouncil: agents.filter((agent) => agent.enabled).length === 1,
      maxRounds: state.autonomousRounds
    },
    agents
  };
}

function hasNextActiveSeat(seatId) {
  const seats = activeSeats();
  const index = seats.findIndex((seat) => seat.seatId === seatId);
  return index >= 0 && index < seats.length - 1;
}

function applyOwner() {
  $("ownerLabel").value = state.owner.label || "";
  const avatar = $("ownerAvatar");
  avatar.innerHTML = avatarMarkup(state.owner.label || t("boss"), state.owner.avatar);
}

function openOwnerDialog() {
  $("ownerDialogName").value = state.owner.label || $("ownerLabel").value.trim() || "";
  $("ownerDialogAvatar").value = "";
  $("ownerDialog").showModal();
}

function saveOwnerConfig() {
  state.owner.label = $("ownerDialogName").value.trim();
  const done = (avatar) => {
    if (avatar) state.owner.avatar = avatar;
    saveScopedJson("owner", state.owner);
    applyOwner();
    $("ownerDialog").close();
  };
  const file = $("ownerDialogAvatar").files?.[0];
  if (file) {
    readFileAsDataUrl(file).then(done);
  } else {
    done();
  }
}

function saveOwnerLabel() {
  state.owner.label = $("ownerLabel").value.trim();
  saveScopedJson("owner", state.owner);
  applyOwner();
}

function togglePause() {
  if (state.roundState === "running") {
    state.pausedAgentId = state.currentAgentId;
    state.pausedAgentName = state.currentAgentName;
    state.currentRoundController?.abort();
    state.currentRoundController = null;
    state.currentAgentId = "";
    state.currentAgentName = "";
    if (state.pausedAgentId) state.agentStatuses[state.pausedAgentId] = "cancelled";
    if (state.pausedAgentName) state.agentStatuses[state.pausedAgentName] = "cancelled";
    if (state.pausedAgentId) {
      appendInterruptedMessage({
        agentId: state.pausedAgentId,
        agentName: state.pausedAgentName,
        reason: t("interruptedByBoss")
      });
    }
    renderMembers(state.group?.seats || []);
    setRoundState("paused");
    appendSystemMessage(t("pause"));
    setStatus("roundPaused");
    return;
  }
  if (state.roundState === "paused") {
    const resumeQuestion = state.currentRoundQuestion || $("bossInterjection").value.trim();
    const agentId = state.pausedAgentId;
    const agentName = state.pausedAgentName || agentId;
    appendSystemMessage(agentName ? t("resumeCurrentAgent", { name: agentName }) : t("resume"));
    startCouncilRound(resumeQuestion, {
      control: "pauseCouncil",
      continuation: true,
      startAtAgentId: agentId,
      resumeInstruction: t("resumeDiscussion")
    }).catch(() => {});
  }
}

function stopAll() {
  if (!["running", "paused"].includes(state.roundState)) return;
  state.currentRoundController?.abort();
  state.currentRoundController = null;
  state.currentAgentId = "";
  state.currentAgentName = "";
  state.pausedAgentId = "";
  state.pausedAgentName = "";
  state.roundSequence += 1;
  setAllAgentStatuses("cancelled");
  setRoundState("idle");
  appendSystemMessage(t("roundStopped"));
  setStatus("roundStopped");
}

function sendBossInterjection() {
  const text = $("bossInterjection").value.trim();
  if (!text) {
    setStatus("emptyBossInput");
    return;
  }
  if (state.roundState === "running" || state.roundState === "paused") {
    state.currentRoundController?.abort();
    state.currentRoundController = null;
    state.currentAgentId = "";
    state.currentAgentName = "";
    state.roundSequence += 1;
    state.cycleContinuation = null;
    appendSystemMessage(t("roundInterjected"));
  }
  startCouncilRound(text, {
    continuationContext: state.cycleContinuation
  }).catch(() => {});
}

async function confirmUnhealthySeatSkip() {
  const unhealthySeats = activeSeats().filter((seat) => getSeatHealthStatus(seat.seatId)?.ok === false);
  if (!unhealthySeats.length) return [];
  const names = unhealthySeats.map((seat) => seat.displayName || seat.seatId).join("、");
  if (!confirm(t("unhealthySeatsWarning", { names }))) return null;
  appendSystemMessage(t("unhealthySeatsSkipped", { names }));
  return unhealthySeats.map((seat) => seat.seatId);
}

function buildCycleContinuationContext(session, result = {}) {
  const final = session?.finalDecision;
  if (!session?.id || !final) return null;
  return {
    previousSessionId: session.id,
    previousQuestion: session.question || "",
    finalState: final.final_state || "",
    finalAnswer: final.answer || "",
    summary: result?.transcriptChunk?.summary || "",
    blockingIssues: final.blocking_issues || [],
    risks: final.unresolved_risks || final.risks || [],
    nextActions: final.next_actions || []
  };
}

function updateAutonomousRounds() {
  state.autonomousRounds = normalizeRoundCount($("autonomousRounds").value);
  $("autonomousRounds").value = String(state.autonomousRounds);
  saveScopedValue("autonomous-rounds", String(state.autonomousRounds));
}

function updateTableZoom() {
  const scale = Number($("tableZoom").value) / 100;
  state.windowLayout.tableScale = scale;
  saveWindowLayout();
  document.documentElement.style.setProperty("--table-scale", String(scale));
}

function handleWindowAction(event) {
  const button = event.currentTarget;
  const target = button.dataset.windowTarget;
  const action = button.dataset.windowAction;
  if (!target || !action) return;
  state.windowLayout[target] = action === "restore" ? "docked" : action;
  saveWindowLayout();
  applyWindowLayout();
}

function applyWindowLayout() {
  const tableMode = state.windowLayout.table || "docked";
  const transcriptMode = state.windowLayout.transcript || "docked";
  $("tableZoom").value = String(Math.round((state.windowLayout.tableScale || 1) * 100));
  $("autonomousRounds").value = String(normalizeRoundCount(state.autonomousRounds));
  document.documentElement.style.setProperty("--table-scale", String(state.windowLayout.tableScale || 1));
  document.documentElement.style.setProperty("--stage-h", `${state.windowLayout.stageHeight || 620}px`);
  const stageWidth = Number(state.windowLayout.stageWidth || 0);
  document.documentElement.style.setProperty("--stage-w", stageWidth > 0 ? `${stageWidth}px` : "100%");
  applyWindowMode(document.querySelector(".table-zone"), tableMode);
  applyWindowMode(document.querySelector(".transcript-section"), transcriptMode);
}

function applyWindowMode(node, mode) {
  node.classList.toggle("is-windowed", mode !== "docked");
  node.classList.toggle("is-popout", mode === "popout");
  node.classList.toggle("is-fullscreen", mode === "fullscreen");
  const target = node.classList.contains("table-zone") ? "table" : "transcript";
  const position = state.windowLayout.positions?.[target];
  if (mode === "popout" && position) {
    node.style.left = `${position.left}px`;
    node.style.top = `${position.top}px`;
    node.style.right = "auto";
  } else {
    node.style.left = "";
    node.style.top = "";
    node.style.right = "";
  }
}

function startWindowDrag(event) {
  const target = event.currentTarget.dataset.windowDrag;
  if (!target || state.windowLayout[target] !== "popout" || event.target.closest("button,input,select,textarea")) return;
  event.preventDefault();
  const node = target === "table" ? document.querySelector(".table-zone") : document.querySelector(".transcript-section");
  const startBox = node.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const pointerId = event.pointerId;
  event.currentTarget.setPointerCapture(pointerId);

  const onMove = (moveEvent) => {
    const maxLeft = Math.max(8, window.innerWidth - startBox.width - 8);
    const maxTop = Math.max(8, window.innerHeight - startBox.height - 8);
    const left = clamp(startBox.left + moveEvent.clientX - startX, 8, maxLeft);
    const top = clamp(startBox.top + moveEvent.clientY - startY, 8, maxTop);
    state.windowLayout.positions = state.windowLayout.positions || {};
    state.windowLayout.positions[target] = { left: Math.round(left), top: Math.round(top) };
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    node.style.right = "auto";
  };

  const onUp = () => {
    event.currentTarget.releasePointerCapture(pointerId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    saveWindowLayout();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function startTableResize(event) {
  event.preventDefault();
  const stage = document.querySelector(".poker-stage");
  const tableZone = document.querySelector(".table-zone");
  const edge = event.currentTarget.dataset.resizeEdge || "corner";
  const startX = event.clientX;
  const startY = event.clientY;
  const startBox = stage.getBoundingClientRect();
  const zoneBox = tableZone.getBoundingClientRect();
  const startWidth = startBox.width;
  const startHeight = startBox.height;
  const startScale = state.windowLayout.tableScale || 1;
  const pointerId = event.pointerId;
  event.currentTarget.setPointerCapture(pointerId);

  const onMove = (moveEvent) => {
    const widthDelta = moveEvent.clientX - startX;
    const heightDelta = moveEvent.clientY - startY;
    const maxWidth = Math.max(700, zoneBox.width);
    const nextWidth = edge === "bottom"
      ? startWidth
      : clamp(startWidth + widthDelta, 700, maxWidth);
    const nextHeight = edge === "right"
      ? startHeight
      : clamp(startHeight + heightDelta, 520, Math.max(620, window.innerHeight - 150));
    const widthScale = nextWidth / 760;
    const heightScale = nextHeight / 620;
    const dragScale = edge === "bottom"
      ? heightScale
      : edge === "right"
        ? widthScale
        : Math.min(widthScale, heightScale);
    const nextScale = clamp(Math.max(0.82, dragScale), 0.82, 1.32);
    state.windowLayout.stageWidth = Math.round(nextWidth);
    state.windowLayout.stageHeight = Math.round(nextHeight);
    state.windowLayout.tableScale = Number(nextScale.toFixed(2));
    document.documentElement.style.setProperty("--stage-w", `${state.windowLayout.stageWidth}px`);
    document.documentElement.style.setProperty("--stage-h", `${state.windowLayout.stageHeight}px`);
    document.documentElement.style.setProperty("--table-scale", String(state.windowLayout.tableScale));
    $("tableZoom").value = String(Math.round(state.windowLayout.tableScale * 100));
  };

  const onUp = () => {
    event.currentTarget.releasePointerCapture(pointerId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    saveWindowLayout();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function saveWindowLayout() {
  saveScopedJson("window-layout", state.windowLayout);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRoundCount(value) {
  const count = Number.parseInt(String(value || 1), 10);
  return clamp(Number.isFinite(count) ? count : 1, 1, 100);
}

function setConversationMode(mode) {
  state.conversationMode = mode;
  saveScopedValue("conversation-mode", mode);
  applyConversationMode();
}

function applyConversationMode() {
  document.body.classList.toggle("mode-side", state.conversationMode === "side");
  $("modeTable").classList.toggle("active", state.conversationMode === "table");
  $("modeSide").classList.toggle("active", state.conversationMode === "side");
  $("conversationModeTag").textContent = t(state.conversationMode === "table" ? "modeTable" : "modeSide");
  if (state.lastSession?.messages) renderConversation(state.lastSession.messages);
}

function setAllAgentStatuses(status) {
  state.agentStatuses = {};
  state.contextStatuses = {};
  for (const seat of activeSeats()) {
    if (state.seatOverrides[seat.seatId]?.kicked) continue;
    state.agentStatuses[seat.seatId] = status;
    state.agentStatuses[seat.displayName] = status;
  }
  renderMembers(state.group?.seats || []);
}

function resetAgentStatuses() {
  state.agentStatuses = {};
  state.contextStatuses = {};
  for (const seat of activeSeats()) {
    state.agentStatuses[seat.seatId] = "idle";
    state.agentStatuses[seat.displayName] = "idle";
  }
  renderMembers(state.group?.seats || []);
}

function updateAgentStatusesFromMessages(messages) {
  const latest = new Map();
  const orderedAgents = [];
  for (const message of messages || []) {
    latest.set(message.agentId, message);
    latest.set(message.agentName, message);
    latest.set(String(message.agentId || "").toLowerCase(), message);
    latest.set(String(message.agentName || "").toLowerCase(), message);
    if (message.agentName && !orderedAgents.includes(message.agentName)) {
      orderedAgents.push(message.agentName);
    }
  }
  activeSeats().forEach((seat, index) => {
    const role = seat.role || seat.team || "";
    const fallbackAgentName = orderedAgents[index];
    const message = latest.get(seat.seatId)
      || latest.get(seat.displayName)
      || latest.get(String(seat.displayName || "").toLowerCase())
      || latest.get(role)
      || latest.get(String(role || "").toLowerCase())
      || latest.get(fallbackAgentName);
    const response = message?.response;
    let status = "idle";
    if (message?.contextStatus) {
      rememberContextStatus(seat.seatId, seat.displayName, message.contextStatus);
    }
    if (state.seatOverrides[seat.seatId]?.kicked) {
      status = "cancelled";
    } else if (response?.error) {
      status = "degraded";
    } else if (response?.unresolved_objections?.length) {
      status = "dissent";
    } else if (response?.status === "skip") {
      status = "done";
    } else if (response) {
      status = "spoke";
    }
    state.agentStatuses[seat.seatId] = status;
    state.agentStatuses[seat.displayName] = status;
  });
  renderMembers(state.group?.seats || []);
}

function statusLabelKey(status) {
  if (status === "working") return "thinking";
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "degraded") return "degraded";
  if (status === "dissent") return "dissent";
  if (status === "spoke") return "spoke";
  return "idle";
}

function seatStatusTitle(status, healthStatus) {
  if (status === "idle" && healthStatus && healthStatus.ok === false) {
    return t("seatHealthFailed", {
      source: healthStatus.source || "unknown",
      error: healthStatus.error || t("usageUnavailable")
    });
  }
  if (status === "idle" && healthStatus && healthStatus.ok === true) {
    return t("seatHealthOk", { source: healthStatus.source || "unknown" });
  }
  return t(statusLabelKey(status));
}

function statusMarkup(status, healthStatus = null) {
  if (status === "working") return '<span class="dots"><i></i><i></i><i></i></span>';
  if (status === "done") return '<span class="checkmark">&#10003;</span>';
  if (status === "cancelled") return '<span class="xmark">&#10005;</span>';
  if (status === "degraded") return '<span class="xmark">&#10005;</span>';
  if (status === "dissent") return '<span class="dissent-dot"></span>';
  if (status === "spoke") return '<span class="checkmark">&#10003;</span>';
  if (healthStatus && healthStatus.ok === false) return '<span class="health-warning">&#9888;</span>';
  return '<span class="idle-dot"></span>';
}

function getSeatHealthStatus(seatId) {
  return state.seatHealthStatuses[String(seatId || "")] || null;
}

function rememberContextStatus(agentId, agentName, contextStatus) {
  if (!contextStatus) return;
  if (agentId) state.contextStatuses[agentId] = contextStatus;
  if (agentName) state.contextStatuses[agentName] = contextStatus;
}

function getSeatContextStatus(seat) {
  return state.contextStatuses[seat.seatId] || state.contextStatuses[seat.displayName] || null;
}

function contextStatusClass(contextStatus) {
  if (!contextStatus) return "";
  if (contextStatus.coreOverflow) return "has-core-overflow";
  if (["warning", "confirm"].includes(contextStatus.budgetStatus)) return "context-warning";
  if (contextStatus.budgetStatus === "pause") return "context-stop";
  const status = contextStatus.sizeStatus || "normal";
  if (!["warning", "compress", "stop"].includes(status)) return "";
  return `context-${status}`;
}

function contextStatusTitle(contextStatus) {
  if (!contextStatus) return "";
  const total = formatTokenCount(contextStatus.totalTokens);
  const limit = formatTokenCount(contextStatus.effectiveInputLimit);
  const core = formatTokenCount(contextStatus.nonCompressibleCoreTokens);
  const base = t("contextUsage", {
    status: t(contextStatusLabelKey(contextStatus)),
    total,
    limit
  });
  if (contextStatus.coreOverflow) {
    return `${base} ${t("coreOverflow", { core, limit })}`;
  }
  if (["warning", "confirm", "pause"].includes(contextStatus.budgetStatus)) {
    return `${base} ${t("budgetUsage", { status: t(budgetStatusLabelKey(contextStatus.budgetStatus)) })}`;
  }
  return base;
}

function contextStatusLabelKey(contextStatus) {
  if (contextStatus.coreOverflow) return "contextOverflow";
  if (contextStatus.sizeStatus === "warning") return "contextWarning";
  if (contextStatus.sizeStatus === "compress") return "contextCompress";
  if (contextStatus.sizeStatus === "stop") return "contextStop";
  return "contextNormal";
}

function budgetStatusLabelKey(status) {
  if (status === "warning") return "budgetWarning";
  if (status === "confirm") return "budgetConfirm";
  if (status === "pause") return "budgetPause";
  return "contextNormal";
}

function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "?";
  return String(Math.round(number));
}

function renderConversation(messages) {
  const side = $("conversation");
  const table = $("tableConversation");
  const shouldStickSide = side.classList.contains("empty") || isNearBottom(side);
  const shouldStickTable = table.classList.contains("empty") || isNearBottom(table);
  side.innerHTML = "";
  table.innerHTML = "";
  if (!messages?.length) {
    side.className = "conversation empty";
    table.className = "table-conversation empty";
    side.textContent = t("noMessages");
    table.textContent = t("noMessages");
    return;
  }
  side.className = "conversation";
  table.className = "table-conversation";
  messages.forEach((message) => {
    side.appendChild(renderSideMessage(message));
    if (state.conversationMode === "table") table.appendChild(renderTableMessage(message));
  });
  if (shouldStickSide) scrollToLatest(side, { force: true });
  if (shouldStickTable) scrollToLatest(table, { force: true });
  if (state.conversationMode === "side") {
    table.className = "table-conversation empty";
    table.textContent = "";
  }
}

function renderSideMessage(message) {
  const response = message.response || {};
  const node = document.createElement("div");
  node.className = `message${response.status === "skip" ? " is-skip" : ""}${response.unresolved_objections?.length ? " has-dissent" : ""}`;
  const avatar = getAvatarForMessage(message);
  node.innerHTML = `
    <div class="message-avatar">${avatarMarkup(message.agentName || message.agentId, avatar)}</div>
    <div class="message-body">
      <strong>${escapeHtml(message.agentName || message.agentId)}<span class="message-round"> / ${escapeHtml(t("round", { round: message.round }))}</span></strong>
      <p>${escapeHtml(message.displayText)}</p>
    </div>
  `;
  return node;
}

function renderTableMessage(message) {
  const avatar = getAvatarForMessage(message);
  const node = document.createElement("div");
  node.className = "table-message";
  node.innerHTML = `
    <div class="mini-avatar">${avatarMarkup(message.agentName || message.agentId, avatar)}</div>
    <div>
      <strong>${escapeHtml(message.agentName || message.agentId)}</strong>
      <p>${escapeHtml(message.displayText)}</p>
    </div>
  `;
  return node;
}

function appendSystemMessage(text) {
  const side = $("conversation");
  const shouldStickSide = isNearBottom(side);
  side.classList.remove("empty");
  if (side.textContent === t("noMessages")) side.textContent = "";
  const message = document.createElement("div");
  message.className = "message is-system";
  message.textContent = text;
  side.appendChild(message);
  if (shouldStickSide) scrollToLatest(side, { force: true });
  const table = $("tableConversation");
  if (state.conversationMode === "side") return;
  const shouldStickTable = isNearBottom(table);
  table.classList.remove("empty");
  if (table.textContent === t("noMessages")) table.textContent = "";
  const tableMessage = document.createElement("div");
  tableMessage.className = "table-message";
  tableMessage.innerHTML = `<div class="mini-avatar">!</div><div><strong>System</strong><p>${escapeHtml(text)}</p></div>`;
  table.appendChild(tableMessage);
  if (shouldStickTable) scrollToLatest(table, { force: true });
}

function appendBossMessage(text) {
  const side = $("conversation");
  const shouldStickSide = isNearBottom(side);
  const sideMessage = document.createElement("div");
  sideMessage.className = "message is-system";
  sideMessage.innerHTML = `<div class="message-body"><strong>${escapeHtml(t("boss"))}</strong><p>${escapeHtml(text)}</p></div>`;
  side.classList.remove("empty");
  if (side.textContent === t("noMessages")) side.textContent = "";
  side.appendChild(sideMessage);
  if (shouldStickSide) scrollToLatest(side, { force: true });

  if (state.conversationMode === "side") return;
  const table = $("tableConversation");
  const shouldStickTable = isNearBottom(table);
  table.classList.remove("empty");
  if (table.textContent === t("noMessages")) table.textContent = "";
  const tableMessage = document.createElement("div");
  tableMessage.className = "table-message";
  tableMessage.innerHTML = `<div class="mini-avatar">${avatarMarkup(state.owner.label || t("boss"), state.owner.avatar)}</div><div><strong>${escapeHtml(t("boss"))}</strong><p>${escapeHtml(text)}</p></div>`;
  table.appendChild(tableMessage);
  if (shouldStickTable) scrollToLatest(table, { force: true });
}

function isNearBottom(node) {
  if (!node || node.classList.contains("empty")) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 96;
}

function scrollToLatest(node, options = {}) {
  if (!node || node.classList.contains("empty")) return;
  if (options.force || isNearBottom(node)) node.scrollTop = node.scrollHeight;
}

function appendInterruptedMessage({ agentId, agentName, reason }) {
  const partial = state.partialMessages[agentId];
  const message = {
    round: partial?.round || state.streamMessages.at(-1)?.round || 1,
    agentId,
    agentName,
    response: { status: "skip", reason },
    displayText: partial?.partialText
      ? `${agentName}\u8bf4\uff1a${partial.partialText} ${reason}`
      : `${agentName}\u8bf4\uff1a${reason}`,
    createdAt: new Date().toISOString(),
    interrupted: true
  };
  delete state.partialMessages[agentId];
  upsertStreamMessage(message);
  renderConversation(state.streamMessages);
}

function renderDecisionPanel(session) {
  const final = session?.finalDecision;
  const host = $("decisionPanel");
  if (!final) {
    host.className = "decision-panel empty";
    host.innerHTML = "";
    return;
  }
  host.className = `decision-panel final-state-${safeFinalStateClass(final.final_state)}`;
  host.innerHTML = `
    ${finalStateBadge(final.final_state)}
    ${decisionIssueCard("blockingIssues", final.blocking_issues)}
    ${decisionCard("finalAnswer", final.answer || "")}
    ${decisionCard("minorityReport", final.minority_report || t("noItems"))}
    ${decisionListCard("risks", final.risks)}
    ${decisionListCard("nextActions", final.next_actions)}
  `;
}

function finalStateBadge(stateValue = "ready_to_execute") {
  const key = finalStateLabelKey(stateValue);
  return `<div class="final-state-badge ${safeFinalStateClass(stateValue)}">${escapeHtml(t(key))}</div>`;
}

function finalStateLabelKey(stateValue) {
  if (stateValue === "usable_with_risks") return "finalStateRisks";
  if (stateValue === "needs_revision") return "finalStateNeedsRevision";
  if (stateValue === "failed_to_converge") return "finalStateFailed";
  return "finalStateReady";
}

function safeFinalStateClass(stateValue) {
  return ["ready_to_execute", "usable_with_risks", "needs_revision", "failed_to_converge"].includes(stateValue)
    ? stateValue
    : "ready_to_execute";
}

function decisionCard(titleKey, text) {
  return `
    <section class="decision-card">
      <h3>${escapeHtml(t(titleKey))}</h3>
      <p>${escapeHtml(text || t("noItems"))}</p>
    </section>
  `;
}

function decisionIssueCard(titleKey, items = []) {
  const list = Array.isArray(items) ? items.filter((item) => item?.issue) : [];
  if (!list.length) return "";
  return `
    <section class="decision-card blocking-card">
      <h3>${escapeHtml(t(titleKey))}</h3>
      <ul>${list.map((item) => `<li><strong>${escapeHtml(item.id || item.severity || "")}</strong> ${escapeHtml(item.issue)}${item.suggested_fix ? `<br><span>${escapeHtml(item.suggested_fix)}</span>` : ""}</li>`).join("")}</ul>
    </section>
  `;
}

function decisionListCard(titleKey, items = []) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const content = list.length
    ? `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(t("noItems"))}</p>`;
  return `
    <section class="decision-card">
      <h3>${escapeHtml(t(titleKey))}</h3>
      ${content}
    </section>
  `;
}

function confirmDecision() {
  if (!state.lastSession?.finalDecision) {
    setStatus("noDecision");
    return;
  }
  const decision = {
    id: `decision-${Date.now()}`,
    createdAt: new Date().toLocaleString(),
    answer: state.lastSession.finalDecision.answer,
    minority: state.lastSession.finalDecision.minority_report
  };
  state.decisionHistory.unshift(decision);
  state.decisionHistory = state.decisionHistory.slice(0, 20);
  saveScopedJson("decision-history", state.decisionHistory);
  renderDecisionHistory();
  setStatus("decisionConfirmed");
}

function renderDecisionHistory() {
  const host = $("decisionHistory");
  host.innerHTML = "";
  if (!state.decisionHistory.length) {
    host.className = "decision-history empty";
    host.textContent = t("noDecisions");
    return;
  }
  host.className = "decision-history";
  for (const decision of state.decisionHistory) {
    const node = document.createElement("div");
    node.className = "decision-history-item";
    node.innerHTML = `
      <strong>${escapeHtml(decision.createdAt)}</strong>
      <p>${escapeHtml(decision.answer || "")}</p>
    `;
    host.appendChild(node);
  }
}

async function api(path, body, options = {}) {
  const requestOptions = body === undefined
    ? {}
    : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
  if (options.signal) requestOptions.signal = options.signal;
  const response = await fetch(path, requestOptions);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function streamCouncilEvents(body, options = {}) {
  const response = await fetch("/api/council/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Request failed");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const event = parseSseChunk(chunk);
      if (!event) continue;
      const nextResult = handleCouncilEvent(event);
      if (nextResult) result = nextResult;
    }
  }
  if (buffer.trim()) {
    const event = parseSseChunk(buffer);
    const nextResult = event ? handleCouncilEvent(event) : null;
    if (nextResult) result = nextResult;
  }
  return result;
}

function parseSseChunk(chunk) {
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return null;
  return JSON.parse(dataLine.slice(6));
}

function handleCouncilEvent(event) {
  if (event.type === "agent_start") {
    state.currentAgentId = event.agentId;
    state.currentAgentName = event.agentName;
    state.agentStatuses[event.agentId] = "working";
    state.agentStatuses[event.agentName] = "working";
    rememberContextStatus(event.agentId, event.agentName, event.contextStatus);
    renderMembers(state.group?.seats || []);
    return null;
  }
  if (event.type === "agent_delta") {
    handleAgentDelta(event);
    return null;
  }
  if (event.type === "agent_message") {
    if (state.currentAgentId === event.message.agentId) {
      state.currentAgentId = "";
      state.currentAgentName = "";
    }
    delete state.partialMessages[event.message.agentId];
    removePartialMessage(event.message.agentId);
    rememberContextStatus(event.message.agentId, event.message.agentName, event.message.contextStatus);
    state.streamMessages.push(event.message);
    updateAgentStatusesFromMessages(state.streamMessages);
    renderConversation(state.streamMessages);
    return null;
  }
  if (event.type === "round_complete") {
    return null;
  }
  if (event.type === "final_decision") {
    state.lastSession = event.session;
    state.lastFinalAnswer = event.finalDecision?.answer || "";
    renderDecisionPanel(event.session);
    return null;
  }
  if (event.type === "done") return event.result;
  if (event.type === "error") throw new Error(event.error || "Stream failed");
  return null;
}

async function refreshFileOperations() {
  if (!state.groupPath) {
    state.fileOperations = { pending: [], audit: [] };
    renderFileOperations();
    return;
  }
  state.fileOperations = await api(`/api/file-operations?groupPath=${encodeURIComponent(state.groupPath)}`);
  renderFileOperations();
}

function renderFileOperations() {
  const host = $("fileOperationsPanel");
  if (!host) return;
  const pending = state.fileOperations?.pending || [];
  const audit = state.fileOperations?.audit || [];
  host.innerHTML = "";
  if (!pending.length && !audit.length) {
    host.className = "file-ops-panel empty";
    host.textContent = t("noFileOperations");
    return;
  }
  host.className = "file-ops-panel";
  for (const proposal of pending) {
    host.appendChild(renderFileOperationCard(proposal));
  }
  if (audit.length) {
    const auditNode = document.createElement("div");
    auditNode.className = "file-op-audit";
    auditNode.innerHTML = `<strong>${escapeHtml(t("fileOperationAudit"))}</strong>`;
    for (const item of audit.slice(0, 5)) {
      const line = document.createElement("p");
      line.textContent = `${item.action || "log"} · ${item.op || ""} ${item.path || ""}`.trim();
      auditNode.appendChild(line);
    }
    host.appendChild(auditNode);
  }
}

function renderFileOperationCard(proposal) {
  const node = document.createElement("article");
  node.className = `file-op-card status-${safeStatusClass(proposal.status)}`;
  const dangerous = proposal.op === "delete" || proposal.dangerousConfirmed;
  node.innerHTML = `
    <div class="file-op-main">
      <strong>${escapeHtml(proposal.op || "op")} ${escapeHtml(proposal.path || "")}</strong>
      <span class="tag">${escapeHtml(proposal.status || "pending")}</span>
    </div>
    <p>${escapeHtml(proposal.reason || proposal.expected_effect || "")}</p>
    ${proposal.preview?.text ? `<pre class="file-op-preview" aria-label="${escapeHtml(t("fileOperationPreview"))}">${escapeHtml(proposal.preview.text)}</pre>` : ""}
    <div class="file-op-meta">
      <span>${escapeHtml(proposal.source_agent_name || proposal.source_agent_id || "AI")}</span>
      ${proposal.commitHash ? `<span>${escapeHtml(t("commitHash"))}: ${escapeHtml(proposal.commitHash)}</span>` : ""}
    </div>
    <div class="actions">
      ${proposal.status === "pending_user_approval" ? `<button data-file-op-action="approve" data-proposal-id="${escapeHtml(proposal.id)}" data-dangerous="${dangerous ? "true" : "false"}">${escapeHtml(t("approveFileOperation"))}</button>` : ""}
      ${proposal.status === "pending_user_approval" ? `<button data-file-op-action="auto" data-proposal-id="${escapeHtml(proposal.id)}">${escapeHtml(t("autoApproveFileOperation"))}</button>` : ""}
      ${proposal.status === "approved" ? `<button data-file-op-action="execute" data-proposal-id="${escapeHtml(proposal.id)}" data-dangerous="${dangerous ? "true" : "false"}">${escapeHtml(t("executeFileOperation"))}</button>` : ""}
    </div>
  `;
  return node;
}

function handleFileOperationAction(event) {
  const button = event.target.closest("button[data-file-op-action]");
  if (!button) return;
  const action = button.dataset.fileOpAction;
  const proposalId = button.dataset.proposalId;
  withBusy(button, async () => {
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    if (action === "approve") {
      const dangerousConfirmed = button.dataset.dangerous === "true" && window.confirm(t("fileOperationDangerConfirm"));
      await api("/api/file-operations/approve", { groupPath: state.groupPath, proposalId, approvedBy: "user", dangerousConfirmed });
      setStatus("fileOperationApproved");
    }
    if (action === "auto") {
      if (!window.confirm(t("fileOperationAutoConfirm"))) throw new Error(t("cancel"));
      await api("/api/file-operations/auto-approve", { groupPath: state.groupPath, proposalId, mode: "full", approvedBy: "system:auto-full" });
      setStatus("fileOperationApproved");
    }
    if (action === "execute") {
      const dangerousConfirmed = button.dataset.dangerous === "true" && window.confirm(t("fileOperationDangerConfirm"));
      const result = await api("/api/file-operations/execute", { groupPath: state.groupPath, proposalId, dangerousConfirmed });
      state.fileOperations = state.fileOperations || { pending: [], audit: [] };
      state.fileOperations.pending = (state.fileOperations.pending || []).map((item) => item.id === proposalId ? result : item);
      setStatus("fileOperationExecuted", result.commitHash || "");
    }
    await refreshFileOperations();
  }).catch(() => {});
}

function safeStatusClass(value = "pending") {
  return String(value || "pending").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}
async function refreshExecutionStandards() {
  if (!state.groupPath) return;
  const standards = await api(`/api/execution-standards?groupPath=${encodeURIComponent(state.groupPath)}`);
  renderExecutionStandards(standards);
}

async function refreshUsageSummary() {
  if (!state.groupPath) {
    state.usageSnapshot = null;
    renderUsageSummary();
    return;
  }
  state.usageSnapshot = await api(`/api/usage?groupPath=${encodeURIComponent(state.groupPath)}`);
  renderUsageSummary();
}

function renderUsageSummary() {
  const host = $("usageSummary");
  if (!host) return;
  const totals = state.usageSnapshot?.totals;
  if (!totals || !Number(totals.calls || 0)) {
    host.className = "usage-summary empty";
    host.textContent = t("usageEmpty");
    return;
  }
  host.className = "usage-summary";
  host.innerHTML = `
    <strong>${escapeHtml(t("usageTitle"))}</strong>
    <span>${escapeHtml(t("usageCalls"))}: ${formatCompactNumber(totals.calls)}</span>
    <span>${escapeHtml(t("usageInput"))}: ${formatCompactNumber(totals.estimatedInputTokens)}</span>
    <span>${escapeHtml(t("usageOutput"))}: ${formatCompactNumber(totals.estimatedOutputTokens)}</span>
    <span>${escapeHtml(t("usageUnavailable"))}: ${formatCompactNumber(totals.unavailableCount)}</span>
  `;
}

async function prepareExecutionStandards() {
  await withBusy("prepareStandards", async () => {
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    const finalAnswer = state.lastSession?.finalDecision?.answer || state.lastFinalAnswer || $("draftContent").value.trim();
    if (!finalAnswer) throw new Error(t("noDecision"));
    const standards = await api("/api/execution-standards/prepare", {
      groupPath: state.groupPath,
      finalAnswer,
      objective: finalAnswer.split(/\r?\n/).find(Boolean) || finalAnswer,
      recorderSeatId: $("recorder").value.trim(),
      reviewerSeatIds: csv($("reviewers").value)
    });
    renderExecutionStandards(standards);
    await refreshFileOperations();
    setStatus("standardsReady");
  });
}

async function approveExecutionStandards() {
  await withBusy("approveStandards", async () => {
    if (!state.groupPath) throw new Error(t("loadGroupError"));
    if (!window.confirm(t("approveStandardsConfirm"))) throw new Error(t("cancel"));
    const standards = await api("/api/execution-standards/approve", {
      groupPath: state.groupPath,
      approvedBy: "user"
    });
    renderExecutionStandards(standards);
    await refreshFileOperations();
    setStatus("standardsApproved");
  });
}

function renderExecutionStandards(standards) {
  const host = $("standardsPanel");
  const status = standards?.manifest?.status || "missing";
  if (status === "missing") {
    host.className = "standards-panel empty";
    host.textContent = t("noStandards");
    return;
  }
  const executionPreview = firstPreviewLine(standards.executionStandard);
  const verificationPreview = firstPreviewLine(standards.verificationStandard);
  host.className = `standards-panel ${status === "approved" ? "is-approved" : ""}`;
  host.innerHTML = `
    <div><span class="tag">${escapeHtml(t("standardsStatus"))}: ${escapeHtml(status)}</span></div>
    <p><strong>${escapeHtml(t("executionStandard"))}</strong>: ${escapeHtml(executionPreview)}</p>
    <p><strong>${escapeHtml(t("verificationStandard"))}</strong>: ${escapeHtml(verificationPreview)}</p>
  `;
}

function firstPreviewLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) || "";
}

function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(number));
}

function handleAgentDelta(event) {
  const partial = state.partialMessages[event.agentId] || {
    round: event.round,
    agentId: event.agentId,
    agentName: event.agentName,
    partialText: ""
  };
  partial.partialText += event.delta || "";
  state.partialMessages[event.agentId] = partial;
  const displayText = partial.partialText.trim()
    ? `${event.agentName}\u8bf4\uff1a${partial.partialText} ${t("partialSuffix")}`
    : `${event.agentName}\u8bf4\uff1a${t("thinking")}`;
  upsertStreamMessage({
    round: event.round,
    agentId: event.agentId,
    agentName: event.agentName,
    response: { status: "speak", argument: partial.partialText },
    displayText,
    partial: true,
    createdAt: event.createdAt
  });
  renderConversation(state.streamMessages);
}

function upsertStreamMessage(message) {
  const index = state.streamMessages.findIndex((item) => item.agentId === message.agentId && item.partial);
  if (index >= 0) {
    state.streamMessages[index] = message;
  } else {
    state.streamMessages.push(message);
  }
}

function removePartialMessage(agentId) {
  state.streamMessages = state.streamMessages.filter((message) => !(message.agentId === agentId && message.partial));
}

function setStatus(key, value) {
  const base = t(key);
  $("status").textContent = value ? `${base} ${value}` : base;
  $("status").dataset.key = key;
}

function setStatusText(value) {
  $("status").textContent = value;
  $("status").dataset.key = "";
}

async function withBusy(control, fn, options = {}) {
  const button = typeof control === "string" ? $(control) : control;
  const previous = button?.disabled;
  if (button && !options.silent) {
    button.disabled = true;
    button.dataset.busy = "true";
  }
  if (!options.silent) setGlobalBusy(true);
  try {
    return await fn();
  } catch (error) {
    if (options.ignoreAbort && error?.name === "AbortError") return undefined;
    $("status").textContent = `${t("errorPrefix")}${error.message}`;
    $("status").dataset.key = "";
  } finally {
    options.onFinally?.();
    if (button && !options.silent) {
      button.disabled = previous || false;
      delete button.dataset.busy;
    }
    if (!options.silent) setGlobalBusy(false);
    renderRoundControls();
  }
}

function setGlobalBusy(isBusy) {
  state.busyCount += isBusy ? 1 : -1;
  state.busyCount = Math.max(0, state.busyCount);
  document.body.classList.toggle("is-busy", state.busyCount > 0);
  renderRoundControls();
}

function parseMembers(value) {
  return value.split(",").map((raw, index) => {
    const [namePart, rolePart, teamPart] = raw.split(":").map((part) => part?.trim());
    const displayName = namePart || `member-${index + 1}`;
    return {
      seatId: `seat_${String(index + 1).padStart(2, "0")}`,
      displayName,
      model: displayName,
      role: rolePart || "",
      team: teamPart || ""
    };
  }).filter((member) => member.displayName);
}

function csv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function getAvatarForMessage(message) {
  const seat = activeSeats().find((item) => item.seatId === message.agentId || item.displayName === message.agentName);
  return seat ? state.seatOverrides[seat.seatId]?.avatar : "";
}

function avatarMarkup(name, avatar) {
  if (avatar) return `<img src="${escapeHtml(avatar)}" alt="">`;
  return `<span class="avatar-initial">${escapeHtml(initialFor(name))}</span>`;
}

function initialFor(name) {
  const trimmed = String(name || "?").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadGroupScopedState(group) {
  state.conversationMode = loadScopedValue("conversation-mode", "table", group);
  state.seatOverrides = loadScopedJson("seat-overrides", {}, group);
  state.customSeats = loadScopedJson("custom-seats", {}, group);
  state.owner = loadScopedJson("owner", {}, group);
  state.mutedSeats = loadScopedJson("muted-seats", {}, group);
  state.privateChats = loadScopedJson("private-chats", {}, group);
  state.decisionHistory = loadScopedJson("decision-history", [], group);
  state.autonomousRounds = Number(loadScopedValue("autonomous-rounds", 10, group));
  state.windowLayout = loadScopedJson("window-layout", defaultWindowLayout(), group);
}

function loadScopedJson(name, fallback, group = state.group) {
  const scoped = groupStorageKey(name, group);
  if (localStorage.getItem(scoped) !== null) return loadJson(scoped, fallback);
  return group ? fallback : loadJson(legacyStorageKey(name), fallback);
}

function saveScopedJson(name, value, group = state.group) {
  saveJson(groupStorageKey(name, group), value);
}

function loadScopedValue(name, fallback, group = state.group) {
  return localStorage.getItem(groupStorageKey(name, group))
    ?? (group ? null : localStorage.getItem(legacyStorageKey(name)))
    ?? fallback;
}

function saveScopedValue(name, value, group = state.group) {
  localStorage.setItem(groupStorageKey(name, group), String(value));
}

function groupStorageKey(name, group = state.group) {
  return `ai-council:${groupIdentity(group)}:${name}`;
}

function groupIdentity(group = state.group) {
  const raw = group?.groupPath || group?.id || "global";
  return simpleHash(String(raw).toLowerCase().replaceAll("\\", "/"));
}

function legacyStorageKey(name) {
  return `ai-council-${name}`;
}

function defaultUiLayout() {
  return {
    rightPanelWidth: 420,
    panels: {}
  };
}

function normalizeUiLayout(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultUiLayout();
  return {
    rightPanelWidth: Number.isFinite(Number(value.rightPanelWidth)) ? Number(value.rightPanelWidth) : 420,
    panels: value.panels && typeof value.panels === "object" && !Array.isArray(value.panels) ? value.panels : {}
  };
}

function clampUiDimension(value, min, fallback, max) {
  const safeMax = Math.max(min, max);
  const safeValue = Number.isFinite(value) ? value : fallback;
  return clamp(safeValue, min, safeMax);
}

function defaultWindowLayout() {
  return {
    table: "docked",
    transcript: "docked",
    positions: {},
    stageHeight: 620,
    stageWidth: 0,
    tableScale: 1
  };
}

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
