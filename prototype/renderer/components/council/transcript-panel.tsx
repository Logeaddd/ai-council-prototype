"use client"

import { Lock, ShieldCheck, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type AgentMember,
  type TranscriptItem,
  type WorkMode,
  ROLE_LABEL,
} from "@/lib/council-data"
import { Avatar, Badge, StatePill } from "./primitives"

export function TranscriptPanel({
  items,
  mode,
  members,
  currentTask,
  running = false,
  compact = false,
}: {
  items: TranscriptItem[]
  mode: WorkMode
  members: AgentMember[]
  currentTask: string
  running?: boolean
  compact?: boolean
}) {
  const visibleItems =
    mode === "independent"
      ? items.filter((item) => item.kind !== "system")
      : items

  return (
    <div
      className={cn(
        "mx-auto w-full px-5 py-5",
        compact ? "max-w-full" : "max-w-3xl",
      )}
    >
      {!compact ? <TaskHeader currentTask={currentTask} /> : null}
      <div className={cn(compact ? "mt-0" : "mt-4", "space-y-1")}>
        {visibleItems.map((item) => (
          <TranscriptRow key={item.id} item={item} members={members} />
        ))}
        {running ? <TypingRow members={members} /> : null}
      </div>
    </div>
  )
}

function TaskHeader({ currentTask }: { currentTask: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        当前任务
      </span>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground text-pretty">
        {currentTask}
      </p>
    </div>
  )
}

function TranscriptRow({
  item,
  members,
}: {
  item: TranscriptItem
  members: AgentMember[]
}) {
  if (item.kind === "round") {
    const roundLabel = item.totalRounds > 0 ? `第 ${item.round} / ${item.totalRounds} 轮` : `第 ${item.round} 轮`
    return (
      <div className="flex items-center gap-3 py-3">
        <div className="h-px flex-1 bg-border" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {roundLabel}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    )
  }

  if (item.kind === "system") {
    return (
      <div className="flex items-start gap-2 rounded-md bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span className="leading-relaxed">{cleanSystemBody(item.body)}</span>
      </div>
    )
  }

  if (item.kind === "private-hint") {
    return (
      <div className="flex items-center gap-2 py-1.5 pl-1 text-xs text-muted-foreground">
        <Lock className="size-3.5 text-warning" />
        <span className="italic">{item.preview}</span>
        <span className="ml-auto font-mono text-[11px]">{item.time}</span>
      </div>
    )
  }

  const member = members.find((itemMember) => itemMember.id === item.agentId)
  if (!member) return null
  const isReview = item.visibility === "review"
  const isPrivateAnswer = item.visibility === "private-answer"

  return (
    <div className="group flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-card/60">
      <Avatar name={member.name} id={member.id} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-foreground">
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
            {member.role === "reviewer" ? <ShieldCheck className="size-3" /> : null}
            {ROLE_LABEL[member.role]}
          </Badge>
          <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
            {member.provider} · {member.model}
          </span>
          {isReview ? <Badge tone="warning">审查可见</Badge> : null}
          {isPrivateAnswer ? (
            <Badge tone="info">
              <Lock className="size-3" />
              独立答卷
            </Badge>
          ) : null}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {item.time}
          </span>
        </div>
        <div
          className={cn(
            "mt-1.5 rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed text-foreground/90",
            isReview
              ? "border-warning/25 bg-warning/5"
              : isPrivateAnswer
                ? "border-info/20 bg-info/5"
                : "border-border bg-card",
          )}
        >
          {item.body}
          {item.state === "speaking" ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-primary" />
          ) : null}
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <StatePill state={item.state} />
          {item.tokens ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {item.tokens} tok
            </span>
          ) : null}
          {item.durationMs ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              用时 {formatDuration(item.durationMs)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function formatDuration(value: number) {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (!minutes) return `${seconds}秒`
  return `${minutes}分${seconds}秒`
}

function cleanSystemBody(body: string) {
  return body.replace(/^\s*你[:：]\s*/, "")
}

function TypingRow({ members }: { members: AgentMember[] }) {
  const speaker =
    members.find((member) => member.state === "speaking") ||
    members.find((member) => member.state === "thinking")

  return (
    <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
      <span className="flex h-4 items-end gap-1.5">
        <span className="size-2 rounded-full bg-primary typing-dot-bounce [animation-delay:-0.24s]" />
        <span className="size-2 rounded-full bg-primary typing-dot-bounce [animation-delay:-0.12s]" />
        <span className="size-2 rounded-full bg-primary typing-dot-bounce" />
      </span>
      {speaker?.name || "成员"} 正在输入...
    </div>
  )
}
