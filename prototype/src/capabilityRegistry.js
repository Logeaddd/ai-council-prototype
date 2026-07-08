export function listCapabilities(options = {}) {
  const keyInfo = resolveSearchApiKeyInfo(options);
  const searchConfigured = Boolean(keyInfo.apiKey);
  return [
    {
      id: "web-search",
      label: "联网搜索",
      kind: "tool",
      status: searchConfigured ? "ready" : "needs_config",
      enabled: searchConfigured,
      provider: "Brave Search",
      source: keyInfo.source,
      requirement: searchConfigured
        ? ""
        : "请在设置里填写 Brave Search 密钥，或设置 AI_COUNCIL_BRAVE_SEARCH_API_KEY / BRAVE_SEARCH_API_KEY。"
    },
    {
      id: "fetch-url",
      label: "读取网页",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "Only public https URLs are allowed."
    },
    {
      id: "api-request",
      label: "接口请求",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "公开网址"
    },
    {
      id: "workspace-files",
      label: "读取文件",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "Requires tool or full permission and an imported group workspace."
    },
    {
      id: "extract-archive",
      label: "Extract ZIP",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "Requires full permission. Only .zip files inside the group workspace are extracted."
    },
    {
      id: "execute-command",
      label: "终端",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "run-code",
      label: "运行代码",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "install-package",
      label: "安装依赖",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "run-tests",
      label: "运行测试",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "git-operation",
      label: "Git",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "browser-control",
      label: "浏览器检查",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: "完全允许"
    },
    {
      id: "database-query",
      label: "数据库",
      kind: "tool",
      status: "ready",
      enabled: true,
      provider: "built-in SQLite",
      source: "local_server",
      requirement: "读取需工具授权，写入需完全允许"
    },
    {
      id: "public-memory",
      label: "公共记忆",
      kind: "memory",
      status: "ready",
      enabled: true,
      provider: "built-in",
      source: "local_server",
      requirement: ""
    },
    {
      id: "mcp-marketplace",
      label: "能力市场",
      kind: "planned",
      status: "planned",
      enabled: false,
      provider: "not_installed",
      source: "roadmap",
      requirement: "Not implemented yet; do not present it as installed."
    }
  ];
}

export function hasSearchApiKey(options = process.env) {
  return Boolean(resolveSearchApiKey(options));
}

export function resolveSearchApiKey(options = process.env) {
  return resolveSearchApiKeyInfo(options).apiKey;
}

export function resolveSearchApiKeyInfo(options = process.env) {
  const normalized = normalizeSearchOptions(options);
  const localKey = String(
    normalized.appSettings?.capabilities?.webSearch?.apiKey ||
    normalized.searchApiKey ||
    ""
  ).trim();
  if (localKey) return { apiKey: localKey, source: "configured_local" };

  const envKey = String(
    normalized.env.AI_COUNCIL_BRAVE_SEARCH_API_KEY ||
    normalized.env.BRAVE_SEARCH_API_KEY ||
    ""
  ).trim();
  if (envKey) return { apiKey: envKey, source: "configured_env" };

  return { apiKey: "", source: "not_configured" };
}

function normalizeSearchOptions(options) {
  if (
    options &&
    (options.AI_COUNCIL_BRAVE_SEARCH_API_KEY !== undefined ||
      options.BRAVE_SEARCH_API_KEY !== undefined)
  ) {
    return { env: options };
  }
  return {
    env: options?.env || process.env,
    appSettings: options?.appSettings,
    searchApiKey: options?.searchApiKey
  };
}
