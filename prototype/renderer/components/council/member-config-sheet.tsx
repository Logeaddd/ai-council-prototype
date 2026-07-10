"use client"

import { useState } from "react"
import { Cpu, KeyRound, Wifi } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  providerPresets,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  ROLE_LABEL,
  type AgentMember,
  type Permission,
  type Role,
  type WorkMode,
} from "@/lib/council-data"
import type {
  ModelDiscoveryResult,
  ProviderHealthResult,
  ProviderPresetRecord,
} from "@/lib/council-live"
import { Field, Sheet, inputClass } from "./primitives"

export function MemberConfigSheet({
  member,
  creating = false,
  workMode,
  providers,
  onSave,
  onDiscoverModels,
  onCheckProviderHealth,
  onClose,
}: {
  member?: AgentMember
  creating?: boolean
  workMode: WorkMode
  providers: ProviderPresetRecord[]
  onSave: (values: {
    memberId: string
    name: string
    providerId: string
    baseUrl: string
    model: string
    apiKey?: string
    permission: Permission
    role: Role
    reviewIntensity: 1 | 2 | 3
    reasoningEffort?: string
  }) => Promise<void> | void
  onDiscoverModels: (values: {
    providerId: string
    baseUrl: string
    apiKey?: string
  }) => Promise<ModelDiscoveryResult>
  onCheckProviderHealth: (values: {
    providerId: string
    baseUrl: string
    apiKey?: string
  }) => Promise<ProviderHealthResult>
  onClose: () => void
}) {
  const providerOptions: ProviderPresetRecord[] = providers.length > 0
    ? providers
    : providerPresets.map((p) => ({
        id: p.id,
        label: p.name,
        name: p.name,
        officialBaseUrl: p.baseUrl,
        baseUrl: p.baseUrl,
        defaultModel: p.models[0] || "",
        models: p.models,
        customUrl: p.id === "custom",
      }))
  const initial = initialMemberForm(member, providerOptions)
  const [name, setName] = useState(initial.name)
  const [providerId, setProviderId] = useState(initial.providerId)
  const [model, setModel] = useState(initial.model)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [apiKey, setApiKey] = useState("")
  const [permission, setPermission] = useState<Permission>(initial.permission)
  const [role, setRole] = useState<Role>(initial.role)
  const [intensity, setIntensity] = useState<1 | 2 | 3>(initial.intensity)
  const [reasoningEffort, setReasoningEffort] = useState(initial.reasoningEffort)
  const [discovered, setDiscovered] = useState<string[]>([])
  const [discoveryStatus, setDiscoveryStatus] = useState("")
  const [discovering, setDiscovering] = useState(false)
  const [healthStatus, setHealthStatus] = useState("")
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [saving, setSaving] = useState(false)
  const preset = providerOptions.find((p) => p.id === providerId)
  const presetModels = preset?.models || (preset?.defaultModel ? [preset.defaultModel] : [])
  const modelOptions = discovered.length > 0 ? discovered : presetModels
  const keyless = Boolean(
    preset?.keyless || providerPresets.find((p) => p.id === providerId)?.keyless,
  )
  const reasoningSupported = supportsReasoningEffort(providerId, baseUrl, model)

  async function save() {
    if (!member || saving) return
    setSaving(true)
    try {
      await onSave({
        memberId: member.id,
        name,
        providerId,
        baseUrl,
        model,
        apiKey: keyless ? undefined : apiKey.trim() || undefined,
        permission,
        role,
        reviewIntensity: intensity,
        reasoningEffort,
      })
    } finally {
      setSaving(false)
    }
  }

  async function discover() {
    if (discovering) return
    setDiscovering(true)
    setDiscoveryStatus("正在检测模型...")
    try {
      const result = await onDiscoverModels({
        providerId,
        baseUrl,
        apiKey: keyless ? undefined : apiKey.trim() || undefined,
      })
      const models = result.models.map((item) => item.id).filter(Boolean)
      setDiscovered(models)
      if (result.defaultModel && !model) setModel(result.defaultModel)
      setDiscoveryStatus(
        result.ok
          ? `已发现 ${models.length} 个模型，来源：${sourceLabel(result.source)}`
          : `发现失败，来源：${sourceLabel(result.source)}；${result.error || "没有返回模型"}`,
      )
    } catch (error) {
      setDiscoveryStatus(`发现失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDiscovering(false)
    }
  }

  async function checkHealth() {
    if (checkingHealth) return
    setCheckingHealth(true)
    setHealthStatus("正在检测可用性...")
    try {
      const result = await onCheckProviderHealth({
        providerId,
        baseUrl,
        apiKey: keyless ? undefined : apiKey.trim() || undefined,
      })
      setHealthStatus(
        result.ok
          ? `可用，来源：${sourceLabel(result.source)}；模型数：${result.modelCount ?? 0}`
          : `不可用，来源：${sourceLabel(result.source)}；${result.error || "没有通过健康检测"}`,
      )
      if (result.defaultModel && !model) setModel(result.defaultModel)
    } catch (error) {
      setHealthStatus(`检测失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCheckingHealth(false)
    }
  }

  return (
    <Sheet
      open={!!member}
      onClose={onClose}
      title={creating ? "添加成员" : member ? `配置成员 · ${member.name}` : "配置成员"}
      description={
        creating
          ? "先填好模型、密钥、权限和角色，保存后才会加入小组。"
          : "模型、密钥、权限与角色均按成员独立配置。"
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {saving ? "保存中..." : creating ? "创建成员" : "保存配置"}
          </button>
        </div>
      }
    >
      {member ? (
        <div className="space-y-5">
          <Field label="成员名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="模型供应商">
            <div className="grid grid-cols-2 gap-2">
              {providerOptions.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProviderId(p.id)
                    setBaseUrl(p.officialBaseUrl || p.baseUrl || "")
                    const defaultModel = p.defaultModel || p.models?.[0]
                    if (defaultModel) setModel(defaultModel)
                    setDiscovered([])
                    setDiscoveryStatus("")
                    setHealthStatus("")
                  }}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    providerId === p.id
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {p.label || p.name || p.id}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="接口地址"
            hint="中转 / 兼容接口通常填到 /v1，例如 https://code-plan.site/v1。本地模型可填 localhost。"
          >
            <div className="flex gap-2">
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setHealthStatus("")
                }}
                placeholder="https://api.example.com/v1"
                className={cn(inputClass, "font-mono")}
              />
              <button
                type="button"
                onClick={checkHealth}
                disabled={checkingHealth}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Wifi className="size-3.5" />
                检测可用性
              </button>
            </div>
            {healthStatus ? (
              <p className="mt-2 text-[11px] text-muted-foreground">{healthStatus}</p>
            ) : null}
          </Field>

          <Field label="模型名称">
            <div className="flex gap-2">
              <input
                value={model}
                onChange={(e) => {
                  setModel(e.target.value)
                  setHealthStatus("")
                }}
                className={cn(inputClass, "font-mono")}
              />
              <button
                type="button"
                onClick={discover}
                disabled={discovering}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Cpu className="size-3.5" />
                发现模型
              </button>
            </div>
            {discoveryStatus ? (
              <p className="mt-2 text-[11px] text-muted-foreground">{discoveryStatus}</p>
            ) : null}
            {modelOptions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {modelOptions.map((mm) => (
                  <button
                    key={mm}
                    onClick={() => setModel(mm)}
                    className={cn(
                      "rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                      model === mm
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mm}
                  </button>
                ))}
              </div>
            ) : null}
          </Field>

          <Field
            label="推理强度"
            hint={
              reasoningSupported
                ? "只给支持该字段的模型发送，关闭时不会发送推理参数。"
                : "当前供应商或模型未确认支持，保存后也不会发送推理参数。"
            }
          >
            <div className="grid grid-cols-4 gap-2">
              {[
                { value: "", label: "关闭" },
                { value: "low", label: "低" },
                { value: "medium", label: "中" },
                { value: "high", label: "高" },
              ].map((item) => (
                <button
                  key={item.value || "off"}
                  onClick={() => setReasoningEffort(item.value)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[13px] transition-colors",
                    reasoningEffort === item.value
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="API 密钥"
            hint={
              keyless
                ? "该供应商为本地 / 无需密钥。"
                : "密钥仅保存在本地，不会进入对话记录。"
            }
          >
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="password"
                disabled={keyless}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setHealthStatus("")
                }}
                placeholder={
                  keyless
                    ? "无需密钥"
                    : member.apiKey === "set"
                      ? "留空表示不修改已有密钥"
                      : "sk-…"
                }
                className={cn(inputClass, "pl-8 font-mono disabled:opacity-50")}
              />
            </div>
          </Field>

          <Field label="权限范围">
            <div className="space-y-1.5">
              {(["text", "tool", "full"] as Permission[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPermission(p)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                    permission === p
                      ? "border-primary/40 bg-primary/10"
                      : "border-border hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 rounded-full border",
                      permission === p
                        ? "border-primary bg-primary"
                        : "border-muted-foreground",
                    )}
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-foreground">
                      {PERMISSION_LABEL[p]}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {PERMISSION_HINT[p]}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="角色">
            <div className="grid grid-cols-3 gap-2">
              {(["ordinary", "reviewer", "summarizer"] as Role[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[13px] transition-colors",
                    role === r
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {roleLabel(r, workMode)}
                </button>
              ))}
            </div>
          </Field>

          {role === "reviewer" ? (
            <Field
              label="审查强度"
              hint={
                workMode === "independent"
                  ? "强度越高，监督员越严格，越容易判定为「需修订 / 有风险」。"
                  : "强度越高，审查者越严格，越容易判定为「需修订 / 有风险」。"
              }
            >
              <div className="flex items-center gap-2">
                {([1, 2, 3] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => setIntensity(n)}
                    className={cn(
                      "flex-1 rounded-md border py-1.5 text-[13px] font-semibold tabular-nums transition-colors",
                      intensity === n
                        ? "border-warning/40 bg-warning/10 text-warning"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {n === 1 ? "宽松" : n === 2 ? "标准" : "严格"}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  )
}

function initialMemberForm(member: AgentMember | undefined, providers: ProviderPresetRecord[]) {
  const preset = member
    ? providers.find((item) => item.id === member.provider || item.label === member.provider || item.name === member.provider) ?? providers[0]
    : providers[0]
  return {
    name: member?.name || "",
    providerId: preset?.id || "openai",
    model: member?.model || "",
    baseUrl: member?.baseUrl || preset?.officialBaseUrl || preset?.baseUrl || "",
    permission: (member?.permission || "text") as Permission,
    role: (member?.role || "ordinary") as Role,
    intensity: (member?.reviewIntensity || 2) as 1 | 2 | 3,
    reasoningEffort: member?.reasoningEffort || "",
  }
}

function sourceLabel(source: string) {
  if (source === "real_response") return "真实响应"
  if (source === "cache") return "缓存"
  if (source === "timeout_inference") return "超时推断"
  if (source === "error") return "错误"
  return source || "未知"
}

function roleLabel(role: Role, workMode: WorkMode) {
  if (role === "reviewer" && workMode === "independent") return "监督员"
  return ROLE_LABEL[role]
}

function supportsReasoningEffort(providerId: string, baseUrl: string, model: string) {
  const provider = String(providerId || "").toLowerCase()
  const url = String(baseUrl || "").toLowerCase()
  const name = String(model || "").toLowerCase()
  if ((provider === "openai" || url.includes("api.openai.com")) && /^(o1|o3|o4|gpt-5|gpt-oss)\b/.test(name)) {
    return true
  }
  if ((provider === "anthropic" || url.includes("api.anthropic.com")) && /^claude-(3-7|4|opus-4|sonnet-4)/.test(name)) {
    return true
  }
  return false
}
