"use client"

export { workspaceGroupToRuntimeGroup } from "./runtime-group.mjs"

import type {
  AgentMember,
  AgentState,
  Blocker,
  DecisionState,
  FileOperation,
  FileOpStatus,
  Group,
  FileAttachment,
  Permission,
  Role,
  TranscriptItem,
  UsageSummary,
  WorkMode,
} from "@/lib/council-data"

export interface GroupIndexRecord {
  id: string
  name: string
  path: string
  pinned?: boolean
  lastOpenedAt?: string
}

export interface GroupIndexResponse {
  version?: number
  lastGroupId?: string
  groups?: GroupIndexRecord[]
}

export interface WorkspaceSeat {
  seatId?: string
  id?: string
  displayName?: string
  name?: string
  currentModel?: string
  model?: string
  role?: string
  team?: string
  weight?: number
  enabled?: boolean
  reviewer?: boolean
  mandatoryRedTeam?: boolean
  judge?: boolean
  reviewIntensity?: number
  apiUrl?: string
  apiBaseUrl?: string
  apiKey?: string
  providerPreset?: string
  reasoningEffort?: string
}

export interface WorkspaceGroup {
  id?: string
  name?: string
  groupFolderName?: string
  groupPath?: string
  seats?: WorkspaceSeat[]
  agents?: WorkspaceSeat[]
  settings?: {
    maxRounds?: number
    agentTimeoutMs?: number
    globalRequirement?: string
    [key: string]: unknown
  }
  permissions?: {
    defaultTier?: Permission
    seatTiers?: Record<string, Permission>
  }
}

export interface CouncilEvent {
  type: string
  round?: number
  agentId?: string
  agentName?: string
  tool?: string
  path?: string
  query?: string
  status?: string
  resultSummary?: {
    path?: string
    query?: string
    entries?: number
    results?: number
    bytes?: number
    truncated?: boolean
  }
  delta?: string
  message?: CouncilMessage
  consensus?: unknown
  session?: CouncilSession
  finalDecision?: CouncilFinalDecision
  taskRun?: {
    id?: string
    state?: string
    blockReason?: string
    updatedAt?: string
    execution?: {
      phase?: string
      nextAction?: string
      artifactStatus?: string
    }
  }
  result?: {
    session?: CouncilSession
  }
  error?: string
  createdAt?: string
  durationMs?: number
}

export interface CouncilMessage {
  id?: string
  round?: number
  agentId: string
  agentName: string
  displayText?: string
  response?: {
    status?: string
    argument?: string
    reason?: string
    objections?: unknown[]
    unresolved_objections?: unknown[]
  }
  contextStatus?: {
    totalTokens?: number
  }
  createdAt?: string
  durationMs?: number
  partial?: boolean
  interim?: boolean
  phase?: string
  modelCallIndex?: number
  rawText?: string
}

export interface CouncilFinalDecision {
  final_state?: string
  answer?: string
  confidence?: number
  consensus_score?: number
  risks?: string[]
  unresolved_blockers?: RawBlocker[]
  blocking_issues?: RawBlocker[]
  file_execution_state?: string
  file_execution_results?: unknown[]
  durationMs?: number
}

export interface CouncilSession {
  id?: string
  question?: string
  messages?: CouncilMessage[]
  interimMessages?: CouncilMessage[]
  finalDecision?: CouncilFinalDecision
  createdAt?: string
  completedAt?: string
  durationMs?: number
}

export interface ChatSessionSummary {
  id: string
  question: string
  status?: string
  createdAt: string
  completedAt?: string
  durationMs?: number
  messageCount: number
  rounds: number
  finalState?: string
  answerPreview?: string
}

interface RawBlocker {
  id?: string
  issue?: string
  title?: string
  why?: string
  suggested_fix?: string
  severity?: string
  raisedBy?: string
  source_agent_name?: string
}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { signal }
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(String((data as { error?: string }).error || "请求失败"))
  }
  return data as T
}

export async function streamCouncilEvents(
  body: unknown,
  onEvent: (event: CouncilEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/council/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(String((data as { error?: string }).error || "讨论启动失败"))
  }
  if (!response.body) throw new Error("浏览器不支持流式读取")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split("\n\n")
    buffer = chunks.pop() || ""
    for (const chunk of chunks) {
      const event = parseSseChunk(chunk)
      if (event) onEvent(event)
    }
  }

  if (buffer.trim()) {
    const event = parseSseChunk(buffer)
    if (event) onEvent(event)
  }
}

export function groupRecordToUiGroup(record: GroupIndexRecord): Group & { path: string } {
  return {
    id: record.id,
    name: record.name || "未命名议会组",
    path: record.path,
    mode: "collab",
    pinned: Boolean(record.pinned),
    memberCount: 0,
    lastActive: formatLastActive(record.lastOpenedAt),
  }
}

export function workspaceGroupToMembers(
  group: WorkspaceGroup | null,
  states: Record<string, AgentState>,
  usageMembers: UsageMember[] = [],
  mutedSeatIds: string[] = [],
): AgentMember[] {
  const seats = normalizeSeats(group)
  const permissions = group?.permissions || {}
  const defaultTier = permissions.defaultTier || "text"
  const muted = new Set(mutedSeatIds)
  return seats.map((seat, index) => {
    const id = seat.seatId || seat.id || `seat_${String(index + 1).padStart(2, "0")}`
    const reviewer = Boolean(seat.reviewer || seat.mandatoryRedTeam)
    const judge = Boolean(seat.judge)
    const role: Role = judge ? "summarizer" : reviewer ? "reviewer" : "ordinary"
    const usage = usageMembers.find((item) => item.seatId === id)
    const totals = usage?.totals || {}
    const baseUrl = seat.apiUrl || seat.apiBaseUrl || ""
    const provider = inferProviderName(baseUrl, seat.providerPreset)
    return {
      id,
      name: seat.displayName || seat.name || seat.role || id,
      role,
      provider,
      model: seat.model || seat.currentModel || "未配置模型",
      baseUrl,
      apiKey: seat.apiKey ? "set" : provider === "Mock" ? "local" : "unset",
      permission: permissions.seatTiers?.[id] || defaultTier,
      state: states[id] || "idle",
      reviewer,
      reviewIntensity: normalizeIntensity(seat.reviewIntensity),
      reasoningEffort: seat.reasoningEffort || "",
      tokensIn: Number(totals.estimatedInputTokens || 0),
      tokensOut: Number(totals.estimatedOutputTokens || 0),
      latencyMs: null,
      healthy: states[id] !== "unavailable",
      muted: muted.has(id),
    }
  })
}

export function messageToTranscriptItem(message: CouncilMessage): TranscriptItem {
  return {
    kind: "message",
    id: message.id || `${message.agentId}-${message.round || 0}-${message.createdAt || Date.now()}`,
    agentId: message.agentId,
    visibility: message.response?.unresolved_objections?.length ? "review" : "public",
    time: formatTime(message.createdAt),
    state: responseStatusToAgentState(message.response?.status, Boolean(message.partial)),
    body: cleanDisplayText(message),
    tokens: Number(message.contextStatus?.totalTokens || 0) || undefined,
    durationMs: Number(message.durationMs || 0) || undefined,
  }
}

export function finalDecisionToTranscriptItem(event: CouncilEvent): TranscriptItem | null {
  if (!event.agentId || !event.finalDecision?.answer) return null
  const finalState = event.finalDecision.final_state
  return {
    kind: "message",
    id: `final-${event.agentId}-${event.createdAt || Date.now()}`,
    agentId: event.agentId,
    visibility: "public",
    time: formatTime(event.createdAt),
    state: finalState === "ready_to_execute" || finalState === "usable_with_risks" ? "completed" : "unavailable",
    body: event.finalDecision.answer,
    durationMs: Number(event.durationMs || event.finalDecision.durationMs || 0) || undefined,
  }
}

export function finalDecisionToUiDecision(finalDecision?: CouncilFinalDecision) {
  const state = finalStateToDecisionState(finalDecision?.final_state)
  return {
    state,
    confidence: normalizeConfidence(finalDecision?.confidence ?? finalDecision?.consensus_score),
    summary: finalDecision?.answer || "还没有最终决议。",
  }
}

export function finalDecisionToBlockers(finalDecision?: CouncilFinalDecision): Blocker[] {
  const raw = finalDecision?.unresolved_blockers || finalDecision?.blocking_issues || []
  return raw.map((item, index) => ({
    id: item.id || `blocker-${index + 1}`,
    raisedBy: item.raisedBy || item.source_agent_name || "审查者",
    severity: String(item.severity || "").toLowerCase().includes("block")
      ? "high"
      : "medium",
    title: item.title || item.issue || "未解决问题",
    detail: item.why || item.suggested_fix || item.issue || "",
  }))
}

export interface UsageMember {
  seatId?: string
  totals?: {
    calls?: number
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
    unavailableCount?: number
  }
}

export interface UsageSnapshot {
  totals?: {
    calls?: number
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
    unavailableCount?: number
  }
  members?: UsageMember[]
}

export interface ProviderPresetRecord {
  id: string
  label?: string
  name?: string
  transport?: string
  officialBaseUrl?: string
  baseUrl?: string
  defaultModel?: string
  models?: string[]
  modelsEndpoint?: string
  customUrl?: boolean
  keyless?: boolean
  userDefined?: boolean
}

export interface ModelDiscoveryResult {
  ok: boolean
  source: "real_response" | "timeout_inference" | "cache" | "error" | string
  providerId: string
  apiBaseUrl: string
  models: Array<{ id: string; owned_by?: string }>
  defaultModel?: string
  status?: number
  error?: string
}

export interface ProviderHealthResult {
  ok: boolean
  source: "real_response" | "timeout_inference" | "cache" | "error" | string
  providerId: string
  apiBaseUrl: string
  status?: number
  modelCount?: number
  defaultModel?: string
  error?: string
}

export interface AppSettings {
  groupsRoot?: string
  firstRunComplete?: boolean
  appearance?: {
    theme?: AppearanceTheme
  }
  capabilities?: {
    webSearch?: {
      provider?: string
      configured?: boolean
      storedKeyConfigured?: boolean
      envKeyConfigured?: boolean
      source?: string
    }
    toolAccess?: CapabilityAccess
  }
}

export type AppearanceTheme = "light" | "dark"

export interface CapabilityAccess {
  web?: boolean
  files?: boolean
  automation?: boolean
  browser?: boolean
  database?: boolean
  memory?: boolean
  mcp?: boolean
  skills?: boolean
}

export interface CapabilityRecord {
  id: string
  label: string
  kind: string
  status: string
  enabled?: boolean
  provider?: string
  source?: string
  requirement?: string
  command?: string
  tools?: string[]
  capabilityKey?: keyof CapabilityAccess
  health?: {
    localVerified?: boolean
    externalVerified?: boolean
    checkedAt?: string
    detail?: string
  }
  lifecycle?: {
    status?: string
    source?: string
    lastObservedAt?: string
    lastSucceededAt?: string
    lastError?: string
    lastTool?: string
    useCount?: number
  }
}

export interface McpInstallCatalogItem {
  id: string
  name: string
  manager: string
  packageName: string
  binName: string
  defaultArgs?: string[]
  verifiedSource?: string
  verifiedAt?: string
  installed?: boolean
  packageInstalled?: boolean
  installedVersion?: string
  serverConfigured?: boolean
  serverEnabled?: boolean
  runtimeStatus?: string
}

export interface McpSearchResult {
  id: string
  name: string
  packageName: string
  version?: string
  description?: string
  keywords?: string[]
  date?: string
  score?: number
}

export interface McpServerRecord {
  id: string
  name?: string
  enabled?: boolean
  transport?: string
  command?: string
  args?: string[]
  cwd?: string
  source?: string
  runtime?: string
  install?: {
    manager?: string
    packageName?: string
    packageVersion?: string
    binName?: string
    installedAt?: string
  }
}

export interface SkillPackRecord {
  id: string
  name: string
  description: string
  sourceType: string
  source?: string
  sourceUrl?: string
  repository?: string
  repositoryPath?: string
  revision?: string
  sha256?: string
  bundleSha256?: string
  integrity?: string
  bytes?: number
  bundleBytes?: number
  fileCount?: number
  licenseFile?: string
  installedAt?: string
  enabled?: boolean
}

export interface SkillCatalogRecord extends SkillPackRecord {
  installed: boolean
  installedRecord?: SkillPackRecord
}

export interface SkillSearchResult {
  type: "built_in" | "catalog" | "github_repository_candidate" | string
  id: string
  name: string
  description?: string
  url?: string
  skillUrl?: string
  sourceUrl?: string
  stars?: number
  verifiedSkillFile?: boolean
}

export interface ProjectImportResult {
  root: string
  totalTextFiles: number
  importedFiles: number
  skippedBinary: number
  skippedLarge: number
  skippedDirs: number
  treeTruncated: boolean
  attachments: FileAttachment[]
}

export interface PublicMemoryRecord {
  id: string
  title: string
  content: string
  source: string
  sourceSessionId?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export function usageSnapshotToSummary(snapshot?: UsageSnapshot | null): UsageSummary {
  const totals = snapshot?.totals || {}
  const input = Number(totals.estimatedInputTokens || 0)
  const output = Number(totals.estimatedOutputTokens || 0)
  return {
    tokensTotal: input + output,
    tokensBudget: null,
    tokenAccounting: input + output > 0 ? "estimated" : "unknown",
    costUsd: null,
    costBudgetUsd: null,
    costAccounting: "not_configured",
    apiCalls: Number(totals.calls || 0),
    apiErrors: Number(totals.unavailableCount || 0),
    avgLatencyMs: 0,
  }
}

export function usageSnapshotDelta(
  snapshot?: UsageSnapshot | null,
  baseline?: UsageSnapshot | null,
): UsageSnapshot | null {
  if (!snapshot) return null
  const baselineMembers = new Map(
    (baseline?.members || []).map((member) => [member.seatId || "", member]),
  )
  return {
    totals: subtractUsageTotals(snapshot.totals, baseline?.totals),
    members: (snapshot.members || []).map((member) => ({
      ...member,
      totals: subtractUsageTotals(
        member.totals,
        baselineMembers.get(member.seatId || "")?.totals,
      ),
    })),
  }
}

function subtractUsageTotals(
  current?: UsageSnapshot["totals"],
  baseline?: UsageSnapshot["totals"],
): NonNullable<UsageSnapshot["totals"]> {
  return {
    calls: Math.max(0, Number(current?.calls || 0) - Number(baseline?.calls || 0)),
    estimatedInputTokens: Math.max(
      0,
      Number(current?.estimatedInputTokens || 0) - Number(baseline?.estimatedInputTokens || 0),
    ),
    estimatedOutputTokens: Math.max(
      0,
      Number(current?.estimatedOutputTokens || 0) - Number(baseline?.estimatedOutputTokens || 0),
    ),
    unavailableCount: Math.max(
      0,
      Number(current?.unavailableCount || 0) - Number(baseline?.unavailableCount || 0),
    ),
  }
}

export async function fetchProviderPresets() {
  return api<{ providers: ProviderPresetRecord[] }>("/api/providers")
}

export async function saveCustomProvider(body: {
  id?: string
  label: string
  officialBaseUrl: string
  defaultModel?: string
  modelsEndpoint?: string
}) {
  return api<{ ok: boolean; provider: ProviderPresetRecord }>("/api/providers", body)
}

export async function deleteCustomProvider(id: string) {
  return api<{ ok: boolean; id: string }>("/api/providers/delete", { id })
}

export async function fetchCapabilities(groupPath?: string) {
  const params = groupPath ? new URLSearchParams({ groupPath }) : undefined
  const suffix = params ? `?${params}` : ""
  return api<{ capabilities: CapabilityRecord[]; toolAccess?: CapabilityAccess }>(`/api/capabilities${suffix}`)
}

export async function fetchMcpServers() {
  return api<{ servers: McpServerRecord[] }>("/api/mcp/servers")
}

export async function fetchMcpCatalog() {
  return api<{ catalog: McpInstallCatalogItem[] }>("/api/mcp/catalog")
}

export async function searchMcpPackages(query: string) {
  const params = new URLSearchParams({ q: query })
  return api<{ ok: boolean; error?: string; code?: string; results: McpSearchResult[] }>(`/api/mcp/search?${params}`)
}

export async function installMcpCatalogItem(catalogId: string) {
  return api<{ ok: boolean; error?: string; code?: string }>("/api/mcp/install", { catalogId })
}

export async function installMcpPackage(body: {
  packageSpec: string
  serverId?: string
  name?: string
  binName?: string
}) {
  return api<{ ok: boolean; error?: string; code?: string }>("/api/mcp/install", body)
}

export async function uninstallMcpServer(serverId: string) {
  return api<{ ok: boolean; error?: string; code?: string }>("/api/mcp/uninstall", { serverId })
}

export async function fetchSkills(groupPath: string) {
  return api<{ ok: boolean; skills: SkillPackRecord[]; enabledMissing?: string[] }>(
    `/api/skills?groupPath=${encodeURIComponent(groupPath)}`,
  )
}

export async function fetchSkillCatalog() {
  return api<{ ok: boolean; catalog: SkillCatalogRecord[] }>("/api/skills/catalog")
}

export async function searchSkills(query: string) {
  const params = new URLSearchParams({ q: query })
  return api<{ ok: boolean; error?: string; code?: string; results: SkillSearchResult[] }>(`/api/skills/search?${params}`)
}

export async function installSkill(body: {
  groupPath?: string
  skillId?: string
  skillUrl?: string
  skillMarkdown?: string
  overwrite?: boolean
}) {
  return api<{ ok: boolean; error?: string; code?: string; skill?: SkillPackRecord; enabled?: boolean }>("/api/skills/install", body)
}

export async function setSkillEnabled(groupPath: string, skillId: string, enabled: boolean) {
  return api<{ ok: boolean; error?: string; code?: string }>(enabled ? "/api/skills/enable" : "/api/skills/disable", {
    groupPath,
    skillId,
  })
}

export async function removeSkill(groupPath: string, skillId: string) {
  return api<{ ok: boolean; error?: string; deleted?: boolean }>("/api/skills/remove", {
    groupPath,
    skillId,
  })
}

export async function discoverModels(body: {
  providerId: string
  apiBaseUrl: string
  apiKey?: string
  useCache?: boolean
}) {
  return api<ModelDiscoveryResult>("/api/models/discover", {
    ...body,
    timeoutMs: 8000,
  })
}

export async function checkProviderHealth(body: {
  providerId: string
  apiBaseUrl: string
  apiKey?: string
  useCache?: boolean
}) {
  return api<ProviderHealthResult>("/api/models/health", {
    ...body,
    timeoutMs: 8000,
  })
}

export async function fetchAppSettings() {
  return api<AppSettings>("/api/app-settings")
}

export async function saveAppSettings(body: Partial<AppSettings> & {
  capabilities?: {
    webSearch?: {
      apiKey?: string
    }
    toolAccess?: CapabilityAccess
  }
}) {
  return api<AppSettings>("/api/app-settings", body)
}

export async function importProjectFolder(folderPath: string) {
  return api<ProjectImportResult>("/api/project/import", { folderPath })
}

export async function fetchPublicMemories(groupPath: string) {
  return api<{ memories: PublicMemoryRecord[] }>(
    `/api/public-memory?groupPath=${encodeURIComponent(groupPath)}`,
  )
}

export async function savePublicMemory(groupPath: string, memory: Partial<PublicMemoryRecord>) {
  return api<{ ok: boolean; memory: PublicMemoryRecord }>("/api/public-memory", {
    groupPath,
    memory,
  })
}

export async function deletePublicMemory(groupPath: string, id: string) {
  return api<{ ok: boolean; deleted: boolean; id: string }>("/api/public-memory/delete", {
    groupPath,
    id,
  })
}

export async function fetchChatSessions(groupPath: string) {
  return api<{ sessions: ChatSessionSummary[] }>(
    `/api/sessions?groupPath=${encodeURIComponent(groupPath)}`,
  )
}

export async function fetchChatSession(groupPath: string, sessionId: string) {
  return api<{ session: CouncilSession }>(
    `/api/session?groupPath=${encodeURIComponent(groupPath)}&sessionId=${encodeURIComponent(sessionId)}`,
  )
}

export async function createWorkspaceGroup(body: {
  root: string
  groupFolderName: string
  members: Array<Record<string, unknown>>
}) {
  return api<WorkspaceGroup>("/api/workspace/init", body)
}

export async function updateGroupIndexRecord(body: { id: string; pinned?: boolean }) {
  return api<GroupIndexResponse>("/api/groups-index/update", body)
}

export async function deleteWorkspaceGroup(body: { id: string }) {
  return api<{ ok: boolean; index: GroupIndexResponse; deletedPath?: string }>(
    "/api/groups-index/remove",
    {
      ...body,
      deleteData: true,
    },
  )
}

export async function addWorkspaceMember(body: {
  groupPath: string
  displayName?: string
  providerPreset?: string
  apiBaseUrl?: string
  model?: string
  apiKey?: string
  permission?: Permission
  role?: Role
  reviewIntensity?: 1 | 2 | 3
  reasoningEffort?: string
}) {
  return api<{ ok: boolean; group: WorkspaceGroup; seat: WorkspaceSeat }>(
    "/api/workspace/add-member",
    body,
  )
}

export async function saveGroupSettings(body: {
  groupPath: string
  globalRequirement: string
  maxRounds: number
  workMode: WorkMode
  agentTimeoutMs?: number
}) {
  return api<{ ok: boolean; group: WorkspaceGroup }>("/api/group/settings", body)
}

export async function saveSeatConfig(body: {
  groupPath: string
  seatId: string
  displayName: string
  providerPreset: string
  apiBaseUrl: string
  model: string
  apiKey?: string
  permission: Permission
  role: Role
  reviewIntensity: 1 | 2 | 3
  reasoningEffort?: string
}) {
  return api<{ ok: boolean; group: WorkspaceGroup }>("/api/group/seat", body)
}

export async function reorderSeats(body: {
  groupPath: string
  seatIds: string[]
}) {
  return api<{ ok: boolean; group: WorkspaceGroup }>("/api/group/seats/reorder", body)
}

export async function approveFileOperation(groupPath: string, proposalId: string) {
  return api<unknown>("/api/file-operations/approve", {
    groupPath,
    proposalId,
    approvedBy: "user",
    dangerousConfirmed: true,
  })
}

export async function rejectFileOperation(groupPath: string, proposalId: string) {
  return api<unknown>("/api/file-operations/reject", {
    groupPath,
    proposalId,
    rejectedBy: "user",
  })
}

export async function executeFileOperation(groupPath: string, proposalId: string) {
  return api<unknown>("/api/file-operations/execute", {
    groupPath,
    proposalId,
    dangerousConfirmed: true,
  })
}

export async function restoreFileOperation(groupPath: string, proposalId: string) {
  return api<unknown>("/api/file-operations/restore", {
    groupPath,
    proposalId,
    restoredBy: "user",
    confirmed: true,
  })
}

export function fileOperationsToUi(data?: { pending?: unknown[]; audit?: unknown[] } | null): FileOperation[] {
  const pending = data?.pending || []
  const audit = data?.audit || []
  const pendingIds = new Set(pending.map((raw) => ((raw || {}) as RawFileOperation).id).filter(Boolean))
  const seenAuditIds = new Set<string>()
  const terminalAudit = audit.filter((raw) => {
    const item = (raw || {}) as RawFileOperation
    if (!item.id || pendingIds.has(item.id) || seenAuditIds.has(item.id)) return false
    const status = terminalAuditFileOpStatus(item.status, item.action)
    if (!status) return false
    seenAuditIds.add(item.id)
    return true
  })

  return [
    ...pending.map((raw, index) => fileOperationToUi(raw, index, false)).filter(Boolean),
    ...terminalAudit.map((raw, index) => fileOperationToUi(raw, pending.length + index, true)).filter(Boolean),
  ].slice(0, 8) as FileOperation[]
}

interface RawFileOperation {
  id?: string
  path?: string
  op?: string
  action?: string
  status?: string
  source_agent_name?: string
  source_agent_id?: string
  agentName?: string
  commitHash?: string
  commit?: string
  recovery?: {
    backupId?: string
    status?: string
    sha256?: string
    sizeBytes?: number
  }
}

function parseSseChunk(chunk: string): CouncilEvent | null {
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
  if (!dataLines.length) return null
  return JSON.parse(dataLines.join("\n")) as CouncilEvent
}

function normalizeSeats(group: WorkspaceGroup | null): WorkspaceSeat[] {
  return (group?.seats || group?.agents || []).filter(Boolean)
}

function responseStatusToAgentState(status?: string, partial = false): AgentState {
  if (partial) return "speaking"
  if (status === "skip") return "skipped"
  if (status === "unavailable" || status === "error") return "unavailable"
  if (status) return "completed"
  return "idle"
}

function cleanDisplayText(message: CouncilMessage): string {
  const body = message.response?.argument || message.displayText || message.response?.reason || ""
  return String(body || "").replace(/^[^：:]{1,40}[：:]\s*/, "").trim() || "（无正文）"
}

function finalStateToDecisionState(value?: string): DecisionState {
  if (value === "ready_to_execute") return "executable"
  if (value === "usable_with_risks") return "risky"
  if (value === "failed_to_converge") return "diverged"
  return "revise"
}

function normalizeConfidence(value?: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return 0
  const pct = raw <= 1 ? raw * 100 : raw
  return Math.max(0, Math.min(100, Math.round(pct)))
}

function normalizeIntensity(value?: number): 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3 ? value : 2
}

function inferProviderPreset(baseUrl = "") {
  const lower = baseUrl.toLowerCase()
  if (lower.includes("anthropic.com")) return "anthropic"
  if (lower.includes("deepseek")) return "deepseek"
  if (lower.includes("openrouter")) return "openrouter"
  if (lower.includes("localhost") || lower.includes("11434")) return "ollama"
  return "custom"
}

function inferProviderName(baseUrl = "", preset = "") {
  if (!baseUrl || baseUrl === "mock://local") return "Mock"
  if (preset) return preset
  return inferProviderPreset(baseUrl)
}

function fileOperationToUi(raw: unknown, index: number, auditOnly: boolean): FileOperation | null {
  const item = (raw || {}) as RawFileOperation
  const status = auditOnly ? terminalAuditFileOpStatus(item.status, item.action) : fileOpStatus(item.status)
  if (!status) return null
  return {
    id: item.id || `file-op-${index + 1}`,
    path: item.path || "",
    action: item.op || item.action || "文件操作",
    status,
    proposedBy: item.source_agent_name || item.source_agent_id || item.agentName || "AI",
    commit: item.commitHash || item.commit,
    canRestore: item.op === "delete"
      && ["executed", "approved"].includes(String(item.status || ""))
      && ["prepared", "deleted"].includes(String(item.recovery?.status || ""))
      && Boolean(item.recovery?.backupId),
  }
}

function fileOpStatus(status?: string): FileOpStatus {
  if (status === "approved") return "approved"
  if (status === "executed" || status === "committed") return "executed"
  if (status === "restored") return "restored"
  if (status === "rejected" || status === "superseded" || status === "unsafe_op") return "rejected"
  return "pending"
}

function terminalAuditFileOpStatus(status?: string, action?: string): FileOpStatus | null {
  const value = status || action
  if (value === "executed" || value === "committed") return "executed"
  if (value === "restored") return "restored"
  if (value === "rejected" || value === "superseded" || value === "unsafe_op") return "rejected"
  return null
}

function formatLastActive(value?: string) {
  if (!value) return "未打开"
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return "最近"
  const diff = Date.now() - time
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`
  return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`
}

function formatTime(value?: string) {
  const date = value ? new Date(value) : new Date()
  if (!Number.isFinite(date.getTime())) return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
