"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  usage as fallbackUsage,
  type AgentMember,
  type AgentState,
  type Blocker,
  type DecisionState,
  type FileAttachment,
  type FileOperation,
  type Group,
  type TranscriptItem,
  type VisualStyle,
  type WorkMode,
} from "@/lib/council-data"
import {
  addWorkspaceMember,
  api,
  approveFileOperation,
  checkProviderHealth,
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  discoverModels,
  executeFileOperation,
  fetchAppSettings,
  fetchProviderPresets,
  fileOperationsToUi,
  finalDecisionToBlockers,
  finalDecisionToTranscriptItem,
  finalDecisionToUiDecision,
  groupRecordToUiGroup,
  messageToTranscriptItem,
  rejectFileOperation,
  saveAppSettings,
  saveGroupSettings,
  saveSeatConfig,
  streamCouncilEvents,
  updateGroupIndexRecord,
  usageSnapshotDelta,
  usageSnapshotToSummary,
  workspaceGroupToMembers,
  workspaceGroupToRuntimeGroup,
  type CouncilEvent,
  type GroupIndexResponse,
  type ModelDiscoveryResult,
  type ProviderHealthResult,
  type ProviderPresetRecord,
  type AppSettings,
  type UsageSnapshot,
  type WorkspaceGroup,
} from "@/lib/council-live"
import { TopBar } from "./top-bar"
import { GroupsSidebar } from "./groups-sidebar"
import { TranscriptPanel } from "./transcript-panel"
import { Composer } from "./composer"
import { RightPanel } from "./right-panel"
import { MemberConfigSheet } from "./member-config-sheet"
import { SettingsSheet } from "./settings-sheet"
import { ChatHistorySheet } from "./chat-history-sheet"

const LAYOUT_KEY = "ai-council:layout-v3-template"
const CREATE_MEMBER_ID = "__new_member__"
const EMPTY_GROUP: LiveGroup = {
  id: "",
  name: "未选择议会组",
  mode: "collab",
  pinned: false,
  memberCount: 0,
  lastActive: "",
}
const EMPTY_DECISION: {
  state: DecisionState
  confidence: number
  summary: string
} = {
  state: "revise" as const,
  confidence: 0,
  summary: "还没有最终决议。",
}
const EMPTY_TASK = "请输入问题后开始讨论。"

interface Layout {
  visualStyle: VisualStyle
  rightOpen: boolean
}

type LiveGroup = Group & { path?: string; loadError?: string }

function nextDefaultGroupName(groups: LiveGroup[]) {
  const baseName = "新议会组"
  const names = new Set(groups.map((group) => group.name))
  if (!names.has(baseName)) return baseName

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`
    if (!names.has(candidate)) return candidate
  }

  return `${baseName} ${Date.now()}`
}

export function CouncilApp() {
  const [activeGroup, setActiveGroup] = useState("")
  const [mode, setMode] = useState<WorkMode>("collab")
  const [running, setRunning] = useState(false)
  const [visualStyle, setVisualStyle] = useState<VisualStyle>("workbench")
  const [rightOpen, setRightOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [groupList, setGroupList] = useState<LiveGroup[]>([])
  const [workspaceGroup, setWorkspaceGroup] = useState<WorkspaceGroup | null>(null)
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null)
  const [usageBaseline, setUsageBaseline] = useState<UsageSnapshot | null>(null)
  const [fileOperations, setFileOperations] = useState<FileOperation[]>([])
  const [decision, setDecision] = useState(EMPTY_DECISION)
  const [blockers, setBlockers] = useState<Blocker[]>([])
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [currentTask, setCurrentTask] = useState(EMPTY_TASK)
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({})
  const [maxRounds, setMaxRounds] = useState(10)
  const [agentTimeoutMinutes, setAgentTimeoutMinutes] = useState(15)
  const [globalRequirement, setGlobalRequirement] = useState("")
  const [providerOptions, setProviderOptions] = useState<ProviderPresetRecord[]>([])
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [statusText, setStatusText] = useState("正在读取本地小组...")
  const [configMemberId, setConfigMemberId] = useState<string | null>(null)
  const [createMemberDraft, setCreateMemberDraft] = useState<AgentMember | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [mutedSeatIds, setMutedSeatIds] = useState<string[]>([])

  const activeRun = useRef<AbortController | null>(null)
  const partials = useRef<Record<string, string>>({})
  const seenRounds = useRef<Set<number>>(new Set())

  const group: LiveGroup = groupList.find((g) => g.id === activeGroup) ?? EMPTY_GROUP
  const sessionUsageSnapshot = useMemo(
    () => usageSnapshotDelta(usageSnapshot, usageBaseline),
    [usageSnapshot, usageBaseline],
  )
  const usage = sessionUsageSnapshot ? usageSnapshotToSummary(sessionUsageSnapshot) : fallbackUsage
  const members = useMemo(
    () =>
      workspaceGroup
        ? workspaceGroupToMembers(workspaceGroup, agentStates, sessionUsageSnapshot?.members, mutedSeatIds)
        : [],
    [workspaceGroup, agentStates, sessionUsageSnapshot, mutedSeatIds],
  )
  const configuredMember = configMemberId
    ? members.find((member) => member.id === configMemberId)
    : undefined
  const sheetMember = configuredMember ?? createMemberDraft ?? undefined
  const completedRounds = Math.max(
    0,
    ...items
      .filter((item) => item.kind === "round")
      .map((item) => (item.kind === "round" ? item.round : 0)),
  )

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY)
      if (raw) {
        const layout = JSON.parse(raw) as Partial<Layout>
        if (layout.visualStyle) setVisualStyle(layout.visualStyle)
        if (typeof layout.rightOpen === "boolean") setRightOpen(layout.rightOpen)
      }
    } catch {
      // Ignore broken local layout data.
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadInitialGroups() {
      try {
        fetchProviderPresets()
          .then((data) => {
            if (!cancelled) setProviderOptions(data.providers || [])
          })
          .catch(() => {})
        fetchAppSettings()
          .then((settings) => {
            if (!cancelled) setAppSettings(settings)
          })
          .catch(() => {})
        const index = await api<GroupIndexResponse>("/api/groups-index")
        if (cancelled) return
        const records = index.groups || []
        if (!records.length) {
          setGroupList([])
          setActiveGroup("")
          setWorkspaceGroup(null)
          setStatusText("还没有本地小组。点击左上角 + 新建议会组。")
          return
        }
        const nextGroups = records.map(groupRecordToUiGroup)
        setGroupList(nextGroups)
        const selected =
          nextGroups.find((item) => item.id === index.lastGroupId) ||
          nextGroups[0]
        setActiveGroup(selected.id)
        await openGroup(selected, { silent: true })
      } catch (error) {
        if (!cancelled) setStatusText(`读取小组失败：${errorMessage(error)}`)
      }
    }
    loadInitialGroups()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({ visualStyle, rightOpen } satisfies Layout),
      )
    } catch {
      // Ignore localStorage failures.
    }
  }, [visualStyle, rightOpen, hydrated])

  async function openGroup(nextGroup: LiveGroup, options: { silent?: boolean } = {}) {
    setActiveGroup(nextGroup.id)
    if (!nextGroup.path) {
      setWorkspaceGroup(null)
      setStatusText("这个小组没有绑定本地数据。请新建或打开一个本地小组。")
      return
    }
    try {
      const loaded = await api<WorkspaceGroup>(
        `/api/group?groupPath=${encodeURIComponent(nextGroup.path)}`,
      )
      setWorkspaceGroup(loaded)
      setMode(loaded.settings?.workMode === "independent" ? "independent" : "collab")
      setMaxRounds(Number(loaded.settings?.maxRounds || 10))
      setAgentTimeoutMinutes(normalizeTimeoutMinutes(loaded.settings?.agentTimeoutMs))
      setGlobalRequirement(String(loaded.settings?.globalRequirement || ""))
      setCurrentTask("请输入问题后开始讨论。")
      setItems([
        {
          kind: "system",
          id: `loaded-${Date.now()}`,
          time: formatTime(),
          body: `已加载小组：${loaded.groupFolderName || loaded.name || nextGroup.name}`,
        },
      ])
      setDecision({ state: "revise", confidence: 0, summary: "还没有最终决议。" })
      setBlockers([])
      setAgentStates({})
      setMutedSeatIds([])
      setUsageSnapshot(null)
      setUsageBaseline(null)
      setStatusText(options.silent ? "已加载本地小组。" : "小组已切换。")
      const seatCount = (loaded.seats || loaded.agents || []).length
      setGroupList((current) =>
        current.map((item) =>
          item.id === nextGroup.id ? { ...item, memberCount: seatCount } : item,
        ),
      )
      refreshUsageAndFiles(nextGroup.path, { asBaseline: true }).catch(() => {})
    } catch (error) {
      setWorkspaceGroup(null)
      setStatusText(`小组打不开：${errorMessage(error)}`)
      setItems([
        {
          kind: "system",
          id: `group-error-${Date.now()}`,
          time: formatTime(),
          body: `这个小组路径无法读取：${errorMessage(error)}`,
        },
      ])
    }
  }

  async function refreshUsageAndFiles(
    groupPath: string,
    options: { asBaseline?: boolean } = {},
  ) {
    const [usageData, fileData] = await Promise.allSettled([
      api<UsageSnapshot>(`/api/usage?groupPath=${encodeURIComponent(groupPath)}`),
      api<{ pending?: unknown[]; audit?: unknown[] }>(
        `/api/file-operations?groupPath=${encodeURIComponent(groupPath)}`,
      ),
    ])
    if (usageData.status === "fulfilled") {
      if (options.asBaseline) {
        setUsageBaseline(usageData.value)
        setUsageSnapshot(usageData.value)
      } else {
        setUsageSnapshot(usageData.value)
      }
    }
    if (fileData.status === "fulfilled") setFileOperations(fileOperationsToUi(fileData.value))
  }

  async function handleCreateGroup() {
    const name = nextDefaultGroupName(groupList)
    try {
      setStatusText("正在创建小组...")
      const settings = await fetchAppSettings()
      const rootPath = settings.groupsRoot || "./workspace-ui"
      const created = await createWorkspaceGroup({
        root: rootPath,
        groupFolderName: name,
        members: [
          { displayName: "成员 1", model: "mock-builder", role: "builder" },
          { displayName: "审查者", model: "mock-reviewer", role: "reviewer", reviewer: true },
          { displayName: "总结者", model: "mock-judge", role: "judge", judge: true },
        ],
      })
      const index = await api<GroupIndexResponse>("/api/groups-index")
      const nextGroups = (index.groups || []).map(groupRecordToUiGroup)
      setGroupList(nextGroups)
      const selected = nextGroups.find((item) => item.path === created.groupPath) || nextGroups[0]
      if (selected) await openGroup(selected)
      setStatusText("小组已创建。")
    } catch (error) {
      setStatusText(`创建小组失败：${errorMessage(error)}`)
      addSystemItem(`创建小组失败：${errorMessage(error)}`)
    }
  }

  async function handleToggleGroupPin(id: string) {
    const target = groupList.find((item) => item.id === id)
    if (!target) return
    try {
      const index = await updateGroupIndexRecord({ id, pinned: !target.pinned })
      setGroupList((index.groups || []).map(groupRecordToUiGroup))
    } catch (error) {
      addSystemItem(`置顶操作失败：${errorMessage(error)}`)
      setStatusText("置顶操作失败。")
    }
  }

  async function handleDeleteGroup(id: string) {
    const target = groupList.find((item) => item.id === id)
    if (!target) return
    const ok = window.confirm(`删除“${target.name}”会移除这个议会组的全部数据，确认删除？`)
    if (!ok) return
    try {
      setStatusText("正在删除小组...")
      const result = await deleteWorkspaceGroup({ id })
      const nextGroups = (result.index.groups || []).map(groupRecordToUiGroup)
      setGroupList(nextGroups)
      addSystemItem(`已删除小组：${target.name}`)
      if (activeGroup === id) {
        const next = nextGroups.find((item) => item.id === result.index.lastGroupId) || nextGroups[0]
        if (next) {
          await openGroup(next)
        } else {
          setWorkspaceGroup(null)
          setItems([])
          setBlockers([])
          setFileOperations([])
          setDecision(EMPTY_DECISION)
          setCurrentTask(EMPTY_TASK)
          setStatusText("还没有本地小组。")
        }
      } else {
        setStatusText("小组已删除。")
      }
    } catch (error) {
      addSystemItem(`删除小组失败：${errorMessage(error)}`)
      setStatusText("删除小组失败。")
    }
  }

  async function handleSaveSettings(values: {
    mode: WorkMode
    globalRequirement: string
    totalRounds: number
    agentTimeoutMinutes: number
    groupsRoot?: string
    webSearchApiKey?: string
    clearWebSearchKey?: boolean
  }) {
    setMode(values.mode)
    setGlobalRequirement(values.globalRequirement)
    setMaxRounds(values.totalRounds)
    setAgentTimeoutMinutes(values.agentTimeoutMinutes)
    const shouldUpdateWebSearchKey = Boolean(values.webSearchApiKey) || Boolean(values.clearWebSearchKey)
    const shouldUpdateGroupsRoot = values.groupsRoot !== undefined && values.groupsRoot !== (appSettings?.groupsRoot || "")
    if (shouldUpdateWebSearchKey || shouldUpdateGroupsRoot) {
      try {
        const nextSettings = await saveAppSettings({
          ...(shouldUpdateGroupsRoot ? { groupsRoot: values.groupsRoot || "" } : {}),
          capabilities: {
            webSearch: {
              ...(shouldUpdateWebSearchKey ? { apiKey: values.clearWebSearchKey ? "" : values.webSearchApiKey || "" } : {}),
            },
          },
        })
        setAppSettings(nextSettings)
      } catch (error) {
        addSystemItem(`保存联网搜索密钥失败：${errorMessage(error)}`)
        setStatusText("保存联网搜索密钥失败。")
        return
      }
    }
    if (!group.path) {
      addSystemItem("还没有本地小组，暂时不能保存议会设置。")
      return
    }
    try {
      const result = await saveGroupSettings({
        groupPath: group.path,
        globalRequirement: values.globalRequirement,
        maxRounds: values.totalRounds,
        agentTimeoutMs: values.agentTimeoutMinutes * 60_000,
        workMode: values.mode,
      })
      setWorkspaceGroup(result.group)
      addSystemItem("议会设置已保存。")
      setStatusText("议会设置已保存。")
    } catch (error) {
      addSystemItem(`保存设置失败：${errorMessage(error)}`)
      setStatusText("保存设置失败。")
    }
  }

  async function handleSaveMember(values: {
    memberId: string
    name: string
    providerId: string
    baseUrl: string
    model: string
    apiKey?: string
    permission: "text" | "tool" | "full"
    role: "ordinary" | "reviewer" | "summarizer"
    reviewIntensity: 1 | 2 | 3
    reasoningEffort?: string
  }) {
    if (!group.path) {
      addSystemItem("还没有本地小组，暂时不能保存成员配置。")
      return
    }
    try {
      if (values.memberId === CREATE_MEMBER_ID) {
        setStatusText("正在创建成员...")
        const result = await addWorkspaceMember({
          groupPath: group.path,
          displayName: values.name,
          providerPreset: values.providerId,
          apiBaseUrl: values.baseUrl,
          model: values.model,
          apiKey: values.apiKey,
          permission: values.permission,
          role: values.role,
          reviewIntensity: values.reviewIntensity,
          reasoningEffort: values.reasoningEffort,
        })
        setWorkspaceGroup(result.group)
        const seatCount = (result.group.seats || result.group.agents || []).length
        setGroupList((current) =>
          current.map((item) =>
            item.id === group.id ? { ...item, memberCount: seatCount } : item,
          ),
        )
        setCreateMemberDraft(null)
        setConfigMemberId(null)
        addSystemItem(`已添加成员：${result.seat.displayName || values.name}。`)
        setStatusText("成员已添加。")
        return
      }
      const result = await saveSeatConfig({
        groupPath: group.path,
        seatId: values.memberId,
        displayName: values.name,
        providerPreset: values.providerId,
        apiBaseUrl: values.baseUrl,
        model: values.model,
        apiKey: values.apiKey,
        permission: values.permission,
        role: values.role,
        reviewIntensity: values.reviewIntensity,
        reasoningEffort: values.reasoningEffort,
      })
      setWorkspaceGroup(result.group)
      setConfigMemberId(null)
      addSystemItem(`成员 ${values.name} 的配置已保存。`)
      setStatusText("成员配置已保存。")
    } catch (error) {
      addSystemItem(`保存成员配置失败：${errorMessage(error)}`)
      setStatusText("保存成员配置失败。")
    }
  }

  async function handleAddMember() {
    if (!group.path) {
      addSystemItem("还没有本地小组，不能添加成员。请先创建或打开本地小组。")
      return
    }
    setConfigMemberId(null)
    setCreateMemberDraft(buildCreateMemberDraft(members.length + 1, providerOptions))
    setStatusText("请先配置新成员，保存后才会添加到小组。")
  }

  async function handleDiscoverModels(values: {
    providerId: string
    baseUrl: string
    apiKey?: string
  }): Promise<ModelDiscoveryResult> {
    return discoverModels({
      providerId: values.providerId,
      apiBaseUrl: values.baseUrl,
      apiKey: values.apiKey,
      useCache: false,
    })
  }

  async function handleCheckProviderHealth(values: {
    providerId: string
    baseUrl: string
    apiKey?: string
  }): Promise<ProviderHealthResult> {
    return checkProviderHealth({
      providerId: values.providerId,
      apiBaseUrl: values.baseUrl,
      apiKey: values.apiKey,
      useCache: false,
    })
  }

  async function handleFileOperation(action: "approve" | "reject" | "execute", id: string) {
    if (!group.path) return
    try {
      if (action === "approve") {
        await approveFileOperation(group.path, id)
        addSystemItem(`文件提案 ${id} 已批准。`)
      } else if (action === "reject") {
        await rejectFileOperation(group.path, id)
        addSystemItem(`文件提案 ${id} 已拒绝。`)
      } else {
        const ok = window.confirm("执行会写入文件并尝试生成 git commit，确认继续？")
        if (!ok) return
        await executeFileOperation(group.path, id)
        addSystemItem(`文件提案 ${id} 已执行。`)
      }
      await refreshUsageAndFiles(group.path)
    } catch (error) {
      addSystemItem(`文件提案操作失败：${errorMessage(error)}`)
      setStatusText("文件提案操作失败。")
    }
  }

  async function handleSend(
    text: string,
    options: { privateMode: boolean; targetId: string; attachments: FileAttachment[] },
  ) {
    if (options.privateMode) {
      await handlePrivateMessage(text, options.targetId, options.attachments)
      return
    }
    await startCouncil(text, options.attachments)
  }

  async function handlePrivateMessage(text: string, targetId: string, attachments: FileAttachment[] = []) {
    const groupPath = group.path
    if (!groupPath || !workspaceGroup) {
      addSystemItem("请先加载一个本地小组，再私聊成员。")
      return
    }
    const target = members.find((member) => member.id === targetId)
    setItems((current) => [
      ...current,
      {
        kind: "private-hint",
        id: `private-${Date.now()}`,
        agentId: targetId,
        time: formatTime(),
        preview: `你向 ${target?.name || targetId} 发送了一条私聊。`,
      },
    ])
    try {
      const result = await api<{ reply?: { text?: string; createdAt?: string; status?: string } }>("/api/private-chat", {
        groupPath,
        seatId: targetId,
        text,
        attachments,
        runtimeGroup: buildRuntimeGroup(workspaceGroup, maxRounds, [], mode, agentTimeoutMinutes),
      })
      const reply = result.reply
      if (reply?.text) {
        const replyText = reply.text
        setItems((current) => [
          ...current,
          {
            kind: "message",
            id: `private-reply-${Date.now()}`,
            agentId: targetId,
            visibility: "public",
            time: formatTime(reply.createdAt),
            state: reply.status === "error" || replyText.startsWith("（回复失败：")
              ? "unavailable"
              : "completed",
            body: replyText,
          },
        ])
      }
    } catch (error) {
      addSystemItem(`私聊失败：${errorMessage(error)}`)
    }
  }

  async function startCouncil(question: string, attachments: FileAttachment[] = []) {
    const groupPath = group.path
    if (!groupPath || !workspaceGroup) {
      addSystemItem("请先加载一个本地小组，再开始讨论。")
      return
    }
    const activeSeats = (workspaceGroup.seats || workspaceGroup.agents || []).filter(
      (seat, index) => {
        const id = seat.seatId || seat.id || `seat_${String(index + 1).padStart(2, "0")}`
        return seat.enabled !== false && !mutedSeatIds.includes(id)
      },
    )
    if (!activeSeats.length) {
      addSystemItem("这个小组没有启用成员，无法开始讨论。")
      return
    }

    activeRun.current?.abort()
    const controller = new AbortController()
    activeRun.current = controller
    partials.current = {}
    seenRounds.current = new Set()
    setCurrentTask(question)
    setItems([
      {
        kind: "system",
        id: `question-${Date.now()}`,
        time: formatTime(),
        body: attachments.length
          ? `${question}\n附件：${attachments.map((file) => file.name).join("、")}`
          : question,
      },
    ])
    setDecision({ state: "revise", confidence: 0, summary: "讨论进行中，还没有最终决议。" })
    setBlockers([])
    setRunning(true)
    setStatusText("讨论进行中...")
    setAgentStates(
      Object.fromEntries(
        activeSeats.map((seat) => [seat.seatId || seat.id || "", "idle" as AgentState]),
      ),
    )

    try {
      await streamCouncilEvents(
        {
          question,
          workspaceGroupPath: groupPath,
          runtimeGroup: buildRuntimeGroup(workspaceGroup, maxRounds, mutedSeatIds, mode, agentTimeoutMinutes),
          maxRounds,
          globalRequirement,
          attachments,
        },
        handleCouncilEvent,
        controller.signal,
      )
      await refreshUsageAndFiles(groupPath)
      setStatusText("讨论完成。")
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        addSystemItem(`讨论失败：${errorMessage(error)}`)
        setStatusText("讨论失败。")
      }
    } finally {
      if (activeRun.current === controller) activeRun.current = null
      setRunning(false)
    }
  }

  function handleCouncilEvent(event: CouncilEvent) {
    if (event.type === "agent_start" && event.agentId) {
      addRoundItem(event.round || 1)
      setAgentStates((current) => ({ ...current, [event.agentId || ""]: "thinking" }))
      return
    }
    if (event.type === "final_start" && event.agentId) {
      setAgentStates((current) => ({ ...current, [event.agentId || ""]: "thinking" }))
      return
    }
    if (event.type === "agent_delta" && event.agentId) {
      const nextText = `${partials.current[event.agentId] || ""}${event.delta || ""}`
      partials.current[event.agentId] = nextText
      setAgentStates((current) => ({ ...current, [event.agentId || ""]: "speaking" }))
      upsertPartialMessage(event, nextText)
      return
    }
    if (event.type === "agent_message" && event.message) {
      partials.current[event.message.agentId] = ""
      const item = messageToTranscriptItem(event.message, maxRounds)
      setAgentStates((current) => ({
        ...current,
        [event.message?.agentId || ""]: item.kind === "message" ? item.state : "completed",
      }))
      setItems((current) => [
        ...current.filter((entry) => entry.id !== `partial-${event.message?.agentId}`),
        item,
      ])
      return
    }
    if (event.type === "final_decision") {
      setDecision(finalDecisionToUiDecision(event.finalDecision))
      setBlockers(finalDecisionToBlockers(event.finalDecision))
      const item = finalDecisionToTranscriptItem(event)
      if (item) {
        setAgentStates((current) => ({ ...current, [event.agentId || ""]: "completed" }))
        setItems((current) => [...current, item])
      }
      return
    }
    if (event.type === "tool_start" || event.type === "tool_success" || event.type === "tool_failure") {
      addSystemItem(formatToolEvent(event))
      return
    }
    if (event.type === "error") {
      addSystemItem(event.error || "讨论流出错。")
    }
  }

  function addRoundItem(round: number) {
    if (seenRounds.current.has(round)) return
    seenRounds.current.add(round)
    setItems((current) => [
      ...current,
      { kind: "round", id: `round-${round}-${Date.now()}`, round, totalRounds: maxRounds },
    ])
  }

  function upsertPartialMessage(event: CouncilEvent, text: string) {
    const agentId = event.agentId
    if (!agentId) return
    setItems((current) => [
      ...current.filter((entry) => entry.id !== `partial-${agentId}`),
      {
        kind: "message",
        id: `partial-${agentId}`,
        agentId,
        visibility: "public",
        time: formatTime(event.createdAt),
        state: "speaking",
        body: text || "思考中...",
      },
    ])
  }

  function addSystemItem(body: string) {
    setItems((current) => [
      ...current,
      {
        kind: "system",
        id: `system-${Date.now()}-${current.length}`,
        time: formatTime(),
        body,
      },
    ])
  }

  function formatToolEvent(event: CouncilEvent) {
    const actor = event.agentName || "AI"
    const target = event.path || event.query || event.resultSummary?.path || event.resultSummary?.query || ""
    const label = toolLabel(event.tool)
    if (event.type === "tool_start") return `${actor} ${label}${target ? `：${target}` : ""}`
    if (event.type === "tool_success") {
      const summary = event.resultSummary?.entries !== undefined
        ? `${event.resultSummary.entries} 项`
        : event.resultSummary?.results !== undefined
          ? `${event.resultSummary.results} 条`
          : event.resultSummary?.bytes !== undefined
            ? `${event.resultSummary.bytes} 字节`
            : "完成"
      return `${actor} ${label}完成：${summary}`
    }
    return `${actor} ${label}失败：${event.status || "failed"}`
  }

  function toolLabel(tool?: string) {
    if (tool === "read_file") return "读取文件"
    if (tool === "list_directory") return "查看目录"
    if (tool === "search_files") return "搜索文件"
    if (tool === "grep_content") return "搜索正文"
    if (tool === "web_search") return "联网搜索"
    if (tool === "fetch_url") return "读取网页"
    return "使用工具"
  }

  function stopRun() {
    if (running) {
      activeRun.current?.abort()
      setStatusText("已停止当前讨论。")
      setRunning(false)
      return
    }
    addSystemItem("请在底部输入问题后发送。")
  }

  function toggleMuteMember(id: string) {
    setMutedSeatIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )
  }

  async function continueRound() {
    if (running) return
    const previous = currentTask.trim()
    if (!previous || previous === "请输入问题后开始讨论。") {
      addSystemItem("还没有可以继续的问题。请先在底部输入问题。")
      return
    }
    await startCouncil(`继续完善上一轮问题：${previous}`)
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        groupName={group.name}
        mode={mode}
        round={completedRounds}
        totalRounds={maxRounds}
        running={running}
        usage={usage}
        visualStyle={visualStyle}
        rightOpen={rightOpen}
        onToggleRun={stopRun}
        onVisualStyleChange={(nextStyle) => {
          if (nextStyle === "workbench") setVisualStyle("workbench")
        }}
        onToggleRight={() => setRightOpen((open) => !open)}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <GroupsSidebar
          groups={groupList}
          selectedId={activeGroup}
          onSelect={(id) => {
            const nextGroup = groupList.find((item) => item.id === id)
            if (nextGroup) openGroup(nextGroup)
          }}
          onCreateGroup={handleCreateGroup}
          onTogglePin={handleToggleGroupPin}
          onDeleteGroup={handleDeleteGroup}
          onOpenInstructions={() => setSettingsOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TranscriptPanel
              items={items}
              mode={mode}
              members={members}
              currentTask={currentTask}
              running={running}
            />
          </div>
          <Composer
            members={members}
            running={running}
            draftKey={group.path || group.id || ""}
            onSend={handleSend}
            onStop={stopRun}
            onContinue={continueRound}
          />
        </main>

        {rightOpen ? (
          <RightPanel
            members={members}
            blockers={blockers}
            fileOps={fileOperations}
            usage={usage}
            decision={decision}
            statusText={statusText}
            mode={mode}
            onAddMember={handleAddMember}
            onConfigureMember={setConfigMemberId}
            onToggleMuteMember={toggleMuteMember}
            onApproveFileOp={(id) => handleFileOperation("approve", id)}
            onRejectFileOp={(id) => handleFileOperation("reject", id)}
            onExecuteFileOp={(id) => handleFileOperation("execute", id)}
          />
        ) : null}
      </div>

      <MemberConfigSheet
        member={sheetMember}
        creating={!!createMemberDraft}
        workMode={mode}
        providers={providerOptions}
        onSave={handleSaveMember}
        onDiscoverModels={handleDiscoverModels}
        onCheckProviderHealth={handleCheckProviderHealth}
        onClose={() => {
          setConfigMemberId(null)
          setCreateMemberDraft(null)
        }}
      />
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mode={mode}
        onModeChange={setMode}
        globalRequirement={globalRequirement}
        onGlobalRequirementChange={setGlobalRequirement}
        totalRounds={maxRounds}
        onTotalRoundsChange={setMaxRounds}
        agentTimeoutMinutes={agentTimeoutMinutes}
        onAgentTimeoutMinutesChange={setAgentTimeoutMinutes}
        groupsRoot={appSettings?.groupsRoot || ""}
        webSearchConfigured={appSettings?.capabilities?.webSearch?.configured}
        webSearchSource={formatSearchKeySource(appSettings?.capabilities?.webSearch?.source)}
        onSave={handleSaveSettings}
      />
      <ChatHistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        groupPath={group.path || ""}
      />
    </div>
  )
}

function buildRuntimeGroup(
  group: WorkspaceGroup,
  maxRounds: number,
  mutedSeatIds: string[],
  mode: WorkMode,
  agentTimeoutMinutes: number,
) {
  const runtimeGroup = workspaceGroupToRuntimeGroup(group, maxRounds, mutedSeatIds, mode)
  runtimeGroup.settings.agentTimeoutMs = normalizeTimeoutMinutes(agentTimeoutMinutes * 60_000) * 60_000
  return runtimeGroup
}

function normalizeTimeoutMinutes(value: unknown) {
  const raw = Number(value)
  const minutes = raw > 1000 ? Math.round(raw / 60_000) : raw
  if (!Number.isFinite(minutes)) return 15
  return Math.max(1, Math.min(60, Math.round(minutes)))
}

function buildCreateMemberDraft(
  index: number,
  providers: ProviderPresetRecord[],
): AgentMember {
  const preset =
    providers.find((item) => item.id === "deepseek") ??
    providers.find((item) => item.defaultModel || item.models?.length) ??
    providers[0]
  const model = preset?.defaultModel || preset?.models?.[0] || "deepseek-chat"
  return {
    id: CREATE_MEMBER_ID,
    name: `成员 ${index}`,
    role: "ordinary",
    provider: preset?.id || "deepseek",
    model,
    baseUrl: preset?.officialBaseUrl || preset?.baseUrl || "https://api.deepseek.com/v1",
    apiKey: preset?.keyless ? "local" : "unset",
    permission: "text",
    state: "idle",
    reviewer: false,
    reviewIntensity: 2,
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: null,
    healthy: true,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatSearchKeySource(source?: string) {
  if (source === "configured_local") return "本地设置"
  if (source === "configured_env") return "环境变量"
  return "未设置"
}

function formatTime(value?: string) {
  const date = value ? new Date(value) : new Date()
  if (!Number.isFinite(date.getTime())) {
    return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
