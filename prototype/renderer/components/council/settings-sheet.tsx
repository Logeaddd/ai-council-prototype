"use client"

import { useEffect, useState, type ComponentType, type ReactNode } from "react"
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
import { Badge, Sheet, inputClass } from "./primitives"

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
  disabled?: boolean
}> = [
  { id: "rules", label: "议会规则", icon: ScrollText },
  { id: "models", label: "模型服务", icon: Brain, disabled: true },
  { id: "search", label: "网络搜索", icon: Globe },
  { id: "mcp", label: "MCP 服务器", icon: Plug, disabled: true },
  { id: "skills", label: "技能", icon: Sparkles, disabled: true },
  { id: "plugins", label: "插件", icon: Puzzle, disabled: true },
  { id: "memory", label: "全局记忆", icon: Layers, disabled: true },
  { id: "data", label: "数据设置", icon: Database, disabled: true },
  { id: "security", label: "权限安全", icon: Shield, disabled: true },
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
  webSearchConfigured?: boolean
  webSearchSource?: string
  onSave: (values: {
    mode: WorkMode
    globalRequirement: string
    totalRounds: number
    agentTimeoutMinutes: number
    webSearchApiKey?: string
    clearWebSearchKey?: boolean
  }) => Promise<void> | void
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("rules")
  const [text, setText] = useState(globalRequirement)
  const [webSearchApiKey, setWebSearchApiKey] = useState("")
  const [clearWebSearchKey, setClearWebSearchKey] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setText(globalRequirement)
  }, [globalRequirement])

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onSave({
        mode,
        globalRequirement: text,
        totalRounds,
        agentTimeoutMinutes,
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

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="设置"
      width="max-w-4xl"
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
                onClick={() => {
                  if (!item.disabled) setActiveTab(item.id)
                }}
              />
            ))}
          </div>
        </nav>

        <div className="min-w-0">
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
      disabled={item.disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        item.disabled && "cursor-not-allowed opacity-55 hover:bg-transparent hover:text-muted-foreground",
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

      <SettingRow label="最大讨论轮数">
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
        <Badge tone={configured ? "success" : "neutral"}>
          {configured ? `已设置 · ${source || "本地"}` : "未设置"}
        </Badge>
      </SettingRow>

      <SettingRow label="API 密钥">
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
          <span className="text-[13px] text-danger">清空</span>
        </SettingRow>
      ) : null}
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
