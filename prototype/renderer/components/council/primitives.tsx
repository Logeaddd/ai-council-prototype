"use client"

import type React from "react"
import { useEffect } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type AgentState,
  type DecisionState,
  STATE_LABEL,
} from "@/lib/council-data"

/* ----------------------------- Segmented control ---------------------------- */

interface SegOption<T extends string> {
  value: T
  label: string
  icon?: React.ComponentType<{ className?: string }>
  disabled?: boolean
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  size?: "sm" | "md"
  className?: string
  ariaLabel?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-secondary/60 p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={opt.disabled}
            onClick={() => {
              if (!opt.disabled) onChange(opt.value)
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors",
              size === "sm"
                ? "px-2 py-1 text-xs"
                : "px-3 py-1.5 text-[13px]",
              active
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
              opt.disabled && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* --------------------------------- Icon button ------------------------------ */

export function IconButton({
  label,
  active,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "border-border bg-accent text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

/* ----------------------------------- Sheet ---------------------------------- */

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "right",
  width = "max-w-md",
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  side?: "right" | "center"
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 flex w-full flex-col border-border bg-card shadow-2xl",
          side === "right"
            ? cn("ml-auto h-full border-l", width)
            : cn("m-auto max-h-[88vh] rounded-xl border", width),
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="border-t border-border px-5 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  )
}

/* -------------------------------- State dot/pill ---------------------------- */

const STATE_TONE: Record<AgentState, string> = {
  idle: "bg-muted-foreground/50",
  thinking: "bg-info",
  speaking: "bg-primary",
  completed: "bg-success",
  skipped: "bg-muted-foreground/40",
  unavailable: "bg-danger",
}

export function StateDot({
  state,
  className,
}: {
  state: AgentState
  className?: string
}) {
  const pulse = state === "speaking" || state === "thinking"
  return (
    <span className={cn("relative inline-flex size-2", className)}>
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            STATE_TONE[state],
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          STATE_TONE[state],
        )}
      />
    </span>
  )
}

export function StatePill({ state }: { state: AgentState }) {
  const tone: Record<AgentState, string> = {
    idle: "text-muted-foreground",
    thinking: "text-info",
    speaking: "text-primary",
    completed: "text-success",
    skipped: "text-muted-foreground",
    unavailable: "text-danger",
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", tone[state])}>
      <StateDot state={state} />
      {STATE_LABEL[state]}
    </span>
  )
}

/* ---------------------------------- Badge ----------------------------------- */

export type Tone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "info"
  | "danger"

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-border bg-secondary text-muted-foreground",
  primary: "border-primary/30 bg-primary/10 text-primary",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
  danger: "border-danger/30 bg-danger/10 text-danger",
}

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export const DECISION_TONE: Record<DecisionState, Tone> = {
  executable: "success",
  risky: "warning",
  revise: "info",
  diverged: "danger",
}

/* --------------------------------- Avatar ----------------------------------- */

const AVATAR_PALETTE = [
  "bg-primary/15 text-primary",
  "bg-info/15 text-info",
  "bg-success/15 text-success",
  "bg-warning/15 text-warning",
  "bg-danger/15 text-danger",
]

export function Avatar({
  name,
  id,
  size = "md",
  className,
}: {
  name: string
  id: string
  size?: "sm" | "md" | "lg"
  className?: string
}) {
  const idx =
    Math.abs(
      id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0),
    ) % AVATAR_PALETTE.length
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold uppercase",
        AVATAR_PALETTE[idx],
        size === "sm" && "size-6 text-[11px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-11 text-sm",
        className,
      )}
    >
      {name.slice(0, 2)}
    </span>
  )
}

/* --------------------------------- Field ------------------------------------ */

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}

export const inputClass =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
