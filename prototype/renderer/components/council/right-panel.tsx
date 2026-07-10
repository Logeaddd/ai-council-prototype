"use client"

import { useState } from "react"
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  Coins,
  Cpu,
  FileCode2,
  GitCommitHorizontal,
  GripVertical,
  KeyRound,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  API_KEY_LABEL,
  DECISION_LABEL,
  FILEOP_STATUS_LABEL,
  PERMISSION_LABEL,
  ROLE_LABEL,
  type AgentMember,
  type Blocker,
  type DecisionState,
  type FileOperation,
  type FileOpStatus,
  type UsageSummary,
  type WorkMode,
} from "@/lib/council-data"
import {
  Avatar,
  Badge,
  DECISION_TONE,
  StatePill,
  type Tone,
} from "./primitives"

export function RightPanel({
  members,
  blockers,
  fileOps,
  usage,
  decision,
  statusText,
  mode,
  onAddMember,
  onConfigureMember,
  onToggleMuteMember,
  onReorderMembers,
  onApproveFileOp,
  onRejectFileOp,
  onExecuteFileOp,
  onRestoreFileOp,
}: {
  members: AgentMember[]
  blockers: Blocker[]
  fileOps: FileOperation[]
  usage: UsageSummary
  decision: {
    state: DecisionState
    confidence: number
    summary: string
  }
  statusText: string
  mode: WorkMode
  onAddMember: () => void
  onConfigureMember: (id: string) => void
  onToggleMuteMember: (id: string) => void
  onReorderMembers: (ids: string[]) => void
  onApproveFileOp: (id: string) => void
  onRejectFileOp: (id: string) => void
  onExecuteFileOp: (id: string) => void
  onRestoreFileOp: (id: string) => void
}) {
  const [draggedMemberId, setDraggedMemberId] = useState<string | null>(null)
  const [dragOverMemberId, setDragOverMemberId] = useState<string | null>(null)

  function handleMemberDrop(targetId: string) {
    if (!draggedMemberId || draggedMemberId === targetId) {
      setDraggedMemberId(null)
      setDragOverMemberId(null)
      return
    }
    const ids = members.map((member) => member.id)
    const from = ids.indexOf(draggedMemberId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) {
      setDraggedMemberId(null)
      setDragOverMemberId(null)
      return
    }
    const next = ids.filter((id) => id !== draggedMemberId)
    const targetIndex = next.indexOf(targetId)
    next.splice(from < to ? targetIndex + 1 : targetIndex, 0, draggedMemberId)
    onReorderMembers(next)
    setDraggedMemberId(null)
    setDragOverMemberId(null)
  }

  return (
    <aside className="flex h-full w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <DecisionCard decision={decision} statusText={statusText} />
      <Section
        title="议会成员"
        count={members.length}
        action={
          <button
            type="button"
            onClick={onAddMember}
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3" /> 添加
          </button>
        }
      >
        <div className="space-y-2">
          {members.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              mode={mode}
              dragging={draggedMemberId === member.id}
              dragOver={dragOverMemberId === member.id && draggedMemberId !== member.id}
              draggable={members.length > 1}
              onDragStart={(event) => {
                setDraggedMemberId(member.id)
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", member.id)
              }}
              onDragOver={(event) => {
                if (!draggedMemberId || draggedMemberId === member.id) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                setDragOverMemberId(member.id)
              }}
              onDragLeave={() => {
                setDragOverMemberId((current) => (current === member.id ? null : current))
              }}
              onDrop={(event) => {
                event.preventDefault()
                handleMemberDrop(member.id)
              }}
              onDragEnd={() => {
                setDraggedMemberId(null)
                setDragOverMemberId(null)
              }}
              onConfigure={() => onConfigureMember(member.id)}
              onToggleMute={() => onToggleMuteMember(member.id)}
            />
          ))}
          {!members.length ? (
            <EmptyLine>这个小组还没有成员</EmptyLine>
          ) : null}
        </div>
      </Section>
      <Section title="待处理问题" count={blockers.length}>
        <BlockersList blockers={blockers} />
      </Section>
      <Section title="文件操作提案" count={fileOps.length}>
        <FileOpsList
          fileOps={fileOps}
          onApprove={onApproveFileOp}
          onReject={onRejectFileOp}
          onExecute={onExecuteFileOp}
          onRestore={onRestoreFileOp}
        />
      </Section>
      <Section title="用量与成本">
        <UsageGrid usage={usage} />
      </Section>
    </aside>
  )
}

function Section({
  title,
  count,
  action,
  defaultOpen = true,
  children,
}: {
  title: string
  count?: number
  action?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          onClick={() => setOpen((value) => !value)}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          {count != null ? (
            <span className="rounded-full bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {count}
            </span>
          ) : null}
        </button>
        {action}
      </div>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </section>
  )
}

function DecisionCard({
  decision,
  statusText,
}: {
  decision: {
    state: DecisionState
    confidence: number
    summary: string
  }
  statusText: string
}) {
  return (
    <div className="border-b border-border bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          最终决策
        </span>
        <Badge tone={DECISION_TONE[decision.state]}>
          {DECISION_LABEL[decision.state]}
        </Badge>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-foreground/90 text-pretty">
        {decision.summary}
      </p>
      {statusText ? (
        <p className="mt-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
          {statusText}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">收敛置信度</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-info"
            style={{ width: `${decision.confidence}%` }}
          />
        </div>
        <span className="font-mono text-[11px] font-semibold text-info">
          {decision.confidence}%
        </span>
      </div>
    </div>
  )
}

function MemberCard({
  member,
  mode,
  dragging,
  dragOver,
  draggable,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onConfigure,
  onToggleMute,
}: {
  member: AgentMember
  mode: WorkMode
  dragging: boolean
  dragOver: boolean
  draggable: boolean
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onConfigure: () => void
  onToggleMute: () => void
}) {
  const keyTone: Tone =
    member.apiKey === "set"
      ? "success"
      : member.apiKey === "local"
        ? "info"
        : "danger"
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "rounded-lg border bg-card/50 transition-colors",
        member.state === "unavailable" ? "border-danger/30" : "border-border",
        dragging && "opacity-55",
        dragOver && "border-primary/70 bg-primary/5",
      )}
    >
      <div className="flex items-center gap-2.5 p-2.5">
        <button
          type="button"
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label={`拖动调整 ${member.name} 顺序`}
          title="拖动排序"
          className={cn(
            "flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing",
            !draggable && "cursor-default opacity-40 hover:bg-transparent hover:text-muted-foreground",
          )}
        >
          <GripVertical className="size-3.5" />
        </button>
        <Avatar name={member.name} id={member.id} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-foreground">
              {member.name}
            </span>
            <Badge
              tone={
                member.role === "reviewer"
                  ? "warning"
                  : member.role === "summarizer"
                    ? "success"
                    : "neutral"
              }
            >
              {member.role === "reviewer" ? (
                <ShieldCheck className="size-3" />
              ) : null}
              {roleLabel(member.role, mode)}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {member.provider} · {member.model}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StatePill state={member.state} />
          <button
            onClick={onToggleMute}
            className={cn(
              "rounded p-1 transition-colors hover:bg-accent",
              member.muted ? "text-warning hover:text-warning" : "text-muted-foreground hover:text-foreground",
            )}
            aria-label={member.muted ? `取消禁言 ${member.name}` : `禁言 ${member.name}`}
            title={member.muted ? "取消禁言" : "禁言，下一轮生效"}
          >
            {member.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>
          <button
            onClick={onConfigure}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`配置 ${member.name}`}
          >
            <Settings2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-2.5 py-1.5">
        <Badge>{PERMISSION_LABEL[member.permission]}</Badge>
        <Badge tone={keyTone}>
          <KeyRound className="size-3" />
          {API_KEY_LABEL[member.apiKey]}
        </Badge>
        {member.reviewer ? <Badge tone="warning">{mode === "independent" ? "监督员" : "审查者"}</Badge> : null}
        {member.muted ? <Badge tone="warning">已禁言</Badge> : null}
        <span
          className={cn(
            "ml-auto flex items-center gap-1 font-mono text-[11px]",
            member.healthy ? "text-success" : "text-danger",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              member.healthy ? "bg-success" : "bg-danger",
            )}
          />
          {member.healthy
            ? member.latencyMs
              ? `${member.latencyMs}ms`
              : "在线"
            : "离线"}
        </span>
      </div>
    </div>
  )
}

function roleLabel(role: AgentMember["role"], mode: WorkMode) {
  if (role === "reviewer" && mode === "independent") return "监督员"
  return ROLE_LABEL[role]
}

function BlockersList({ blockers }: { blockers: Blocker[] }) {
  if (!blockers.length) return <EmptyLine>暂无待处理问题</EmptyLine>
  return (
    <div className="space-y-2">
      {blockers.map((blocker) => (
        <div
          key={blocker.id}
          className={cn(
            "rounded-lg border p-2.5",
            blocker.severity === "high"
              ? "border-danger/30 bg-danger/5"
              : "border-warning/30 bg-warning/5",
          )}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle
              className={cn(
                "size-3.5",
                blocker.severity === "high" ? "text-danger" : "text-warning",
              )}
            />
            <span className="text-[13px] font-medium text-foreground">
              {blocker.title}
            </span>
            <Badge
              tone={blocker.severity === "high" ? "danger" : "warning"}
              className="ml-auto"
            >
              {blocker.severity === "high" ? "高" : "中"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {blocker.detail}
          </p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            由 {blocker.raisedBy} 提出
          </p>
        </div>
      ))}
    </div>
  )
}

const FILEOP_STYLE: Record<FileOpStatus, { icon: typeof Check; tone: Tone }> = {
  pending: { icon: Clock, tone: "warning" },
  approved: { icon: Check, tone: "info" },
  executed: { icon: GitCommitHorizontal, tone: "success" },
  restored: { icon: RotateCcw, tone: "info" },
  rejected: { icon: X, tone: "danger" },
}

function FileOpsList({
  fileOps,
  onApprove,
  onReject,
  onExecute,
  onRestore,
}: {
  fileOps: FileOperation[]
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onExecute: (id: string) => void
  onRestore: (id: string) => void
}) {
  if (!fileOps.length) return <EmptyLine>暂无文件操作提案</EmptyLine>
  return (
    <div className="space-y-1.5">
      {fileOps.map((fileOp) => {
        const style = FILEOP_STYLE[fileOp.status]
        const Icon = style.icon
        return (
          <div
            key={fileOp.id}
            className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-2"
          >
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-foreground">
                {fileOp.path}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {fileOp.action} · {fileOp.proposedBy}
                {fileOp.commit ? (
                  <span className="ml-1 font-mono text-success">#{fileOp.commit}</span>
                ) : null}
              </p>
            </div>
            <Badge tone={style.tone}>
              <Icon className="size-3" />
              {FILEOP_STATUS_LABEL[fileOp.status]}
            </Badge>
            {fileOp.status === "pending" ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onApprove(fileOp.id)}
                  className="rounded bg-success/15 p-1 text-success transition-colors hover:bg-success/25"
                  aria-label="批准"
                  title="批准"
                >
                  <Check className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onReject(fileOp.id)}
                  className="rounded bg-danger/15 p-1 text-danger transition-colors hover:bg-danger/25"
                  aria-label="拒绝"
                  title="拒绝"
                >
                  <X className="size-3" />
                </button>
              </div>
            ) : null}
            {fileOp.status === "approved" && !fileOp.canRestore ? (
              <button
                type="button"
                onClick={() => onExecute(fileOp.id)}
                className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                执行
              </button>
            ) : null}
            {fileOp.canRestore ? (
              <button
                type="button"
                onClick={() => onRestore(fileOp.id)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="恢复文件"
                title="恢复文件"
              >
                <RotateCcw className="size-3.5" />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function UsageGrid({ usage }: { usage: UsageSummary }) {
  const tokenRatio = usage.tokensBudget && usage.tokensBudget > 0
    ? usage.tokensTotal / usage.tokensBudget
    : undefined
  const costRatio = usage.costUsd != null && usage.costBudgetUsd && usage.costBudgetUsd > 0
    ? usage.costUsd / usage.costBudgetUsd
    : undefined
  return (
    <div className="grid grid-cols-2 gap-2">
      <UsageStat
        icon={Coins}
        label="Token 用量"
        value={`${(usage.tokensTotal / 1000).toFixed(1)}k`}
        sub={formatTokenUsageSub(usage)}
        ratio={tokenRatio}
      />
      <UsageStat
        icon={Coins}
        label="成本估算"
        value={usage.costUsd == null ? "未配置" : `$${usage.costUsd.toFixed(2)}`}
        sub={formatCostUsageSub(usage)}
        ratio={costRatio}
      />
      <UsageStat
        icon={Activity}
        label="API 调用"
        value={`${usage.apiCalls}`}
        sub={`${usage.apiErrors} 错误`}
        tone={usage.apiErrors > 0 ? "warning" : "default"}
      />
      <UsageStat
        icon={Cpu}
        label="平均延迟"
        value={`${usage.avgLatencyMs}`}
        sub="ms"
      />
    </div>
  )
}

function formatTokenUsageSub(usage: UsageSummary) {
  const sourceLabel: Record<UsageSummary["tokenAccounting"], string> = {
    estimated: "估算",
    provider_usage: "供应商返回",
    mixed: "部分估算",
    unknown: "未知",
  }
  const source = sourceLabel[usage.tokenAccounting]
  if (usage.tokensBudget && usage.tokensBudget > 0) {
    return `${source} / ${(usage.tokensBudget / 1000).toFixed(0)}k`
  }
  return `${source} / 限额未配置`
}

function formatCostUsageSub(usage: UsageSummary) {
  if (usage.costAccounting === "not_configured") return "单价未配置"
  if (usage.costBudgetUsd && usage.costBudgetUsd > 0) {
    return `/ $${usage.costBudgetUsd.toFixed(2)}`
  }
  return "限额未配置"
}

function UsageStat({
  icon: Icon,
  label,
  value,
  sub,
  ratio,
  tone = "default",
}: {
  icon: typeof Coins
  label: string
  value: string
  sub?: string
  ratio?: number
  tone?: "default" | "warning"
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            "font-mono text-lg font-semibold tabular-nums",
            tone === "warning" ? "text-warning" : "text-foreground",
          )}
        >
          {value}
        </span>
        {sub ? (
          <span className="font-mono text-[10px] text-muted-foreground">{sub}</span>
        ) : null}
      </div>
      {ratio != null ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full",
              ratio > 0.8 ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${Math.min(ratio * 100, 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  )
}
