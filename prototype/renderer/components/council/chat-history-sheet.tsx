"use client"

import type React from "react"
import { useEffect, useState } from "react"
import { Clock, MessageSquareText } from "lucide-react"
import {
  fetchChatSession,
  fetchChatSessions,
  type ChatSessionSummary,
  type CouncilSession,
} from "@/lib/council-live"
import { cn } from "@/lib/utils"
import { Sheet } from "./primitives"

export function ChatHistorySheet({
  open,
  onClose,
  groupPath,
}: {
  open: boolean
  onClose: () => void
  groupPath: string
}) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [selected, setSelected] = useState<CouncilSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open || !groupPath) return
    let cancelled = false
    async function load(initial = false) {
      if (initial) {
        setLoading(true)
        setSelected(null)
      }
      try {
        const data = await fetchChatSessions(groupPath)
        if (cancelled) return
        const nextSessions = data.sessions || []
        setSessions(nextSessions)
        setSelectedId((currentId) => (
          nextSessions.some((session) => session.id === currentId)
            ? currentId
            : nextSessions[0]?.id || ""
        ))
        setError("")
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      } finally {
        if (initial && !cancelled) setLoading(false)
      }
    }
    void load(true)
    const interval = window.setInterval(() => {
      void load()
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [open, groupPath])

  useEffect(() => {
    if (!open || !groupPath || !selectedId) return
    let cancelled = false
    async function loadDetail() {
      try {
        const data = await fetchChatSession(groupPath, selectedId)
        if (!cancelled) {
          setSelected(data.session || null)
          setError("")
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    }
    void loadDetail()
    const interval = window.setInterval(() => {
      void loadDetail()
    }, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [open, groupPath, selectedId])

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="聊天记录"
      description="读取当前小组真实保存的历史会话。"
      width="max-w-5xl"
    >
      {!groupPath ? (
        <EmptyText>请先选择一个本地小组。</EmptyText>
      ) : error ? (
        <EmptyText>{error}</EmptyText>
      ) : loading ? (
        <EmptyText>正在读取聊天记录...</EmptyText>
      ) : sessions.length ? (
        <div className="grid min-h-[28rem] grid-cols-[17rem_minmax(0,1fr)] gap-4">
          <div className="space-y-2 overflow-y-auto pr-1">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => setSelectedId(session.id)}
                className={cn(
                  "block w-full rounded-md border px-3 py-2.5 text-left transition-colors",
                  selectedId === session.id
                    ? "border-primary/40 bg-primary/10"
                    : "border-border hover:bg-accent",
                )}
              >
                <span className="line-clamp-2 text-[13px] font-medium text-foreground">
                  {session.question || "未命名会话"}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Clock className="size-3" />
                  {formatDateTime(session.createdAt)}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {session.rounds || 0} 轮 · {session.messageCount || 0} 条 · {formatDuration(session.durationMs)}
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 overflow-y-auto rounded-lg border border-border bg-background p-4">
            {selected ? <SessionDetail session={selected} /> : <EmptyText>选择一条历史记录查看内容。</EmptyText>}
          </div>
        </div>
      ) : (
        <EmptyText>当前小组还没有保存过聊天记录。</EmptyText>
      )}
    </Sheet>
  )
}

function SessionDetail({ session }: { session: CouncilSession }) {
  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <MessageSquareText className="size-3.5" />
          {formatDateTime(session.createdAt)}
          <span>总用时 {formatDuration(session.durationMs)}</span>
        </div>
        <h3 className="mt-2 text-sm font-semibold text-foreground">
          {session.question || "未命名会话"}
        </h3>
      </header>

      <div className="space-y-2">
        {sessionTranscriptMessages(session).map((message, index) => (
          <div key={`${message.agentId}-${message.createdAt}-${index}`} className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{message.agentName || message.agentId}</span>
              <span>{formatDateTime(message.createdAt)}</span>
              <span>{formatDuration(message.durationMs)}</span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
              {messageText(message)}
            </p>
          </div>
        ))}
      </div>

      {session.finalDecision?.answer ? (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2.5">
          <div className="text-xs font-medium text-success">最终决议 · {formatDuration(session.finalDecision.durationMs)}</div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">
            {session.finalDecision.answer}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function sessionTranscriptMessages(session: CouncilSession) {
  return [
    ...(session.interimMessages || []),
    ...(session.messages || []),
  ].sort((a, b) => {
    const time = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    if (time) return time
    return Number(a.modelCallIndex || 0) - Number(b.modelCallIndex || 0)
  })
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border px-4 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function messageText(message: NonNullable<CouncilSession["messages"]>[number]) {
  return String(
    message.response?.argument ||
      message.response?.reason ||
      message.displayText ||
      "",
  ).trim() || "（无正文）"
}

function formatDateTime(value?: string) {
  const date = value ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return "时间未知"
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDuration(value?: number) {
  const ms = Math.max(0, Number(value || 0))
  if (!ms) return "用时未知"
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (!minutes) return `${seconds}秒`
  return `${minutes}分${seconds}秒`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
