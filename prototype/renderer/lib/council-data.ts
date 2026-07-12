// Shared UI labels and empty runtime defaults.

export type WorkMode = "collab" | "independent"

export type VisualStyle = "workbench" | "roundtable"

export type AgentState =
  | "idle"
  | "thinking"
  | "speaking"
  | "skipped"
  | "unavailable"
  | "completed"

export type Permission = "text" | "tool" | "full"

export type Role = "ordinary" | "reviewer" | "summarizer"

export type ApiKeyStatus = "set" | "unset" | "local"

export interface AgentMember {
  id: string
  name: string
  role: Role
  provider: string
  model: string
  baseUrl: string
  apiKey: ApiKeyStatus
  permission: Permission
  state: AgentState
  reviewer: boolean
  reviewIntensity: 1 | 2 | 3
  reasoningEffort?: string
  tokensIn: number
  tokensOut: number
  latencyMs: number | null
  healthy: boolean
  muted?: boolean
}

export interface Group {
  id: string
  name: string
  mode: WorkMode
  pinned: boolean
  memberCount: number
  lastActive: string
}

export type TranscriptItem =
  | {
      kind: "round"
      id: string
      round: number
      totalRounds: number
    }
  | {
      kind: "message"
      id: string
      agentId: string
      visibility: "public" | "review" | "private-answer"
      time: string
      state: AgentState
      body: string
      tokens?: number
      durationMs?: number
    }
  | {
      kind: "private-hint"
      id: string
      agentId: string
      time: string
      preview: string
    }
  | {
      kind: "system"
      id: string
      time: string
      body: string
    }

export type DecisionState = "executable" | "risky" | "revise" | "diverged"

export interface Blocker {
  id: string
  raisedBy: string
  severity: "high" | "medium"
  title: string
  detail: string
}

export type FileOpStatus = "pending" | "approved" | "executed" | "restored" | "rejected"

export interface FileOperation {
  id: string
  path: string
  action: string
  status: FileOpStatus
  proposedBy: string
  commit?: string
  canRestore?: boolean
}

export interface UsageSummary {
  tokensTotal: number
  tokensBudget: number | null
  tokenAccounting: "estimated" | "provider_usage" | "mixed" | "unknown"
  costUsd: number | null
  costBudgetUsd: number | null
  costAccounting: "not_configured" | "estimated" | "configured"
  apiCalls: number
  apiErrors: number
  avgLatencyMs: number
}

export interface FileAttachment {
  name: string
  type: string
  sizeBytes: number
  content: string
  truncated?: boolean
  localPath?: string
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  transport?: string
  keyless?: boolean
  models: string[]
}

export const PERMISSION_LABEL: Record<Permission, string> = {
  text: "纯文本",
  tool: "工具授权",
  full: "完全允许",
}

export const PERMISSION_HINT: Record<Permission, string> = {
  text: "仅生成文本，不能调用任何工具或改动文件。",
  tool: "可调用受控工具，文件改动需经审批后执行。",
  full: "完全允许就是自主执行：可自动使用工具和执行安全文件操作，谨慎授予。",
}

export const ROLE_LABEL: Record<Role, string> = {
  ordinary: "成员",
  reviewer: "审查者",
  summarizer: "总结者",
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: "空闲",
  thinking: "思考中",
  speaking: "发言中",
  skipped: "已跳过",
  unavailable: "不可用",
  completed: "已完成",
}

export const API_KEY_LABEL: Record<ApiKeyStatus, string> = {
  set: "已设置",
  unset: "未设置",
  local: "本地模型",
}

export const DECISION_LABEL: Record<DecisionState, string> = {
  executable: "可执行",
  risky: "有风险",
  revise: "需修订",
  diverged: "未收敛",
}

export const FILEOP_STATUS_LABEL: Record<FileOpStatus, string> = {
  pending: "待审批",
  approved: "已批准",
  executed: "已执行",
  restored: "已恢复",
  rejected: "已拒绝",
}

export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  collab: "协作讨论",
  independent: "监考模式",
}

export const WORK_MODE_HINT: Record<WorkMode, string> = {
  collab: "成员可见彼此公开发言，相互讨论、补充与反驳。",
  independent: "成员独立作答、互不可见，监督员可见全部答卷并复核。",
}

export const providerPresets: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4.1-mini", "deepseek/deepseek-chat", "google/gemini-2.5-flash"],
  },
  {
    id: "anthropic",
    name: "Claude 官方（Anthropic）",
    baseUrl: "https://api.anthropic.com/v1",
    transport: "anthropic-messages",
    models: [],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct"],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-3", "grok-3-mini", "grok-2-vision-1212"],
  },
  {
    id: "gemini-openai",
    name: "Google Gemini · 兼容接口",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  },
  {
    id: "moonshot",
    name: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-plus", "glm-4-air"],
  },
  {
    id: "dashscope",
    name: "阿里云百炼 / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
  },
  {
    id: "qianfan",
    name: "百度千帆",
    baseUrl: "https://qianfan.baidubce.com/v2",
    models: ["ernie-4.0-turbo-8k", "ernie-3.5-8k", "deepseek-v3"],
  },
  {
    id: "hunyuan",
    name: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    models: ["hunyuan-turbo", "hunyuan-large", "hunyuan-standard"],
  },
  {
    id: "volcengine-ark",
    name: "火山方舟 Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["在火山方舟控制台复制 Endpoint ID"],
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1"],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/llama-v3p1-70b-instruct", "accounts/fireworks/models/deepseek-v3"],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
  },
  {
    id: "ollama",
    name: "本地 · Ollama",
    baseUrl: "http://localhost:11434/v1",
    keyless: true,
    models: ["qwen2.5:7b", "llama3.1:8b", "deepseek-r1:8b"],
  },
  {
    id: "lmstudio",
    name: "本地 · LM Studio",
    baseUrl: "http://localhost:1234/v1",
    keyless: true,
    models: ["local-model"],
  },
  {
    id: "vllm-local",
    name: "本地 · vLLM",
    baseUrl: "http://localhost:8000/v1",
    keyless: true,
    models: ["local-model"],
  },
  {
    id: "custom",
    name: "自定义中转 / 兼容接口",
    baseUrl: "",
    models: [],
  },
]

export const groups: Group[] = []

export const members: AgentMember[] = []

export function memberById(id: string): AgentMember | undefined {
  return members.find((m) => m.id === id)
}

export const transcriptCollab: TranscriptItem[] = []

export const transcriptIndependent: TranscriptItem[] = []

export const blockers: Blocker[] = []

export const fileOps: FileOperation[] = []

export const usage = {
  tokensTotal: 0,
  tokensBudget: null,
  tokenAccounting: "unknown",
  costUsd: null,
  costBudgetUsd: null,
  costAccounting: "not_configured",
  apiCalls: 0,
  apiErrors: 0,
  avgLatencyMs: 0,
} satisfies UsageSummary

export const decision: {
  state: DecisionState
  confidence: number
  summary: string
} = {
  state: "revise",
  confidence: 0,
  summary: "????????",
}

export const globalInstructions = ""

export const currentTask = "???????????"
