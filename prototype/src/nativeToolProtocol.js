import { normalizeToolRequests } from "./toolRequests.js";

const CONTEXT_TOOLS = ["search_context", "load_context"];
const TOOL_TIER_TOOLS = [
  "web_search", "fetch_url", "api_request", "list_directory", "read_file", "search_files", "grep_content",
  ...CONTEXT_TOOLS, "skill_read", "database_query"
];
const FULL_TIER_TOOLS = [
  ...TOOL_TIER_TOOLS, "workspace_edit", "skill_list", "skill_search", "skill_install", "skill_enable",
  "skill_disable", "skill_remove", "extract_archive", "execute_command", "process_control", "run_code",
  "install_package", "provision_tool", "run_tests", "git_operation", "browser_control", "mcp_search_npm", "mcp_install_npm",
  "mcp_uninstall", "mcp_list_tools", "mcp_call", "mcp_list_resources", "mcp_read_resource",
  "mcp_list_prompts", "mcp_get_prompt"
];

export function nativeToolDefinitions(permissionTier = "text") {
  const allowed = permissionTier === "full"
    ? FULL_TIER_TOOLS
    : permissionTier === "tool"
      ? TOOL_TIER_TOOLS
      : CONTEXT_TOOLS;
  return [{
    name: "ai_council_tool",
    description: "Execute one real AI Council tool. Use only tools allowed for this member. Results are returned in the next model call.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", enum: allowed },
        reason: { type: "string" },
        action: { type: "string" },
        path: { type: "string" },
        destination: { type: "string" },
        code: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        query: { type: "string" },
        url: { type: "string" },
        command: { type: "string" },
        cwd: { type: "string" },
        shell: { type: "string" },
        timeoutMs: { type: "number" },
        background: { type: "boolean" },
        language: { type: "string" },
        manager: { type: "string" },
        packageName: { type: "string" },
        toolName: { type: "string" },
        commandName: { type: "string" },
        packageId: { type: "string" },
        installCommand: { type: "string" },
        downloadUrl: { type: "string" },
        executablePath: { type: "string" },
        verifyCommand: { type: "string" },
        runner: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        json: {},
        body: { type: "string" },
        sessionId: { type: "string" },
        eventId: { type: "string" },
        round: { type: "number" },
        eventType: { type: "string" },
        actorId: { type: "string" },
        taskId: { type: "string" },
        file: { type: "string" },
        commit: { type: "string" },
        toolFilter: { type: "string" },
        statusFilter: { type: "string" },
        fromTime: { type: "string" },
        toTime: { type: "string" },
        serverId: { type: "string" },
        mcpToolName: { type: "string" },
        arguments: { type: "object" }
      },
      required: ["tool", "reason"],
      additionalProperties: true
    }
  }];
}

export function openAiToolDefinitions(definitions = []) {
  return definitions.map((item) => ({
    type: "function",
    function: {
      name: item.name,
      description: item.description,
      parameters: item.inputSchema
    }
  }));
}

export function anthropicToolDefinitions(definitions = []) {
  return definitions.map((item) => ({
    name: item.name,
    description: item.description,
    input_schema: item.inputSchema
  }));
}

export function normalizeNativeToolCalls(calls = []) {
  const requests = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const name = String(call?.name || "").trim();
    const args = parseArguments(call?.arguments ?? call?.input);
    if (!args) continue;
    const request = name === "ai_council_tool" ? args : { ...args, tool: args.tool || name };
    requests.push({ ...request, id: String(call.id || request.id || "") || undefined });
  }
  return normalizeToolRequests(requests);
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
