"use client"

import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react"
import {
  Brain,
  Database,
  Globe,
  Layers,
  Plug,
  Puzzle,
  ScrollText,
  Shield,
  Sparkles,
  UserCheck,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WORK_MODE_LABEL,
  type WorkMode,
} from "@/lib/council-data"
import {
  fetchCapabilities,
  fetchMcpCatalog,
  fetchMcpServers,
  fetchProviderPresets,
  installMcpCatalogItem,
  installMcpPackage,
  searchMcpPackages,
  uninstallMcpServer,
  type CapabilityRecord,
  type McpInstallCatalogItem,
  type McpSearchResult,
  type McpServerRecord,
  type ProviderPresetRecord,
} from "@/lib/council-live"
import { Badge, Sheet, inputClass, type Tone } from "./primitives"

type SettingsTab =
  | "rules"
  | "models"
  | "search"
  | "mcp"
  | "skills"
  | "plugins"
  | "memory"
  | "data"
  | "security"

const SETTINGS_TABS: Array<{
  id: SettingsTab
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { id: "rules", label: "议会规则", icon: ScrollText },
  { id: "models", label: "模型服务", icon: Brain },
  { id: "search", label: "网络搜索", icon: Globe },
  { id: "mcp", label: "MCP 服务器", icon: Plug },
  { id: "skills", label: "技能", icon: Sparkles },
  { id: "plugins", label: "插件", icon: Puzzle },
  { id: "memory", label: "公共记忆", icon: Layers },
  { id: "data", label: "数据设置", icon: Database },
  { id: "security", label: "权限安全", icon: Shield },
]

export function SettingsSheet({
  open,
  onClose,
  mode,
  onModeChange,
  globalRequirement,
  onGlobalRequirementChange,
  totalRounds,
  onTotalRoundsChange,
  agentTimeoutMinutes,
  onAgentTimeoutMinutesChange,
  groupsRoot,
  webSearchConfigured,
  webSearchSource,
  onSave,
}: {
  open: boolean
  onClose: () => void
  mode: WorkMode
  onModeChange: (m: WorkMode) => void
  globalRequirement: string
  onGlobalRequirementChange: (value: string) => void
  totalRounds: number
  onTotalRoundsChange: (value: number) => void
  agentTimeoutMinutes: number
  onAgentTimeoutMinutesChange: (value: number) => void
  groupsRoot?: string
  webSearchConfigured?: boolean
  webSearchSource?: string
  onSave: (values: {
    mode: WorkMode
    globalRequirement: string
    totalRounds: number
    agentTimeoutMinutes: number
    groupsRoot?: string
    webSearchApiKey?: string
    clearWebSearchKey?: boolean
  }) => Promise<void> | void
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("rules")
  const [text, setText] = useState(globalRequirement)
  const [dataRoot, setDataRoot] = useState(groupsRoot || "")
  const [webSearchApiKey, setWebSearchApiKey] = useState("")
  const [clearWebSearchKey, setClearWebSearchKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingFacts, setLoadingFacts] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [providers, setProviders] = useState<ProviderPresetRecord[]>([])
  const [capabilities, setCapabilities] = useState<CapabilityRecord[]>([])
  const [mcpCatalog, setMcpCatalog] = useState<McpInstallCatalogItem[]>([])
  const [mcpSearchQuery, setMcpSearchQuery] = useState("")
  const [mcpSearchResults, setMcpSearchResults] = useState<McpSearchResult[]>([])
  const [searchingMcp, setSearchingMcp] = useState(false)
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([])
  const [busyMcpId, setBusyMcpId] = useState("")

  useEffect(() => {
    setText(globalRequirement)
  }, [globalRequirement])

  useEffect(() => {
    setDataRoot(groupsRoot || "")
  }, [groupsRoot])

  const reloadFacts = useCallback(async () => {
    setLoadingFacts(true)
    setSettingsError("")
    try {
      const [providerResult, capabilityResult, catalogResult, serverResult] = await Promise.all([
        fetchProviderPresets(),
        fetchCapabilities(),
        fetchMcpCatalog(),
        fetchMcpServers(),
      ])
      setProviders(providerResult.providers || [])
      setCapabilities(capabilityResult.capabilities || [])
      setMcpCatalog(catalogResult.catalog || [])
      setMcpServers(serverResult.servers || [])
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setLoadingFacts(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void reloadFacts()
  }, [open, reloadFacts])

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onSave({
        mode,
        globalRequirement: text,
        totalRounds,
        agentTimeoutMinutes,
        groupsRoot: dataRoot.trim(),
        webSearchApiKey: webSearchApiKey.trim(),
        clearWebSearchKey,
      })
      onGlobalRequirementChange(text)
      setWebSearchApiKey("")
      setClearWebSearchKey(false)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function installMcp(item: McpInstallCatalogItem) {
    if (busyMcpId) return
    setBusyMcpId(item.id)
    setSettingsError("")
    try {
      const result = await installMcpCatalogItem(item.id)
      if (!result.ok) throw new Error(result.error || result.code || "加入失败")
      await reloadFacts()
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setBusyMcpId("")
    }
  }

  async function searchMcp() {
    const query = mcpSearchQuery.trim()
    if (!query || searchingMcp) return
    setSearchingMcp(true)
    setSettingsError("")
    try {
      const result = await searchMcpPackages(query)
      if (!result.ok) throw new Error(result.error || result.code || "搜索失败")
      setMcpSearchResults(result.results || [])
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setSearchingMcp(false)
    }
  }

  async function installMcpSearchResult(item: McpSearchResult) {
    const packageName = item.packageName || item.name
    if (!packageName || busyMcpId) return
    const serverId = item.id || packageName
    setBusyMcpId(serverId)
    setSettingsError("")
    try {
      const result = await installMcpPackage({
        packageSpec: packageName,
        serverId,
        name: item.name || packageName,
      })
      if (!result.ok) throw new Error(result.error || result.code || "加入失败")
      await reloadFacts()
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setBusyMcpId("")
    }
  }

  async function installCustomMcpPackage(packageSpec: string) {
    const text = packageSpec.trim()
    if (!text || busyMcpId) return
    setBusyMcpId(text)
    setSettingsError("")
    try {
      const result = await installMcpPackage({ packageSpec: text })
      if (!result.ok) throw new Error(result.error || result.code || "加入失败")
      setMcpSearchQuery("")
      setMcpSearchResults([])
      await reloadFacts()
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setBusyMcpId("")
    }
  }

  async function uninstallMcp(item: McpInstallCatalogItem | McpServerRecord) {
    const id = item.id
    if (!id || busyMcpId) return
    setBusyMcpId(id)
    setSettingsError("")
    try {
      const result = await uninstallMcpServer(id)
      if (!result.ok) throw new Error(result.error || result.code || "移除失败")
      await reloadFacts()
    } catch (error) {
      setSettingsError(errorMessage(error))
    } finally {
      setBusyMcpId("")
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="设置"
      width="max-w-5xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          <button
            disabled={saving}
            onClick={save}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "保存中" : "保存"}
          </button>
        </div>
      }
    >
      <div className="grid min-h-[560px] grid-cols-[180px_minmax(0,1fr)] gap-5">
        <nav className="border-r border-border pr-3">
          <div className="space-y-1">
            {SETTINGS_TABS.map((item) => (
              <SettingsNavItem
                key={item.id}
                item={item}
                active={activeTab === item.id}
                onClick={() => setActiveTab(item.id)}
              />
            ))}
          </div>
        </nav>

        <div className="min-w-0">
          {settingsError ? (
            <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {settingsError}
            </div>
          ) : null}

          {activeTab === "rules" ? (
            <RulesPanel
              mode={mode}
              onModeChange={onModeChange}
              text={text}
              onTextChange={setText}
              totalRounds={totalRounds}
              onTotalRoundsChange={onTotalRoundsChange}
              agentTimeoutMinutes={agentTimeoutMinutes}
              onAgentTimeoutMinutesChange={onAgentTimeoutMinutesChange}
            />
          ) : null}

          {activeTab === "models" ? <ModelsPanel providers={providers} loading={loadingFacts} /> : null}

          {activeTab === "search" ? (
            <SearchPanel
              configured={webSearchConfigured}
              source={webSearchSource}
              apiKey={webSearchApiKey}
              clearKey={clearWebSearchKey}
              onApiKeyChange={(value) => {
                setWebSearchApiKey(value)
                setClearWebSearchKey(false)
              }}
              onClear={() => {
                setWebSearchApiKey("")
                setClearWebSearchKey(true)
              }}
            />
          ) : null}

          {activeTab === "mcp" ? (
            <McpPanel
              catalog={mcpCatalog}
              servers={mcpServers}
              loading={loadingFacts}
              busyId={busyMcpId}
              searchQuery={mcpSearchQuery}
              searchResults={mcpSearchResults}
              searching={searchingMcp}
              onSearchQueryChange={setMcpSearchQuery}
              onSearch={searchMcp}
              onRefresh={reloadFacts}
              onInstall={installMcp}
              onInstallSearchResult={installMcpSearchResult}
              onInstallCustom={installCustomMcpPackage}
              onUninstall={uninstallMcp}
            />
          ) : null}

          {activeTab === "skills" ? <SkillsPanel capabilities={capabilities} loading={loadingFacts} /> : null}
          {activeTab === "plugins" ? <PluginsPanel servers={mcpServers} loading={loadingFacts} /> : null}
          {activeTab === "memory" ? <MemoryPanel capabilities={capabilities} loading={loadingFacts} /> : null}
          {activeTab === "data" ? <DataPanel value={dataRoot} onChange={setDataRoot} /> : null}
          {activeTab === "security" ? <SecurityPanel capabilities={capabilities} loading={loadingFacts} /> : null}
        </div>
      </div>
    </Sheet>
  )
}

function SettingsNavItem({
  item,
  active,
  onClick,
}: {
  item: (typeof SETTINGS_TABS)[number]
  active: boolean
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  )
}

function RulesPanel({
  mode,
  onModeChange,
  text,
  onTextChange,
  totalRounds,
  onTotalRoundsChange,
  agentTimeoutMinutes,
  onAgentTimeoutMinutesChange,
}: {
  mode: WorkMode
  onModeChange: (m: WorkMode) => void
  text: string
  onTextChange: (value: string) => void
  totalRounds: number
  onTotalRoundsChange: (value: number) => void
  agentTimeoutMinutes: number
  onAgentTimeoutMinutesChange: (value: number) => void
}) {
  return (
    <div className="space-y-6">
      <PanelTitle title="议会规则" />

      <SettingRow label="工作模式">
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "collab" as WorkMode, icon: Users },
            { value: "independent" as WorkMode, icon: UserCheck },
          ].map(({ value, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => onModeChange(value)}
              className={cn(
                "flex h-10 items-center gap-2 rounded-md border px-3 text-left text-[13px] transition-colors",
                mode === value
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{WORK_MODE_LABEL[value]}</span>
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="全局要求">
        <textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          rows={8}
          className={cn(inputClass, "resize-none leading-relaxed")}
        />
      </SettingRow>

      <SettingRow label="最大轮数">
        <RangeControl
          min={1}
          max={100}
          value={totalRounds}
          unit="轮"
          onChange={onTotalRoundsChange}
        />
      </SettingRow>

      <SettingRow label="单个 AI 最长等待时间">
        <RangeControl
          min={1}
          max={60}
          value={agentTimeoutMinutes}
          unit="分钟"
          onChange={onAgentTimeoutMinutesChange}
        />
      </SettingRow>
    </div>
  )
}

function ModelsPanel({
  providers,
  loading,
}: {
  providers: ProviderPresetRecord[]
  loading: boolean
}) {
  return (
    <div className="space-y-4">
      <PanelTitle title="模型服务" />
      <FactGrid
        rows={providers.map((provider) => ({
          key: provider.id,
          name: provider.label || provider.name || provider.id,
          meta: provider.defaultModel || provider.baseUrl || provider.officialBaseUrl || "自定义模型",
          tone: "success",
          status: "已内置",
        }))}
        loading={loading}
      />
    </div>
  )
}

function SearchPanel({
  configured,
  source,
  apiKey,
  clearKey,
  onApiKeyChange,
  onClear,
}: {
  configured?: boolean
  source?: string
  apiKey: string
  clearKey: boolean
  onApiKeyChange: (value: string) => void
  onClear: () => void
}) {
  return (
    <div className="space-y-6">
      <PanelTitle title="网络搜索" />

      <SettingRow label="状态">
        <Badge tone="success">
          {`可用 · ${source || "内置搜索"}`}
        </Badge>
      </SettingRow>

      <SettingRow label="Brave">
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            className={cn(inputClass, "flex-1")}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            清空
          </button>
        </div>
      </SettingRow>

      {clearKey ? (
        <SettingRow label="保存后">
          <span className="text-[13px] text-danger">清空密钥</span>
        </SettingRow>
      ) : null}
    </div>
  )
}

function McpPanel({
  catalog,
  servers,
  loading,
  busyId,
  searchQuery,
  searchResults,
  searching,
  onSearchQueryChange,
  onSearch,
  onRefresh,
  onInstall,
  onInstallSearchResult,
  onInstallCustom,
  onUninstall,
}: {
  catalog: McpInstallCatalogItem[]
  servers: McpServerRecord[]
  loading: boolean
  busyId: string
  searchQuery: string
  searchResults: McpSearchResult[]
  searching: boolean
  onSearchQueryChange: (value: string) => void
  onSearch: () => Promise<void>
  onRefresh: () => Promise<void>
  onInstall: (item: McpInstallCatalogItem) => Promise<void>
  onInstallSearchResult: (item: McpSearchResult) => Promise<void>
  onInstallCustom: (packageSpec: string) => Promise<void>
  onUninstall: (item: McpInstallCatalogItem | McpServerRecord) => Promise<void>
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <h3 className="text-sm font-semibold text-foreground">MCP 服务器</h3>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          刷新
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onSearch()
            }}
            className={cn(inputClass, "flex-1 font-mono text-[12px]")}
            placeholder="npm 包名或关键词"
          />
          <button
            type="button"
            disabled={searching || !searchQuery.trim()}
            onClick={() => void onSearch()}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {searching ? "搜索中" : "搜索"}
          </button>
          <button
            type="button"
            disabled={Boolean(busyId) || !searchQuery.trim()}
            onClick={() => void onInstallCustom(searchQuery)}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            加入
          </button>
        </div>
        {searchResults.length ? (
          <div className="space-y-2">
            {searchResults.map((item) => (
              <div
                key={item.packageName || item.name}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{item.name}</span>
                    {item.version ? <Badge>{item.version}</Badge> : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {item.packageName}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void onInstallSearchResult(item)}
                  className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busyId === item.id ? "加入中" : "加入"}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        {loading ? <EmptyLine text="读取中" /> : null}
        {!loading && !catalog.length ? <EmptyLine text="暂无可加入项" /> : null}
        {catalog.map((item) => {
          const state = mcpCatalogDisplay(item)
          return (
            <div
              key={item.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">{item.name}</span>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {item.packageName}
                </div>
              </div>
              {state.joined ? (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void onUninstall(item)}
                  className="rounded-md border border-border px-3 py-1.5 text-[13px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                >
                  {busyId === item.id ? "移除中" : "移除"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void onInstall(item)}
                  className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busyId === item.id ? "加入中" : state.action}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-2">
        <div className="text-[13px] font-medium text-foreground">已加入</div>
        {!servers.length ? <EmptyLine text="暂无" /> : null}
        {servers.map((server) => (
          <div
            key={server.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">{server.name || server.id}</span>
                <Badge tone={server.enabled === false ? "neutral" : "success"}>
                  {server.enabled === false ? "停用" : "启用"}
                </Badge>
                {server.source === "managed_npm" ? <Badge>npm</Badge> : null}
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {server.install?.packageName || server.command || server.id}
              </div>
            </div>
            {server.source === "managed_npm" ? (
              <button
                type="button"
                disabled={busyId === server.id}
                onClick={() => void onUninstall(server)}
                className="rounded-md border border-border px-3 py-1.5 text-[13px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              >
                {busyId === server.id ? "移除中" : "移除"}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function SkillsPanel({
  capabilities,
  loading,
}: {
  capabilities: CapabilityRecord[]
  loading: boolean
}) {
  const rows = capabilities
    .filter((item) => item.kind === "tool" || item.kind === "memory" || item.kind === "mcp_server")
    .map((item) => ({
      key: item.id,
      name: item.label,
      meta: item.provider || item.source || item.kind,
      tone: capabilityTone(item),
      status: capabilityStatus(item),
    }))

  return (
    <div className="space-y-4">
      <PanelTitle title="技能" />
      <FactGrid rows={rows} loading={loading} />
    </div>
  )
}

function PluginsPanel({
  servers,
  loading,
}: {
  servers: McpServerRecord[]
  loading: boolean
}) {
  return (
    <div className="space-y-4">
      <PanelTitle title="插件" />
      <FactGrid
        rows={servers.map((server) => ({
          key: server.id,
          name: server.name || server.id,
          meta: server.install?.packageName || server.command || server.transport || "stdio",
          tone: server.enabled === false ? "neutral" : "success",
          status: server.enabled === false ? "停用" : "启用",
        }))}
        loading={loading}
        emptyText="暂无"
      />
    </div>
  )
}

function MemoryPanel({
  capabilities,
  loading,
}: {
  capabilities: CapabilityRecord[]
  loading: boolean
}) {
  const rows = capabilities
    .filter((item) => item.kind === "memory")
    .map((item) => ({
      key: item.id,
      name: item.label,
      meta: item.source || item.provider || "local_server",
      tone: capabilityTone(item),
      status: capabilityStatus(item),
    }))

  return (
    <div className="space-y-4">
      <PanelTitle title="公共记忆" />
      <FactGrid rows={rows} loading={loading} />
    </div>
  )
}

function DataPanel({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-6">
      <PanelTitle title="数据设置" />
      <SettingRow label="保存位置">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(inputClass, "font-mono text-[12px]")}
        />
      </SettingRow>
    </div>
  )
}

function SecurityPanel({
  capabilities,
  loading,
}: {
  capabilities: CapabilityRecord[]
  loading: boolean
}) {
  const fullTools = capabilities.filter((item) =>
    ["execute-command", "run-code", "install-package", "run-tests", "git-operation", "browser-control"].includes(item.id) ||
    item.id.startsWith("mcp-")
  )

  return (
    <div className="space-y-5">
      <PanelTitle title="权限安全" />
      <div className="grid grid-cols-3 gap-2">
        <PermissionBlock title="文本" items={["发言"]} />
        <PermissionBlock title="工具" items={["网页", "文件", "数据库读取"]} />
        <PermissionBlock title="完全" items={["终端", "代码", "安装", "Git", "浏览器", "MCP"]} />
      </div>
      <FactGrid
        rows={fullTools.map((item) => ({
          key: item.id,
          name: item.label,
          meta: item.provider || item.source || item.kind,
          tone: capabilityTone(item),
          status: capabilityStatus(item),
        }))}
        loading={loading}
      />
    </div>
  )
}

function FactGrid({
  rows,
  loading,
  emptyText = "暂无",
}: {
  rows: Array<{
    key: string
    name: string
    meta?: string
    status: string
    tone?: Tone
  }>
  loading: boolean
  emptyText?: string
}) {
  if (loading) return <EmptyLine text="读取中" />
  if (!rows.length) return <EmptyLine text={emptyText} />

  return (
    <div className="grid gap-2">
      {rows.map((row) => (
        <div
          key={row.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">{row.name}</div>
            {row.meta ? (
              <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{row.meta}</div>
            ) : null}
          </div>
          <Badge tone={row.tone || "neutral"}>{row.status}</Badge>
        </div>
      ))}
    </div>
  )
}

function PermissionBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Badge key={item}>{item}</Badge>
        ))}
      </div>
    </div>
  )
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
      {text}
    </div>
  )
}

function PanelTitle({ title }: { title: string }) {
  return (
    <div className="border-b border-border pb-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    </div>
  )
}

function SettingRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
      <div className="pt-1 text-[13px] font-medium text-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function RangeControl({
  min,
  max,
  value,
  unit,
  onChange,
}: {
  min: number
  max: number
  value: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 accent-[var(--primary)]"
      />
      <span className="w-20 text-right font-mono text-sm tabular-nums text-foreground">
        {value} {unit}
      </span>
    </div>
  )
}

function capabilityStatus(item: CapabilityRecord) {
  if (item.status === "needs_config") return "需配置"
  if (item.status === "planned") return "未安装"
  if (item.enabled === false) return "停用"
  return "可用"
}

function capabilityTone(item: CapabilityRecord): Tone {
  if (item.status === "needs_config") return "warning"
  if (item.status === "planned" || item.enabled === false) return "neutral"
  return "success"
}

function mcpCatalogDisplay(item: McpInstallCatalogItem): {
  label: string
  action: string
  tone: Tone
  joined: boolean
} {
  if (item.runtimeStatus === "disabled" || (item.serverConfigured && item.serverEnabled === false)) {
    return { label: "已停用", action: "重新加入", tone: "neutral", joined: true }
  }
  if (item.runtimeStatus === "files_missing") {
    return { label: "文件缺失", action: "重新加入", tone: "danger", joined: false }
  }
  if (item.runtimeStatus === "package_only" || (item.packageInstalled && !item.serverConfigured)) {
    return { label: "仅下载", action: "重新加入", tone: "warning", joined: false }
  }
  if (item.installed && item.serverConfigured !== false) {
    return { label: "已加入", action: "加入", tone: "success", joined: true }
  }
  return { label: "可加入", action: "加入", tone: "neutral", joined: false }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "操作失败")
}
