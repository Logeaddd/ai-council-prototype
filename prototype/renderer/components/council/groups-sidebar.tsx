"use client"

import { useMemo, useState } from "react"
import { Pin, Plus, Search, Sliders, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  WORK_MODE_LABEL,
  type Group,
} from "@/lib/council-data"
import { Badge, IconButton } from "./primitives"

export function GroupsSidebar({
  groups,
  selectedId,
  onSelect,
  onCreateGroup,
  onTogglePin,
  onDeleteGroup,
  onOpenInstructions,
}: {
  groups: Group[]
  selectedId: string
  onSelect: (id: string) => void
  onCreateGroup: () => void
  onTogglePin: (id: string) => void
  onDeleteGroup: (id: string) => void
  onOpenInstructions: () => void
}) {
  const [query, setQuery] = useState("")

  const { pinned, others } = useMemo(() => {
    const filtered = groups.filter((g) =>
      g.name.toLowerCase().includes(query.trim().toLowerCase()),
    )
    return {
      pinned: filtered.filter((g) => g.pinned),
      others: filtered.filter((g) => !g.pinned),
    }
  }, [groups, query])

  return (
    <nav className="flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-3">
        <img
          src="/logo.png"
          alt=""
          draggable={false}
          className="size-7 rounded-md object-contain"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            AI Council
          </p>
          <p className="truncate text-[11px] text-muted-foreground">智能议会</p>
        </div>
        <IconButton label="新建议会组" onClick={onCreateGroup}>
          <Plus className="size-4" />
        </IconButton>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索议会组…"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pinned.length > 0 && (
          <Section title="已置顶">
            {pinned.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                active={g.id === selectedId}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onDeleteGroup={onDeleteGroup}
              />
            ))}
          </Section>
        )}
        <Section title="全部议会组">
          {others.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              active={g.id === selectedId}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
              onDeleteGroup={onDeleteGroup}
            />
          ))}
          {others.length === 0 && pinned.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              没有匹配的议会组
            </p>
          )}
        </Section>
      </div>

      <div className="space-y-0.5 border-t border-sidebar-border px-2 py-2">
        <button
          onClick={onOpenInstructions}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Sliders className="size-4" />
          设置
        </button>
      </div>
    </nav>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2">
      <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function GroupRow({
  group,
  active,
  onSelect,
  onTogglePin,
  onDeleteGroup,
}: {
  group: Group
  active: boolean
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
  onDeleteGroup: (id: string) => void
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1 rounded-md px-2 py-2 text-left transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <span
        className={cn(
          "h-7 w-0.5 shrink-0 rounded-full",
          active ? "bg-primary" : "bg-transparent",
        )}
      />
      <button
        type="button"
        onClick={() => onSelect(group.id)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{group.name}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <Badge tone={group.mode === "collab" ? "primary" : "info"}>
            {WORK_MODE_LABEL[group.mode]}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {group.memberCount} 成员
          </span>
        </div>
      </button>
      <span
        className={cn(
          "hidden shrink-0 text-[11px] lg:inline",
          group.lastActive === "进行中"
            ? "text-success"
            : "text-muted-foreground",
        )}
      >
        {group.lastActive}
      </span>
      <button
        type="button"
        onClick={() => onTogglePin(group.id)}
        aria-label={group.pinned ? "取消置顶" : "置顶"}
        title={group.pinned ? "取消置顶" : "置顶"}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
          group.pinned
            ? "text-primary hover:bg-primary/10"
            : "text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover:opacity-100",
        )}
      >
        <Pin className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onDeleteGroup(group.id)}
        aria-label="删除小组"
        title="删除小组"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
