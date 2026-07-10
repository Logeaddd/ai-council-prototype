"use client"

import { useEffect, useState } from "react"
import { ChevronDown, FileText, FolderOpen, Lock, Paperclip, Pause, Send, StepForward, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentMember, FileAttachment } from "@/lib/council-data"
import { importProjectFolder, pickProjectFolder } from "@/lib/council-live"

const MAX_FILE_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 256 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 768 * 1024
const DRAFT_PREFIX = "ai-council:draft:"
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".sh",
  ".ps1",
  ".sql",
  ".csv",
  ".log",
])

type LocalAttachment = FileAttachment & { id: string }

function readDraft(draftKey: string) {
  if (!draftKey || typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(`${DRAFT_PREFIX}${draftKey}`) || ""
  } catch {
    return ""
  }
}

export function Composer({
  members,
  running,
  draftKey,
  onSend,
  onStop,
  onContinue,
}: {
  members: AgentMember[]
  running: boolean
  draftKey: string
  onSend: (text: string, options: { privateMode: boolean; targetId: string; attachments: FileAttachment[] }) => Promise<void> | void
  onStop: () => void
  onContinue: () => void
}) {
  const [value, setValue] = useState("")
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [privateMode, setPrivateMode] = useState(false)
  const [target, setTarget] = useState(members[0]?.id || "")
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [fileError, setFileError] = useState("")
  const [fileNotice, setFileNotice] = useState("")
  const [importingProject, setImportingProject] = useState(false)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setValue(readDraft(draftKey))
      setDraftLoaded(true)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [draftKey])

  useEffect(() => {
    if (!draftKey || !draftLoaded) return
    try {
      const key = `${DRAFT_PREFIX}${draftKey}`
      if (value.trim()) localStorage.setItem(key, value)
      else localStorage.removeItem(key)
    } catch {
      // Draft persistence is best-effort local UI state.
    }
  }, [draftKey, draftLoaded, value])

  const effectiveTarget = members.some((member) => member.id === target) ? target : members[0]?.id || ""
  const targetMember = members.find((member) => member.id === effectiveTarget)
  const sendDisabled = sending || (!value.trim() && !attachments.length) || !members.length

  async function submit() {
    const text = value.trim() || `请阅读附件并给出建议：${attachments.map((file) => file.name).join("、")}`
    if (!text || sendDisabled || running) return
    setSending(true)
    try {
      setValue("")
      const files = attachments.map(({ name, type, sizeBytes, content }) => ({ name, type, sizeBytes, content }))
      setAttachments([])
      setFileError("")
      await onSend(text, { privateMode, targetId: effectiveTarget, attachments: files })
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

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setFileError("")
    setFileNotice("")
    try {
      const selected = Array.from(files)
      if (attachments.length + selected.length > MAX_FILE_ATTACHMENTS) {
        throw new Error(`一次最多添加 ${MAX_FILE_ATTACHMENTS} 个文件`)
      }
      let totalBytes = attachments.reduce((sum, file) => sum + file.sizeBytes, 0)
      const nextFiles: LocalAttachment[] = []
      for (const file of selected) {
        if (!isTextFile(file)) throw new Error(`${file.name} 不是已支持的文本文件`)
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 256KB，先拆小一点再传`)
        totalBytes += file.size
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("附件总大小超过 768KB，先减少文件数量")
        const content = await file.text()
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) {
          throw new Error(`${file.name} 看起来不是纯文本，暂不读取`)
        }
        nextFiles.push({
          id: `${file.name}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          type: file.type || "text/plain",
          sizeBytes: file.size,
          content,
        })
      }
      setAttachments((current) => [...current, ...nextFiles])
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleProjectFolder() {
    if (running || sending || importingProject) return
    setFileError("")
    setFileNotice("")
    setImportingProject(true)
    try {
      const picked = await pickProjectFolder()
      if (!picked.supported) throw new Error("当前系统暂不支持选择项目文件夹")
      if (!picked.path) return
      const imported = await importProjectFolder(picked.path)
      const files = imported.attachments.map((file, index) => ({
        ...file,
        id: `project-${picked.path}-${index}-${Math.random().toString(36).slice(2)}`,
      }))
      if (attachments.length + files.length > MAX_FILE_ATTACHMENTS) {
        throw new Error(`导入项目会超过 ${MAX_FILE_ATTACHMENTS} 个附件，请先移除一些附件`)
      }
      const totalBytes = [...attachments, ...files].reduce((sum, file) => sum + file.sizeBytes, 0)
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new Error("导入项目内容超过 768KB，请先减少已有附件")
      }
      setAttachments((current) => [...current, ...files])
      setFileNotice(`已导入项目：${shortPath(imported.root)}，读取 ${imported.importedFiles} 个文件，目录${imported.treeTruncated ? "已截断" : "已载入"}`)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    } finally {
      setImportingProject(false)
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((file) => file.id !== id))
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
                value={effectiveTarget}
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
            <label
              className={cn(
                "inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                running || sending ? "pointer-events-none opacity-45" : "",
              )}
              title="添加文本文件"
              aria-label="添加文本文件"
            >
              <Paperclip className="size-4" />
              <input
                type="file"
                multiple
                className="hidden"
                accept=".txt,.md,.markdown,.json,.jsonl,.js,.jsx,.ts,.tsx,.css,.scss,.html,.htm,.xml,.yaml,.yml,.py,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.sh,.ps1,.sql,.csv,.log,text/*,application/json"
                disabled={running || sending}
                onChange={(event) => {
                  handleFiles(event.target.files)
                  event.currentTarget.value = ""
                }}
              />
            </label>
            <button
              type="button"
              disabled={running || sending || importingProject}
              onClick={handleProjectFolder}
              className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              title="导入项目文件夹"
              aria-label="导入项目文件夹"
            >
              <FolderOpen className="size-4" />
            </button>
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

        {attachments.length || fileError || fileNotice ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
            {attachments.map((file) => (
              <span
                key={file.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs text-foreground"
                title={`${file.name} · ${formatBytes(file.sizeBytes)}`}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="max-w-44 truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(file.id)}
                  className="ml-0.5 inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={`移除 ${file.name}`}
                  title="移除"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {fileNotice ? <span className="text-xs text-success">{fileNotice}</span> : null}
            {fileError ? <span className="text-xs text-danger">{fileError}</span> : null}
          </div>
        ) : null}

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

function isTextFile(file: File) {
  if (file.type.startsWith("text/")) return true
  if (["application/json", "application/x-ndjson"].includes(file.type)) return true
  const lower = file.name.toLowerCase()
  return [...TEXT_EXTENSIONS].some((extension) => lower.endsWith(extension))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

function shortPath(value: string) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts.slice(-2).join("/") || value
}
