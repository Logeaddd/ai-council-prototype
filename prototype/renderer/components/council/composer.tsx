"use client"

import { useEffect, useState } from "react"
import { ChevronDown, Lock, Pause, Send, StepForward } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentMember } from "@/lib/council-data"

export function Composer({
  members,
  running,
  onSend,
  onStop,
  onContinue,
}: {
  members: AgentMember[]
  running: boolean
  onSend: (text: string, options: { privateMode: boolean; targetId: string }) => Promise<void> | void
  onStop: () => void
  onContinue: () => void
}) {
  const [value, setValue] = useState("")
  const [privateMode, setPrivateMode] = useState(false)
  const [target, setTarget] = useState(members[0]?.id || "")
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!members.length) {
      setTarget("")
      return
    }
    if (!members.some((member) => member.id === target)) {
      setTarget(members[0].id)
    }
  }, [members, target])

  const targetMember = members.find((member) => member.id === target)
  const sendDisabled = sending || !value.trim() || !members.length

  async function submit() {
    const text = value.trim()
    if (!text || sendDisabled || running) return
    setSending(true)
    try {
      setValue("")
      await onSend(text, { privateMode, targetId: target || members[0]?.id || "" })
    } finally {
      setSending(false)
    }
  }

  function handlePrimaryAction() {
    if (running) {
      onStop()
      return
    }
    submit()
  }

  return (
    <div className="shrink-0 border-t border-border bg-card/60 px-4 py-3">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-md border border-border bg-secondary/60 p-0.5">
            <button
              type="button"
              onClick={() => setPrivateMode(false)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                !privateMode
                  ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              向全体提问
            </button>
            <button
              type="button"
              onClick={() => setPrivateMode(true)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors",
                privateMode
                  ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Lock className="size-3" />
              私聊单个成员
            </button>
          </div>

          {privateMode ? (
            <div className="relative">
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                className="h-7 appearance-none rounded-md border border-info/40 bg-info/5 pl-2.5 pr-7 text-xs font-medium text-foreground focus:border-ring focus:outline-none"
              >
                {members.map((member) => (
                  <option
                    key={member.id}
                    value={member.id}
                    className="bg-popover text-foreground"
                  >
                    {member.name} · {member.model}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "flex items-end gap-2 rounded-lg border bg-background p-2 transition-colors focus-within:border-ring",
            privateMode ? "border-info/40" : "border-border",
          )}
        >
          <textarea
            rows={2}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={
              privateMode
                ? `只有 ${targetMember?.name || "该成员"} 可见的私聊消息，其他成员不会收到...`
                : "向议会提出问题或下达任务，回车发送，Shift+回车换行..."
            }
            className="max-h-32 min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={sending || running}
              onClick={onContinue}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              title="继续上一轮"
            >
              <StepForward className="size-3.5" />
              继续
            </button>
            <button
              type="button"
              disabled={!running && sendDisabled}
              onClick={handlePrimaryAction}
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-md text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45",
                running
                  ? "bg-danger/15 text-danger hover:bg-danger/25"
                  : privateMode
                    ? "bg-info text-info-foreground"
                    : "bg-primary text-primary-foreground",
              )}
              aria-label={running ? "暂停" : privateMode ? "私密发送" : "发送"}
              title={running ? "暂停" : privateMode ? "私密发送" : "发送"}
            >
              {running ? (
                <Pause className="size-4 fill-current" />
              ) : privateMode ? (
                <Lock className="size-4" />
              ) : (
                <Send className="size-4" />
              )}
            </button>
          </div>
        </div>

        {privateMode ? (
          <p className="mt-1.5 flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
            <Lock className="size-3 text-info" />
            私聊会写入该成员的私有记录，并在公开对话里只显示一条提示，不泄露正文。
          </p>
        ) : null}
      </div>
    </div>
  )
}
