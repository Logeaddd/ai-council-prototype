export const CAPABILITY_FAMILIES = Object.freeze([
  { id: "web", label: "联网工具" },
  { id: "files", label: "文件工具" },
  { id: "automation", label: "终端与代码" },
  { id: "browser", label: "浏览器" },
  { id: "database", label: "数据库" },
  { id: "memory", label: "历史与公共记忆" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "技能" }
]);

const FAMILY_IDS = new Set(CAPABILITY_FAMILIES.map((item) => item.id));
const TOOL_FAMILY = new Map([
  ...mapTools("web", ["web_search", "fetch_url", "api_request"]),
  ...mapTools("files", ["list_directory", "read_file", "search_files", "grep_content", "extract_archive"]),
  ...mapTools("automation", ["execute_command", "process_control", "run_code", "install_package", "run_tests", "git_operation"]),
  ...mapTools("browser", ["browser_control"]),
  ...mapTools("database", ["database_query"]),
  ...mapTools("memory", ["search_context", "load_context"]),
  ...mapTools("mcp", ["mcp_search_npm", "mcp_install_npm", "mcp_uninstall", "mcp_list_tools", "mcp_call", "mcp_list_resources", "mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt"]),
  ...mapTools("skills", ["skill_read", "skill_list", "skill_search", "skill_install", "skill_enable", "skill_disable", "skill_remove"])
]);

export function normalizeCapabilityAccess(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(CAPABILITY_FAMILIES.map((item) => [item.id, source[item.id] !== false]));
}

export function capabilityEnabled(settingsOrAccess, familyId) {
  if (!FAMILY_IDS.has(familyId)) return true;
  const access = settingsOrAccess?.capabilities?.toolAccess
    || settingsOrAccess?.toolAccess
    || settingsOrAccess;
  return normalizeCapabilityAccess(access)[familyId] !== false;
}

export function capabilityFamilyForTool(tool) {
  return TOOL_FAMILY.get(String(tool || "")) || "";
}

export function disabledCapabilityForTool(tool, appSettings) {
  const familyId = capabilityFamilyForTool(tool);
  if (!familyId || capabilityEnabled(appSettings, familyId)) return undefined;
  const family = CAPABILITY_FAMILIES.find((item) => item.id === familyId);
  return { id: familyId, label: family?.label || familyId };
}

export function disabledCapabilityForRequest(request, appSettings) {
  const tool = String(request?.tool || "");
  if (tool === "mcp_call" && isBuiltInWebMcpRequest(request) && !capabilityEnabled(appSettings, "web")) {
    return { id: "web", label: "联网工具" };
  }
  return disabledCapabilityForTool(tool, appSettings);
}

export function disabledToolNames(appSettings) {
  return [...TOOL_FAMILY.entries()]
    .filter(([, familyId]) => !capabilityEnabled(appSettings, familyId))
    .map(([tool]) => tool)
    .sort();
}

function mapTools(familyId, tools) {
  return tools.map((tool) => [tool, familyId]);
}

function isBuiltInWebMcpRequest(request = {}) {
  const serverId = String(request.serverId || "").toLowerCase();
  const toolName = String(request.mcpToolName || "").toLowerCase();
  return ["web-tools", "built-in-web-tools", "builtin-web-tools"].includes(serverId)
    || ["web_search", "fetch_url"].includes(toolName);
}
