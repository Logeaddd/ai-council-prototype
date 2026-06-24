const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelsEndpoint: "/models"
  },
  {
    id: "openai",
    label: "OpenAI",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    modelsEndpoint: "/models"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    transport: "openai-compatible",
    officialBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    modelsEndpoint: "/models"
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    transport: "openai-compatible",
    officialBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    modelsEndpoint: "/models"
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    transport: "openai-compatible",
    officialBaseUrl: "",
    defaultModel: "",
    modelsEndpoint: "/models",
    customUrl: true
  }
];

export function listProviderPresets() {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset }));
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
