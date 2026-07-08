"use client"

import {
  Activity,
  Armchair,
  Coins,
  History,
  LayoutGrid,
  PanelRight,
  Play,
  Square,
  UserCheck,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type VisualStyle,
  type WorkMode,
  type UsageSummary,
  WORK_MODE_LABEL,
} from "@/lib/council-data"
import { SegmentedControl, IconButton } from "./primitives"

interface TopBarProps {
  groupName: string
  mode: WorkMode
  round: number
  totalRounds: number
  running: boolean
  usage: UsageSummary
  visualStyle: VisualStyle
  rightOpen: boolean
  onToggleRun: () => void
  onVisualStyleChange: (s: VisualStyle) => void
  onToggleRight: () => void
  onOpenHistory: () => void
}

function Metric({
  icon: Icon,
  children,
  tone = "default",
}: {
  icon: typeof Activity
  children: React.ReactNode
  tone?: "default" | "warning"
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs tabular-nums",
        tone === "warning" ? "text-warning" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
      <span>{children}</span>
    </div>
  )
}

export function TopBar({
  groupName,
  mode,
  round,
  totalRounds,
  running,
  usage,
  visualStyle,
  rightOpen,
  onToggleRun,
  onVisualStyleChange,
  onToggleRight,
  onOpenHistory,
}: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      {/* 议会标题 + 进度 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-sm font-semibold text-foreground">
          {groupName}
        </span>
        <span className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
          第 {round} / {totalRounds} 轮
        </span>
      </div>

      {/* 工作模式（AI 逻辑） */}
      <div className="hidden items-center gap-1.5 md:flex">
        <span className="text-[11px] text-muted-foreground">工作模式</span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
            mode === "collab"
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-info/30 bg-info/10 text-info",
          )}
          title="工作模式决定 AI 协作逻辑，可在设置中切换"
        >
          {mode === "collab" ? (
            <Users className="size-3.5" />
          ) : (
            <UserCheck className="size-3.5" />
          )}
          {WORK_MODE_LABEL[mode]}
        </span>
      </div>

      {/* 进度条 */}
      <div className="hidden min-w-0 flex-1 items-center lg:flex">
        <div className="h-1 w-full max-w-40 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${(round / totalRounds) * 100}%` }}
          />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden items-center gap-4 xl:flex">
          <Metric icon={Coins}>
            {usage.tokensTotal.toLocaleString()} tok · {formatTopBarCost(usage)}
          </Metric>
          <Metric icon={Activity}>{usage.avgLatencyMs}ms</Metric>
        </div>

        {/* 运行控制 */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleRun}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              running
                ? "bg-danger/15 text-danger hover:bg-danger/25"
                : "bg-primary text-primary-foreground hover:opacity-90",
            )}
          >
            {running ? (
              <>
                <Square className="size-3.5 fill-current" />
                停止
              </>
            ) : (
              <>
                <Play className="size-3.5 fill-current" />
                开始
              </>
            )}
          </button>
        </div>

        {/* 视图风格一键切换 */}
        <div className="flex items-center gap-1 border-l border-border pl-3">
          <SegmentedControl<VisualStyle>
            ariaLabel="视图风格"
            size="sm"
            value={visualStyle}
            onChange={(next) => {
              if (next === "workbench") onVisualStyleChange(next)
            }}
            options={[
              { value: "workbench", label: "标准工作台", icon: LayoutGrid },
              { value: "roundtable", label: "圆桌会议", icon: Armchair, disabled: true },
            ]}
          />
          <IconButton
            label="聊天记录"
            onClick={onOpenHistory}
          >
            <History className="size-4" />
          </IconButton>
          <IconButton
            label={rightOpen ? "关闭侧栏" : "打开侧栏"}
            active={rightOpen}
            onClick={onToggleRight}
          >
            <PanelRight className="size-4" />
          </IconButton>
        </div>
      </div>
    </header>
  )
}

function formatTopBarCost(usage: UsageSummary) {
  if (usage.costUsd == null) return "成本未配置"
  return `$${usage.costUsd.toFixed(2)}`
}
