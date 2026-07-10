const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelsEndpoint: "/models"
  },
  {
    id: "openai",
    label: "OpenAI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
    modelsEndpoint: "/models"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    transport: "openai-compatible",
    officialBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    models: ["openai/gpt-4.1-mini", "deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    modelsEndpoint: "/models"
  },
  {
    id: "anthropic",
    label: "Claude 官方（Anthropic）",
    transport: "anthropic-messages",
    officialBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "",
    models: [],
    modelsEndpoint: "/models"
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen2.5-72B-Instruct"],
    modelsEndpoint: "/models"
  },
  {
    id: "groq",
    label: "Groq",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    modelsEndpoint: "/models"
  },
  {
    id: "xai",
    label: "xAI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3-mini",
    models: ["grok-3", "grok-3-mini", "grok-2-vision-1212"],
    modelsEndpoint: "/models"
  },
  {
    id: "gemini-openai",
    label: "Google Gemini · 兼容接口",
    transport: "openai-compatible",
    officialBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    modelsEndpoint: "/models"
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    modelsEndpoint: "/models"
  },
  {
    id: "zhipu",
    label: "智谱 BigModel",
    transport: "openai-compatible",
    officialBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-plus", "glm-4-air"],
    modelsEndpoint: "/models"
  },
  {
    id: "dashscope",
    label: "阿里云百炼 / DashScope",
    transport: "openai-compatible",
    officialBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
    modelsEndpoint: "/models"
  },
  {
    id: "qianfan",
    label: "百度千帆",
    transport: "openai-compatible",
    officialBaseUrl: "https://qianfan.baidubce.com/v2",
    defaultModel: "ernie-4.0-turbo-8k",
    models: ["ernie-4.0-turbo-8k", "ernie-3.5-8k", "deepseek-v3"],
    modelsEndpoint: "/models"
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    defaultModel: "hunyuan-turbo",
    models: ["hunyuan-turbo", "hunyuan-large", "hunyuan-standard"],
    modelsEndpoint: "/models"
  },
  {
    id: "volcengine-ark",
    label: "火山方舟 Ark",
    transport: "openai-compatible",
    officialBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    models: ["在火山方舟控制台复制 Endpoint ID"],
    modelsEndpoint: "/models"
  },
  {
    id: "together",
    label: "Together AI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-R1"],
    modelsEndpoint: "/models"
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    models: ["accounts/fireworks/models/llama-v3p1-70b-instruct", "accounts/fireworks/models/deepseek-v3"],
    modelsEndpoint: "/models"
  },
  {
    id: "mistral",
    label: "Mistral AI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"],
    modelsEndpoint: "/models"
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    transport: "openai-compatible",
    officialBaseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    models: ["qwen2.5:7b", "llama3.1:8b", "deepseek-r1:8b"],
    modelsEndpoint: "/models",
    keyless: true
  },
  {
    id: "lmstudio",
    label: "本地 LM Studio",
    transport: "openai-compatible",
    officialBaseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    models: ["local-model"],
    modelsEndpoint: "/models",
    keyless: true
  },
  {
    id: "vllm-local",
    label: "本地 vLLM",
    transport: "openai-compatible",
    officialBaseUrl: "http://localhost:8000/v1",
    defaultModel: "local-model",
    models: ["local-model"],
    modelsEndpoint: "/models",
    keyless: true
  },
  {
    id: "custom",
    label: "自定义中转 / 兼容接口",
    transport: "openai-compatible",
    officialBaseUrl: "",
    defaultModel: "",
    models: [],
    modelsEndpoint: "/models",
    customUrl: true
  }
];

export function listProviderPresets(customProviders = []) {
  const builtInIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
  const custom = (Array.isArray(customProviders) ? customProviders : [])
    .filter((preset) => preset?.id && !builtInIds.has(preset.id))
    .map((preset) => ({
      id: preset.id,
      label: preset.label,
      transport: "openai-compatible",
      officialBaseUrl: preset.officialBaseUrl,
      defaultModel: preset.defaultModel || "",
      models: preset.defaultModel ? [preset.defaultModel] : [],
      modelsEndpoint: preset.modelsEndpoint || "/models",
      userDefined: true
    }));
  return [...PROVIDER_PRESETS.map((preset) => ({ ...preset })), ...custom];
}

export function findProviderPreset(id) {
  return listProviderPresets().find((preset) => preset.id === id)
    || listProviderPresets().find((preset) => preset.id === "custom");
}

export function resolveProviderBaseUrl(providerId, overrideUrl = "") {
  const custom = String(overrideUrl || "").trim();
  if (custom) return custom;
  return findProviderPreset(providerId)?.officialBaseUrl || "";
}
