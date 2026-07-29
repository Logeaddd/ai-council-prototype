import { normalizeToolRequests } from "./toolRequests.js";

const CONTEXT_TOOLS = ["record_task_contract", "search_context", "load_context"];
const TOOL_TIER_TOOLS = [
  "web_search", "fetch_url", "api_request", "list_directory", "read_file", "search_files", "grep_content",
  ...CONTEXT_TOOLS, "skill_read", "database_query"
];
const FULL_TIER_TOOLS = [
  ...TOOL_TIER_TOOLS, "workspace_edit", "skill_list", "skill_search", "skill_install", "skill_enable",
  "skill_disable", "skill_remove", "extract_archive", "create_archive", "execute_command", "process_control", "run_code",
  "install_package", "provision_tool", "run_tests", "git_operation", "browser_control", "mcp_search_npm", "mcp_install_npm",
  "mcp_uninstall", "mcp_list_tools", "mcp_call", "mcp_list_resources", "mcp_read_resource",
  "mcp_list_prompts", "mcp_get_prompt", "delegate_task"
];

const STRING = { type: "string" };
const NON_EMPTY_STRING = { type: "string", minLength: 1 };
const POSITIVE_INTEGER = { type: "integer", minimum: 1 };
const BOOLEAN = { type: "boolean" };
const OBJECT = { type: "object", additionalProperties: true };
const STRING_LIST = { type: "array", items: STRING };
const PRIMITIVE_LIST = { type: "array", items: { type: ["string", "number", "boolean", "null"] } };
const OBJECT_LIST = { type: "array", items: OBJECT };
const TEXT_OR_LIST = { anyOf: [NON_EMPTY_STRING, { type: "array", items: NON_EMPTY_STRING }] };
const TASK_DELIVERABLE = {
  anyOf: [
    NON_EMPTY_STRING,
    {
      type: "object",
      properties: {
        path: STRING,
        file: STRING,
        name: STRING,
        requirements: STRING,
        requirement: STRING,
        description: STRING
      },
      additionalProperties: false,
      anyOf: [{ required: ["path"] }, { required: ["file"] }, { required: ["name"] }, { required: ["description"] }]
    }
  ]
};
const TASK_ARTIFACT = {
  type: "object",
  properties: {
    path: STRING,
    extension: STRING,
    format: STRING,
    artifactType: STRING,
    requiresImages: BOOLEAN,
    minimumPages: { type: "integer", minimum: 0 }
  },
  additionalProperties: false,
  anyOf: [{ required: ["path"] }, { required: ["extension"] }]
};
const TASK_COLLABORATION = {
  type: "object",
  properties: {
    required: BOOLEAN,
    beforeFirstMutation: BOOLEAN,
    minimumDelegations: { type: "integer", minimum: 1, maximum: 8 },
    types: STRING_LIST,
    reason: STRING
  },
  additionalProperties: false
};
const TASK_CONTRACT = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["delivery", "discussion"] },
    objective: NON_EMPTY_STRING,
    requiresWorkspace: BOOLEAN,
    requiresVerification: BOOLEAN,
    deliverables: { type: "array", items: TASK_DELIVERABLE },
    artifacts: { type: "array", items: TASK_ARTIFACT },
    completionCriteria: TEXT_OR_LIST,
    nextAction: NON_EMPTY_STRING,
    collaboration: TASK_COLLABORATION
  },
  required: ["mode", "objective", "requiresWorkspace", "requiresVerification", "deliverables", "completionCriteria", "nextAction"],
  additionalProperties: false
};

// These names mirror normalizeToolRequest. Keeping the source of truth here
// prevents a provider from inventing fields for an unrelated tool family.
const PROPERTY_DEFINITIONS = {
  reason: { ...NON_EMPTY_STRING, description: "Why this real action is needed now." },
  query: { ...NON_EMPTY_STRING, description: "Search query or file-name/content pattern." },
  url: { ...NON_EMPTY_STRING, description: "Public URL to fetch or call." },
  path: { ...NON_EMPTY_STRING, description: "Workspace-relative path, unless an authorized project path is used." },
  destination: { ...NON_EMPTY_STRING, description: "Workspace-relative destination path." },
  root: { ...STRING, description: "Optional workspace root hint." },
  action: { ...NON_EMPTY_STRING, description: "Operation supported by this tool." },
  code: { ...STRING, description: "Source code or file content for a real write/run operation." },
  oldText: { ...STRING, description: "Exact text to replace." },
  newText: { ...STRING, description: "Replacement text." },
  replaceAll: BOOLEAN,
  command: { ...NON_EMPTY_STRING, description: "Shell command to execute." },
  cwd: { ...STRING, description: "Optional working directory inside the authorized workspace." },
  shell: { ...STRING, description: "Requested shell." },
  timeoutMs: { ...POSITIVE_INTEGER, maximum: 3600000 },
  background: BOOLEAN,
  interactive: BOOLEAN,
  columns: { ...POSITIVE_INTEGER, maximum: 300 },
  rows: { ...POSITIVE_INTEGER, maximum: 200 },
  language: { ...NON_EMPTY_STRING, description: "Language/runtime for the code snippet." },
  manager: { ...NON_EMPTY_STRING, description: "Package manager or ecosystem." },
  packageName: { ...NON_EMPTY_STRING, description: "Package name." },
  toolName: { ...NON_EMPTY_STRING, description: "Tool or runtime being acquired." },
  commandName: { ...STRING, description: "Executable to detect." },
  packageId: { ...STRING, description: "Platform package identifier." },
  installCommand: { ...STRING, description: "Explicit installation command when policy permits it." },
  downloadUrl: { ...STRING, description: "HTTPS download URL for a tool archive or binary. Redirects are checked again." },
  discoverySourceUrl: { ...STRING, description: "Public publisher page or package listing used to discover the acquisition route. It is recorded as discovery evidence, not as a trust guarantee." },
  discoveryQuery: { ...STRING, description: "Search terms used to discover the tool source." },
  sha256: { ...STRING, description: "Expected SHA-256 of the downloaded artifact. Omit only when no publisher checksum is available; the result will be recorded as unverified." },
  maxDownloadBytes: { ...POSITIVE_INTEGER, maximum: 1073741824 },
  executablePath: { ...STRING, description: "Expected executable after installation." },
  verifyCommand: { ...STRING, description: "Command used to verify the acquired tool." },
  runner: { ...STRING, description: "Test runner or framework." },
  method: { ...STRING, description: "HTTP method." },
  headers: OBJECT,
  json: {},
  body: {},
  count: { ...POSITIVE_INTEGER, maximum: 1000 },
  offset: { type: "integer", minimum: 0 },
  pattern: { ...STRING, description: "Optional search pattern." },
  sessionId: { ...STRING, description: "Saved session identifier." },
  eventId: { ...STRING, description: "Public event identifier." },
  round: { ...POSITIVE_INTEGER, description: "Round number in a saved context." },
  contextSessionId: { ...STRING, description: "Session scope for public-event search." },
  eventType: STRING,
  actorId: STRING,
  taskId: STRING,
  file: STRING,
  commit: STRING,
  toolFilter: STRING,
  statusFilter: STRING,
  fromTime: STRING,
  toTime: STRING,
  maxBytes: { ...POSITIVE_INTEGER, maximum: 524288 },
  overwrite: BOOLEAN,
  processId: { ...STRING, description: "Background process identifier." },
  stream: { ...STRING, description: "Process output stream to read." },
  maxOutputBytes: { ...POSITIVE_INTEGER, maximum: 524288 },
  branch: STRING,
  remote: STRING,
  message: STRING,
  paths: STRING_LIST,
  selector: STRING,
  inputText: STRING,
  expression: STRING,
  steps: OBJECT_LIST,
  viewport: OBJECT,
  waitMs: { ...POSITIVE_INTEGER, maximum: 3600000 },
  screenshot: BOOLEAN,
  databasePath: { ...NON_EMPTY_STRING, description: "SQLite database path inside the authorized workspace." },
  sql: { ...NON_EMPTY_STRING, description: "SQLite statement to execute." },
  params: PRIMITIVE_LIST,
  maxRows: { ...POSITIVE_INTEGER, maximum: 10000 },
  serverId: STRING,
  mcpToolName: STRING,
  arguments: OBJECT,
  resourceUri: STRING,
  promptName: STRING,
  promptArguments: OBJECT,
  catalogId: STRING,
  packageSpec: STRING,
  binName: STRING,
  mcpArgs: STRING_LIST,
  skillId: STRING,
  skillUrl: STRING,
  skillMarkdown: STRING,
  force: BOOLEAN,
  create: BOOLEAN,
  mode: STRING,
  delegationType: { ...NON_EMPTY_STRING, description: "Bounded delegation type: research, implementation, review, or unblocker." },
  assigneeId: { ...NON_EMPTY_STRING, description: "Stable ID of the specific contributor." },
  task: { ...NON_EMPTY_STRING, description: "Narrow delegated slice, never the full user request." },
  expectedEvidence: { type: "array", minItems: 1, items: NON_EMPTY_STRING, description: "Concrete evidence the contributor must hand back." },
  allowedTools: STRING_LIST,
  allowWorkspaceMutation: BOOLEAN,
  allowedPaths: STRING_LIST,
  taskContract: TASK_CONTRACT
};

const TOOL_SPECS = {
  web_search: spec("Search the public web and return evidence-bearing results.", ["query", "count", "timeoutMs"], ["query"]),
  fetch_url: spec("Fetch readable content from one public URL.", ["url", "timeoutMs"], ["url"]),
  api_request: spec("Make one real HTTP API request.", ["url", "method", "headers", "json", "body", "timeoutMs"], ["url"]),
  list_directory: spec("List an authorized workspace directory.", ["path", "root", "count"], ["path"]),
  read_file: spec("Read one authorized workspace file.", ["path", "root", "maxBytes"], ["path"]),
  search_files: spec("Search authorized workspace file names.", ["query", "path", "root", "count"], ["query"]),
  grep_content: spec("Search text content in authorized workspace files.", ["query", "path", "root", "pattern", "count"], ["query"]),
  search_context: spec("Search retained public group history and saved archives.", ["query", "contextSessionId", "eventType", "actorId", "taskId", "file", "commit", "toolFilter", "statusFilter", "fromTime", "toTime", "count", "offset"]),
  load_context: spec("Load one retained public context item by a pointer.", ["sessionId", "eventId", "commit", "round", "maxBytes"], [], [["sessionId"], ["eventId"], ["commit"]]),
  skill_read: spec("Read instructions from one enabled skill.", ["skillId", "offset", "maxBytes"], ["skillId"]),
  database_query: spec("Run an authorized SQLite query.", ["databasePath", "sql", "params", "maxRows"], ["databasePath", "sql"]),
  workspace_edit: spec("Make a real workspace mkdir, write, append, replace, or move operation.", ["action", "path", "destination", "root", "code", "oldText", "newText", "replaceAll"], ["action", "path"]),
  extract_archive: spec("Extract an archive inside the workspace.", ["path", "destination", "overwrite", "count"], ["path", "destination"]),
  create_archive: spec("Create a real archive from workspace files.", ["path", "destination", "overwrite"], ["path", "destination"]),
  execute_command: spec("Run a real shell command in the authorized workspace. Set interactive for a durable PTY terminal that is controlled with process_control.", ["command", "cwd", "shell", "timeoutMs", "background", "interactive", "columns", "rows", "maxOutputBytes"], ["command"]),
  process_control: spec("Inspect, input to, resize, or stop a tracked background process. Input and resize require an interactive PTY process.", ["action", "processId", "stream", "offset", "maxBytes", "inputText", "columns", "rows", "timeoutMs"], ["action"]),
  run_code: spec("Run a real code snippet through a selected runtime.", ["language", "code", "cwd", "timeoutMs", "maxOutputBytes"], ["language", "code"]),
  install_package: spec("Install a real language package into the managed workspace environment.", ["manager", "packageName", "cwd", "timeoutMs"], ["manager", "packageName"]),
  provision_tool: spec("Detect, acquire, and verify a missing runtime or CLI, with discovery provenance and optional SHA-256 verification for downloads.", ["toolName", "commandName", "packageId", "installCommand", "downloadUrl", "discoverySourceUrl", "discoveryQuery", "sha256", "maxDownloadBytes", "executablePath", "verifyCommand", "timeoutMs"], ["toolName"]),
  run_tests: spec("Run the project test or build command and return its real result.", ["runner", "command", "cwd", "timeoutMs", "maxOutputBytes"]),
  git_operation: spec("Run one real Git operation in the authorized project.", ["action", "cwd", "branch", "remote", "message", "paths", "force", "timeoutMs"], ["action"]),
  browser_control: spec("Control a real browser for an authorized workflow.", ["action", "url", "selector", "inputText", "expression", "steps", "viewport", "waitMs", "screenshot", "timeoutMs"], ["action"]),
  mcp_list_tools: spec("List tools exposed by configured MCP servers.", ["serverId", "timeoutMs"]),
  mcp_call: spec("Call one tool exposed by a configured MCP server.", ["serverId", "mcpToolName", "arguments", "timeoutMs"], ["mcpToolName"]),
  mcp_list_resources: spec("List resources exposed by configured MCP servers.", ["serverId", "timeoutMs"]),
  mcp_read_resource: spec("Read one resource exposed by a configured MCP server.", ["serverId", "resourceUri", "timeoutMs"], ["resourceUri"]),
  mcp_list_prompts: spec("List prompts exposed by configured MCP servers.", ["serverId", "timeoutMs"]),
  mcp_get_prompt: spec("Load one prompt from a configured MCP server.", ["serverId", "promptName", "promptArguments", "timeoutMs"], ["promptName"]),
  mcp_search_npm: spec("Search npm before choosing an MCP server package.", ["query", "count", "timeoutMs"], ["query"]),
  mcp_install_npm: spec("Install and configure an MCP server from npm.", ["serverId", "catalogId", "packageSpec", "binName", "mcpArgs", "timeoutMs"]),
  mcp_uninstall: spec("Remove a managed MCP server configuration.", ["serverId", "packageSpec"], ["serverId"]),
  skill_list: spec("List installed and enabled skills for this group."),
  skill_search: spec("Search real remote skill candidates.", ["query", "count", "timeoutMs"], ["query"]),
  skill_install: spec("Install a validated skill from a catalog, URL, or supplied markdown.", ["skillId", "catalogId", "skillUrl", "skillMarkdown", "overwrite", "timeoutMs"]),
  skill_enable: spec("Enable an installed skill for this group.", ["skillId"], ["skillId"]),
  skill_disable: spec("Disable a skill for this group.", ["skillId"], ["skillId"]),
  skill_remove: spec("Remove an installed skill.", ["skillId"], ["skillId"]),
  record_task_contract: spec("Record the semantic task contract before any task action. This persists requested outcomes and completion checks; it does not itself create a deliverable.", ["taskContract"], ["taskContract"]),
  delegate_task: spec("Create one bounded contributor handoff. Only the delivery owner may use it; it never transfers final ownership.", ["delegationType", "assigneeId", "task", "expectedEvidence", "allowedTools", "allowWorkspaceMutation", "allowedPaths"], ["delegationType", "assigneeId", "task", "expectedEvidence"])
};

export function nativeToolDefinitions(permissionTier = "text", options = {}) {
  const allowed = toolsForTier(permissionTier);
  const selected = new Set(
    (Array.isArray(options.tools) ? options.tools : allowed)
      .map((name) => String(name || "").trim().toLowerCase().replace(/-/g, "_"))
  );
  return allowed
    .filter((name) => selected.has(name))
    .map((name) => nativeDefinition(name));
}

export function nativeToolNames(permissionTier = "text") {
  return [...toolsForTier(permissionTier)];
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
    // ai_council_tool is accepted only for already-persisted sessions and older
    // providers. New calls use the real tool name and a closed per-tool schema.
    const request = name === "ai_council_tool" ? args : { ...args, tool: args.tool || name };
    requests.push({ ...request, id: String(call.id || request.id || "") || undefined });
  }
  return normalizeToolRequests(requests);
}

function spec(description, properties = [], required = [], anyOf = undefined) {
  return { description, properties, required, anyOf };
}

function nativeDefinition(name) {
  const spec = TOOL_SPECS[name];
  if (!spec) throw new Error(`Missing native tool schema for ${name}`);
  const propertyNames = [...new Set(["reason", ...spec.properties])];
  const properties = Object.fromEntries(propertyNames.map((property) => [property, PROPERTY_DEFINITIONS[property]]));
  const inputSchema = {
    type: "object",
    properties,
    required: [...new Set(["reason", ...spec.required])],
    additionalProperties: false
  };
  if (spec.anyOf) inputSchema.anyOf = spec.anyOf.map((required) => ({ required }));
  return {
    name,
    description: spec.description,
    inputSchema
  };
}

function toolsForTier(permissionTier) {
  if (permissionTier === "full") return FULL_TIER_TOOLS;
  if (permissionTier === "tool") return TOOL_TIER_TOOLS;
  return CONTEXT_TOOLS;
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
