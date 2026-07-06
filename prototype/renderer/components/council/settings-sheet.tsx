"use client"

import { useEffect, useState } from "react"
import { Users, UserCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WORK_MODE_HINT,
  WORK_MODE_LABEL,
  type WorkMode,
} from "@/lib/council-data"
import { Field, Sheet, inputClass } from "./primitives"

export function SettingsSheet({
  open,
  onClose,
  mode,
  onModeChange,
  globalRequirement,
  onGlobalRequirementChange,
  totalRounds,
  onTotalRoundsChange,
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
  onSave: (values: {
    mode: WorkMode
    globalRequirement: string
    totalRounds: number
  }) => Promise<void> | void
}) {
  const [text, setText] = useState(globalRequirement)

  useEffect(() => {
    setText(globalRequirement)
  }, [globalRequirement])

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="全局要求"
      description="这些设置会应用到当前议会组。"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={async () => {
              await onSave({ mode, globalRequirement: text, totalRounds })
              onGlobalRequirementChange(text)
              onClose()
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            保存
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field
          label="工作模式（AI 协作逻辑）"
          hint="影响成员之间是否可见彼此发言，以及审查流程。"
        >
          <div className="grid grid-cols-1 gap-2">
            {(
              [
                { value: "collab" as WorkMode, icon: Users },
                { value: "independent" as WorkMode, icon: UserCheck },
              ]
            ).map(({ value, icon: Icon }) => (
              <button
                key={value}
                onClick={() => onModeChange(value)}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors",
                  mode === value
                    ? "border-primary/40 bg-primary/10"
                    : "border-border hover:bg-accent",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    mode === value ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span>
                  <span className="block text-[13px] font-medium text-foreground">
                    {WORK_MODE_LABEL[value]}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {WORK_MODE_HINT[value]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="全局要求"
          hint="对全体成员生效的系统级约束，将注入每位成员的上下文。"
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className={cn(inputClass, "resize-none leading-relaxed")}
          />
        </Field>

        <Field label="最大讨论轮数" hint="达到上限后由总结者强制收敛结论。">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={100}
              value={totalRounds}
              onChange={(e) => onTotalRoundsChange(Number(e.target.value))}
              className="flex-1 accent-[var(--primary)]"
            />
            <span className="w-10 text-right font-mono text-sm tabular-nums text-foreground">
              {totalRounds}
            </span>
          </div>
        </Field>
      </div>
    </Sheet>
  )
}
