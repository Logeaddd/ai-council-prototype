"use client"

import { useEffect, useState } from "react"
import { Lock, Send } from "lucide-react"
import type { AgentMember } from "@/lib/council-data"
import { api, type WorkspaceGroup } from "@/lib/council-live"
import { Sheet } from "./primitives"

type PrivateMessage = {
  id: string
  from: string
  seatId: string
  text: string
  createdAt: string
  status?: string
}

const DRAFT_PREFIX = "ai-council:private-draft:"

export function PrivateChatSheet({
  open,
  onClose,
  groupPath,
  members,
  runtimeGroup,
}: {
  open: boolean
  onClose: () => void
  groupPath: string
  members: AgentMember[]
  runtimeGroup: WorkspaceGroup | null
}) {
  const [seatId, setSeatId] = useState("")
  const [messages, setMessages] = useState<PrivateMessage[]>([])
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")

  const targetId = members.some((member) => member.id === seatId) ? seatId : members[0]?.id || ""
  const draftKey = `${DRAFT_PREFIX}${groupPath}:${targetId}`

  useEffect(() => {
    if (!open || !groupPath || !targetId) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError("")
      try {
        const result = await api<{ messages?: PrivateMessage[] }>(`/api/private-chat?groupPath=${encodeURIComponent(groupPath)}&seatId=${encodeURIComponent(targetId)}`)
        if (!cancelled) setMessages((result.messages || []).slice().reverse())
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const frame = window.requestAnimationFrame(() => {
      try {
        setValue(window.localStorage.getItem(draftKey) || "")
      } catch {
        setValue("")
      }
    })
    void load()
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [open, groupPath, targetId, draftKey])

  useEffect(() => {
    if (!open || !draftKey) return
    try {
      if (value.trim()) window.localStorage.setItem(draftKey, value)
      else window.localStorage.removeItem(draftKey)
    } catch {
      // Private drafts are a local convenience only.
    }
  }, [open, draftKey, value])

  async function send() {
    const text = value.trim()
    if (!text || !groupPath || !targetId || !runtimeGroup || sending) return
    setSending(true)
    setError("")
    try {
      setValue("")
      await api("/api/private-chat", {
        groupPath,
        seatId: targetId,
        text,
        runtimeGroup,
      })
      const result = await api<{ messages?: PrivateMessage[] }>(`/api/private-chat?groupPath=${encodeURIComponent(groupPath)}&seatId=${encodeURIComponent(targetId)}`)
      setMessages((result.messages || []).slice().reverse())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSending(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="私聊" width="max-w-xl">
      {!groupPath || !members.length ? (
        <p className="text-sm text-muted-foreground">请先选择一个有成员的小组。</p>
      ) : (
        <div className="flex min-h-[32rem] flex-col gap-3">
          <select
            value={targetId}
            onChange={(event) => setSeatId(event.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus:border-ring focus:outline-none"
          >
            {members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.model}</option>)}
          </select>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-md border border-border bg-background p-3">
            {loading ? <p className="text-sm text-muted-foreground">读取中...</p> : null}
            {!loading && !messages.length ? <p className="text-sm text-muted-foreground">还没有私聊记录。</p> : null}
            {messages.map((message) => {
              const mine = message.from === "boss"
              return (
                <div key={message.id} className={mine ? "ml-10 rounded-md bg-primary px-3 py-2 text-primary-foreground" : "mr-10 rounded-md border border-border bg-card px-3 py-2 text-foreground"}>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
                  <p className={mine ? "mt-1 text-[10px] text-primary-foreground/70" : "mt-1 text-[10px] text-muted-foreground"}>{formatTime(message.createdAt)}</p>
                </div>
              )
            })}
          </div>
          <div className="flex items-end gap-2 rounded-md border border-info/40 bg-info/5 p-2">
            <Lock className="mb-2 size-4 shrink-0 text-info" />
            <textarea
              rows={2}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder="发送给当前成员..."
              className="min-h-12 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button type="button" onClick={() => void send()} disabled={sending || !value.trim() || !runtimeGroup} className="inline-flex size-9 items-center justify-center rounded-md bg-info text-info-foreground disabled:cursor-not-allowed disabled:opacity-45" title="发送" aria-label="发送">
              <Send className="size-4" />
            </button>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      )}
    </Sheet>
  )
}

function formatTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  return date.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
