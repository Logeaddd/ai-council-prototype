"use client"

import { useEffect, useRef, useState } from "react"
import { FileText, Lock, Paperclip, Pause, Send, StepForward, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentMember, FileAttachment } from "@/lib/council-data"
import { importProjectFolder } from "@/lib/council-live"
import { readDroppedDirectory } from "@/lib/drop-import.mjs"

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

type DroppedEntry = {
  isDirectory: boolean
  isFile: boolean
  name: string
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void
  createReader?: () => {
    readEntries: (
      success: (entries: DroppedEntry[]) => void,
      failure?: (error: DOMException) => void,
    ) => void
  }
}

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
  onOpenPrivateChat,
  onStop,
  onContinue,
}: {
  members: AgentMember[]
  running: boolean
  draftKey: string
  onSend: (text: string, options: { attachments: FileAttachment[] }) => Promise<void> | void
  onOpenPrivateChat: () => void
  onStop: () => void
  onContinue: () => void
}) {
  const [value, setValue] = useState("")
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [fileError, setFileError] = useState("")
  const [fileNotice, setFileNotice] = useState("")
  const [importingProject, setImportingProject] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const dragDepth = useRef(0)

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

  const sendDisabled = sending || (!value.trim() && !attachments.length) || !members.length

  async function submit() {
    const text = value.trim() || `请阅读附件并给出建议：${attachments.map((file) => file.name).join("、")}`
    if (!text || sendDisabled || running) return
    setSending(true)
    try {
      setValue("")
      const files = attachments.map(({ name, type, sizeBytes, content, localPath }) => ({ name, type, sizeBytes, content, localPath }))
      setAttachments([])
      setFileError("")
      await onSend(text, { attachments: files })
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
      const nextFiles = await readLocalAttachments(Array.from(files), attachments)
      setAttachments((current) => [...current, ...nextFiles])
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleDrop(dataTransfer: DataTransfer) {
    if (running || sending || importingProject) return
    setFileError("")
    setFileNotice("")
    setImportingProject(true)
    try {
      const droppedFiles: File[] = []
      const folderPaths: string[] = []
      const browserFolders: DroppedEntry[] = []

      for (const item of Array.from(dataTransfer.items || [])) {
        if (item.kind !== "file") continue
        const entry = getDroppedEntry(item)
        const file = item.getAsFile()
        if (entry?.isDirectory) {
          const folderPath = file ? getDesktopFilePath(file) : ""
          if (folderPath) folderPaths.push(folderPath)
          else browserFolders.push(entry)
        } else if (file) {
          droppedFiles.push(file)
        }
      }

      if (!dataTransfer.items?.length) droppedFiles.push(...Array.from(dataTransfer.files || []))

      const nextAttachments = [...attachments]
      const notices: string[] = []

      for (const folderPath of [...new Set(folderPaths)]) {
        const imported = await importProjectFolder(folderPath)
        const projectFiles = imported.attachments.map((file, index) => ({
          ...file,
          id: `project-${folderPath}-${index}-${Math.random().toString(36).slice(2)}`,
        }))
        validateAttachmentBatch(nextAttachments, projectFiles, "导入项目")
        nextAttachments.push(...projectFiles)
        notices.push(`已导入 ${shortPath(imported.root)}：${imported.importedFiles} 个文件`)
      }

      for (const entry of browserFolders) {
        const remaining = Math.max(0, MAX_FILE_ATTACHMENTS - nextAttachments.length)
        if (!remaining) throw new Error(`一次最多添加 ${MAX_FILE_ATTACHMENTS} 个文件`)
        const folderFiles = await readDroppedDirectory(entry, remaining)
        droppedFiles.push(...folderFiles.files)
        notices.push(`${entry.name}：读取 ${folderFiles.files.length} 个文件${folderFiles.truncated ? "，其余未载入" : ""}`)
      }

      if (droppedFiles.length) {
        const localFiles = await readLocalAttachments(droppedFiles, nextAttachments)
        nextAttachments.push(...localFiles)
      }

      if (nextAttachments.length === attachments.length) {
        throw new Error("没有读取到可导入的文件")
      }
      setAttachments(nextAttachments)
      setFileNotice(notices.join("；"))
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
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">向全体提问</span>
          <button
            type="button"
            onClick={onOpenPrivateChat}
            disabled={!members.length}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Lock className="size-3" />
            私聊
          </button>
        </div>

        <div
          onDragEnter={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepth.current += 1
            setDraggingFiles(true)
          }}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "copy"
          }}
          onDragLeave={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepth.current = Math.max(0, dragDepth.current - 1)
            if (!dragDepth.current) setDraggingFiles(false)
          }}
          onDrop={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepth.current = 0
            setDraggingFiles(false)
            handleDrop(event.dataTransfer)
          }}
          className={cn(
            "flex items-end gap-2 rounded-lg border bg-background p-2 transition-colors focus-within:border-ring",
            draggingFiles
              ? "border-primary ring-2 ring-primary/20"
              : "border-border",
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
              "向议会提出问题或下达任务，回车发送，Shift+回车换行..."
            }
            className="max-h-32 min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <label
              className={cn(
                "inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                running || sending || importingProject ? "pointer-events-none opacity-45" : "",
              )}
              title="添加文件"
              aria-label="添加文件"
            >
              <Paperclip className="size-4" />
              <input
                type="file"
                multiple
                className="hidden"
                accept=".txt,.md,.markdown,.json,.jsonl,.js,.jsx,.ts,.tsx,.css,.scss,.html,.htm,.xml,.yaml,.yml,.py,.java,.c,.cpp,.cs,.go,.rs,.php,.rb,.sh,.ps1,.sql,.csv,.log,text/*,application/json"
                disabled={running || sending || importingProject}
                onChange={(event) => {
                  handleFiles(event.target.files)
                  event.currentTarget.value = ""
                }}
              />
            </label>
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
                running ? "bg-danger/15 text-danger hover:bg-danger/25" : "bg-primary text-primary-foreground",
              )}
              aria-label={running ? "暂停" : "发送"}
              title={running ? "暂停" : "发送"}
            >
              {running ? (
                <Pause className="size-4 fill-current" />
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
      </div>
    </div>
  )
}

async function readLocalAttachments(files: File[], current: LocalAttachment[]) {
  if (current.length + files.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`一次最多添加 ${MAX_FILE_ATTACHMENTS} 个文件`)
  }
  let totalBytes = current.reduce((sum, file) => sum + file.sizeBytes, 0)
  const nextFiles: LocalAttachment[] = []
  for (const file of files) {
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
      localPath: getDesktopFilePath(file) || undefined,
    })
  }
  return nextFiles
}

function validateAttachmentBatch(current: LocalAttachment[], next: LocalAttachment[], label: string) {
  if (current.length + next.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`${label}会超过 ${MAX_FILE_ATTACHMENTS} 个附件，请先移除一些附件`)
  }
  const totalBytes = [...current, ...next].reduce((sum, file) => sum + file.sizeBytes, 0)
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`${label}内容超过 768KB，请先减少已有附件`)
  }
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types || []).includes("Files")
}

function getDroppedEntry(item: DataTransferItem) {
  const legacyItem = item as DataTransferItem & {
    webkitGetAsEntry?: () => DroppedEntry | null
  }
  return legacyItem.webkitGetAsEntry?.() || null
}

function getDesktopFilePath(file: File) {
  const desktopWindow = window as Window & {
    aiCouncilDesktop?: {
      getPathForFile: (file: File) => string
    }
  }
  return desktopWindow.aiCouncilDesktop?.getPathForFile(file) || ""
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
