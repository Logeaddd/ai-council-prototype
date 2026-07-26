import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoGitignore() {
  let current = root;
  while (true) {
    const filePath = path.join(current, ".gitignore");
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
    const next = path.dirname(current);
    if (next === current) return "";
    current = next;
  }
}

test("UI server binds to localhost only", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /server\.listen\(port,\s*host/);
  assert.match(serverJs, /127\.0\.0\.1/);
});

test("API paths are constrained by an allowed workspace root", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /allowedWorkspaceRoot/);
  assert.match(serverJs, /resolveWorkspacePath/);
  assert.match(serverJs, /resolveWorkspaceRoot/);
});

test("server exposes a durable council run endpoint and observer SSE endpoint", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/council\/events/);
  assert.match(serverJs, /text\/event-stream/);
  assert.match(serverJs, /runCouncilEvents/);
  assert.match(serverJs, /loadCouncilGroupFromRequest/);
  assert.match(serverJs, /runtimeGroup/);
  assert.match(serverJs, /continuationContext: body\.continuationContext/);
  assert.match(serverJs, /attachments: normalizeFileAttachments\(body\.attachments \|\| \[\]\)/);
  assert.match(serverJs, /\/api\/council\/stop/);
  assert.match(serverJs, /activeCouncilRuns\.start\(options\.groupPath\)/);
  assert.match(serverJs, /\/api\/council\/runs/);
  assert.match(serverJs, /eventSequence/);
  assert.match(serverJs, /unsubscribe\?\.\(\)/);
  assert.doesNotMatch(serverJs, /res\.once\("close", abortDisconnectedRun\)/);
  assert.match(serverJs, /activeCouncilRuns\.finish\(options\.groupPath, run\.id\)/);
});

test("server validates user file attachments before sending them to agents", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const attachmentsJs = fs.readFileSync(path.join(root, "src", "attachments.js"), "utf8");
  assert.match(serverJs, /normalizeFileAttachments/);
  assert.match(serverJs, /\/api\/private-chat/);
  assert.match(attachmentsJs, /MAX_FILE_ATTACHMENTS = 8/);
  assert.match(attachmentsJs, /MAX_ATTACHMENT_BYTES = 256 \* 1024/);
  assert.match(attachmentsJs, /MAX_TOTAL_ATTACHMENT_BYTES = 768 \* 1024/);
  assert.match(attachmentsJs, /looks like binary data/);
});

test("server exposes real project folder import for council context", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const importerJs = fs.readFileSync(path.join(root, "src", "projectImporter.js"), "utf8");
  assert.doesNotMatch(serverJs, /\/api\/project-folder-picker/);
  assert.match(serverJs, /\/api\/project\/import/);
  assert.match(serverJs, /importProjectFolder\(body\.folderPath/);
  assert.match(importerJs, /project-directory-tree\.txt/);
  assert.match(importerJs, /node_modules/);
  assert.match(importerJs, /Text files imported/);
});

test("server clamps requested autonomous max rounds", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /body\.maxRounds/);
  assert.match(serverJs, /normalizeMaxRounds/);
  assert.match(serverJs, /Math\.min\(100, Math\.max\(1, count\)\)/);
});

test("server exposes group index endpoints with guarded real group deletion", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const gitignore = readRepoGitignore();
  assert.match(serverJs, /\/api\/groups-index/);
  assert.match(serverJs, /upsertGroupIndexRecord/);
  assert.match(serverJs, /removeGroupIndexRecord/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.path \|\| body\.groupPath, "groupPath"\)/);
  assert.match(serverJs, /deleteWorkspaceGroupFolder/);
  assert.match(serverJs, /resolveWorkspacePath\(inputPath, "groupPath"\)/);
  assert.match(serverJs, /group\.json/);
  assert.match(serverJs, /fs\.rmSync\(groupPath, \{ recursive: true, force: true \}\)/);
  assert.match(gitignore, /prototype\/user-data\//);
});

test("sessions redact runtime API keys before storage", () => {
  const engineJs = fs.readFileSync(path.join(root, "src", "discussionEngine.js"), "utf8");
  assert.match(engineJs, /redactGroupForSession/);
  assert.match(engineJs, /apiKeySet/);
  assert.match(engineJs, /const \{ apiKey, \.\.\.safeAgent \} = agent/);
});

test("server persists global requirements inside guarded group paths", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/group\/global-requirement/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath, "groupPath"\)/);
  assert.match(serverJs, /updateGroupGlobalRequirement/);
  assert.match(serverJs, /globalRequirement: String\(globalRequirement \|\| ""\)\.trim\(\)/);
});

test("server exposes guarded group settings and seat config persistence", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const workspaceManagerJs = fs.readFileSync(path.join(root, "src", "workspaceManager.js"), "utf8");
  assert.match(serverJs, /\/api\/group\/settings/);
  assert.match(serverJs, /\/api\/group\/seat/);
  assert.match(serverJs, /\/api\/group\/seats\/reorder/);
  assert.match(serverJs, /\/api\/workspace\/add-member/);
  assert.match(serverJs, /updateGroupSettings/);
  assert.match(serverJs, /updateGroupSeat/);
  assert.match(serverJs, /reorderSeats\(\{ groupPath, seatIds: body\.seatIds \}\)/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath, "groupPath"\)/);
  assert.match(serverJs, /addMember\(body\)/);
  assert.match(workspaceManagerJs, /export function addMember/);
  assert.match(workspaceManagerJs, /export function reorderSeats/);
  assert.match(workspaceManagerJs, /Seat order must include every current seat exactly once/);
  assert.match(workspaceManagerJs, /nextSeatId/);
  assert.match(workspaceManagerJs, /createMemberDirs\(privateFolder\)/);
  assert.match(serverJs, /normalizeMaxRounds\(settings\.maxRounds\)/);
  assert.match(serverJs, /normalizeContextSearchLimit\(settings\.contextSearchLimit\)/);
  assert.match(serverJs, /normalizeContextArchiveInjectionLimit\(settings\.contextArchiveInjectionLimit\)/);
  assert.match(serverJs, /normalizeContextArchiveInjectionTokens\(settings\.contextArchiveInjectionTokens\)/);
  assert.match(serverJs, /normalizeRecentMessageLimit\(settings\.recentMessageLimit\)/);
  assert.match(serverJs, /seat\.role = normalized === "reviewer" \|\| normalized === "summarizer" \? normalized : "ordinary"/);
  assert.match(serverJs, /group\.permissions\.seatTiers\[seatId\] = normalizePermissionTier\(permission\)/);
  assert.match(serverJs, /Git is required before enabling tool permissions/);
});

test("server gates tool permission tiers on git", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/git\/status/);
  assert.match(serverJs, /\/api\/group\/permissions/);
  assert.match(serverJs, /requiresGit\(body\.defaultTier\)/);
  assert.match(serverJs, /Git is required before enabling tool permissions/);
  assert.match(serverJs, /git", \["rev-parse", "--is-inside-work-tree"\]/);
});
test("server stores app settings under local user-data and guards groups root", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const appSettingsJs = fs.readFileSync(path.join(root, "src", "appSettings.js"), "utf8");
  assert.match(serverJs, /\/api\/app-settings/);
  assert.match(serverJs, /containsGroup/);
  assert.match(serverJs, /group\.json/);
  assert.match(serverJs, /readAppSettings/);
  assert.match(serverJs, /redactAppSettingsForClient/);
  assert.match(serverJs, /updateAppSettings/);
  assert.match(serverJs, /resolveWorkspaceRoot\(body\.groupsRoot\)/);
  assert.match(serverJs, /AI_COUNCIL_DATA_DIR/);
  assert.match(appSettingsJs, /user-data/);
  assert.match(appSettingsJs, /userDataDir/);
  assert.match(appSettingsJs, /app-settings\.json/);
  assert.match(appSettingsJs, /groupsRoot/);
  assert.match(appSettingsJs, /appearance/);
  assert.match(appSettingsJs, /theme: value\.theme === "dark" \? "dark" : "light"/);
  assert.match(appSettingsJs, /storedKeyConfigured/);
  assert.match(appSettingsJs, /envKeyConfigured/);
});

test("server exposes guarded usage stats endpoint", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const usageStatsJs = fs.readFileSync(path.join(root, "src", "usageStats.js"), "utf8");
  assert.match(serverJs, /\/api\/usage/);
  assert.match(serverJs, /readUsageSnapshot/);
  assert.match(serverJs, /resolveWorkspacePath\(requireQuery\(url, "groupPath"\), "groupPath"\)/);
  assert.match(usageStatsJs, /shared", "usage", "usage\.jsonl"/);
  assert.match(usageStatsJs, /private_memory", "usage\.jsonl"/);
});

test("server exposes guarded chat history endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const storageJs = fs.readFileSync(path.join(root, "src", "storage.js"), "utf8");
  assert.match(serverJs, /\/api\/sessions/);
  assert.match(serverJs, /\/api\/session/);
  assert.match(serverJs, /\/api\/session-context/);
  assert.match(serverJs, /\/api\/context-search/);
  assert.match(serverJs, /listGroupSessions/);
  assert.match(serverJs, /readGroupSession/);
  assert.match(serverJs, /readSessionContextArchive/);
  assert.match(serverJs, /searchSessionContextArchive/);
  assert.match(serverJs, /resolveWorkspacePath\(requireQuery\(url, "groupPath"\), "groupPath"\)/);
  assert.match(storageJs, /Invalid session id/);
  assert.match(storageJs, /context_policy\.json/);
  assert.match(storageJs, /session_index\.jsonl/);
  assert.match(storageJs, /local_context_archive/);
});

test("server exposes guarded public event query and session deletion tombstones", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/context-events/);
  assert.match(serverJs, /\/api\/context-events\/delete-session/);
  assert.match(serverJs, /tombstonePublicEvents/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath/);
});

test("server exposes guarded public memory endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const memoryJs = fs.readFileSync(path.join(root, "src", "publicMemory.js"), "utf8");
  assert.match(serverJs, /\/api\/public-memory/);
  assert.match(serverJs, /\/api\/task-state/);
  assert.match(serverJs, /listPublicMemories/);
  assert.match(serverJs, /upsertPublicMemory/);
  assert.match(serverJs, /deletePublicMemory/);
  assert.match(serverJs, /readTaskState/);
  assert.match(serverJs, /resolveWorkspacePath\(requireQuery\(url, "groupPath"\), "groupPath"\)/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath, "groupPath"\)/);
  assert.match(memoryJs, /public-memory\.json/);
});

test("server exposes guarded file operation endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/file-operations/);
  assert.match(serverJs, /listFileOperationReviewItems/);
  assert.match(serverJs, /readFileOperationAuditLog/);
  assert.match(serverJs, /approvePendingFileOperation/);
  assert.match(serverJs, /rejectPendingFileOperation/);
  assert.match(serverJs, /autoApprovePendingFileOperation/);
  assert.match(serverJs, /executeApprovedFileOperation/);
  assert.match(serverJs, /restoreDeletedFileOperation/);
  assert.match(serverJs, /\/api\/file-operations\/restore/);
  assert.match(serverJs, /resolveWorkspacePath\(requireQuery\(url, "groupPath"\), "groupPath"\)/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath, "groupPath"\)/);
});


test("server exposes guarded private chat endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/private-chat/);
  assert.match(serverJs, /appendPrivateChatMessage/);
  assert.match(serverJs, /readPrivateChatMessages/);
  assert.match(serverJs, /resolveWorkspacePath\(requireQuery\(url, "groupPath"\), "groupPath"\)/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.groupPath, "groupPath"\)/);
});


test("server exposes model discovery endpoints with source labels", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const discoveryJs = fs.readFileSync(path.join(root, "src", "modelDiscovery.js"), "utf8");
  assert.match(serverJs, /\/api\/providers/);
  assert.match(serverJs, /\/api\/models\/discover/);
  assert.match(serverJs, /\/api\/models\/health/);
  assert.match(serverJs, /listProviderPresets/);
  assert.match(discoveryJs, /real_response/);
  assert.match(discoveryJs, /timeout_inference/);
  assert.match(discoveryJs, /cache/);
});

test("server exposes real capability and guarded web tool endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const capabilityJs = fs.readFileSync(path.join(root, "src", "capabilityRegistry.js"), "utf8");
  const webToolsJs = fs.readFileSync(path.join(root, "src", "webTools.js"), "utf8");
  const mcpServerJs = fs.readFileSync(path.join(root, "src", "mcpServer.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.match(serverJs, /\/api\/capabilities/);
  assert.match(serverJs, /\/api\/tools\/fetch-url/);
  assert.match(serverJs, /\/api\/tools\/web-search/);
  assert.match(capabilityJs, /web-search/);
  assert.match(capabilityJs, /mcp-web-tools/);
  assert.equal(pkg.scripts["mcp:web"], "node ./src/mcpServer.js");
  assert.match(mcpServerJs, /tools\/list/);
  assert.match(mcpServerJs, /tools\/call/);
  assert.match(mcpServerJs, /fetchPublicUrl/);
  assert.match(mcpServerJs, /searchWeb/);
  assert.match(capabilityJs, /built_in_html/);
  assert.match(webToolsJs, /Blocked unsafe URL/);
  assert.match(webToolsJs, /api\.search\.brave\.com/);
});

test("server exposes local MCP server config APIs without starting fake runtimes", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const mcpConfigJs = fs.readFileSync(path.join(root, "src", "mcpConfig.js"), "utf8");

  assert.match(serverJs, /\/api\/mcp\/servers/);
  assert.match(serverJs, /\/api\/mcp\/servers\/delete/);
  assert.match(serverJs, /\/api\/mcp\/catalog/);
  assert.match(serverJs, /\/api\/mcp\/search/);
  assert.match(serverJs, /\/api\/mcp\/install/);
  assert.match(serverJs, /\/api\/mcp\/uninstall/);
  assert.match(serverJs, /\/api\/mcp\/tools\/list/);
  assert.match(serverJs, /\/api\/mcp\/tools\/call/);
  assert.match(serverJs, /\/api\/mcp\/resources\/list/);
  assert.match(serverJs, /\/api\/mcp\/resources\/read/);
  assert.match(serverJs, /\/api\/mcp\/prompts\/list/);
  assert.match(serverJs, /\/api\/mcp\/prompts\/get/);
  assert.match(serverJs, /listMcpServerConfigs/);
  assert.match(serverJs, /upsertMcpServerConfig/);
  assert.match(serverJs, /deleteMcpServerConfig/);
  assert.match(serverJs, /listConfiguredMcpTools/);
  assert.match(serverJs, /callConfiguredMcpTool/);
  assert.match(serverJs, /listMcpInstallCatalog/);
  assert.match(serverJs, /searchMcpNpmPackages/);
  assert.match(serverJs, /installMcpNpmServer/);
  assert.match(serverJs, /uninstallManagedMcpServer/);
  assert.match(serverJs, /listConfiguredMcpResources/);
  assert.match(serverJs, /readConfiguredMcpResource/);
  assert.match(serverJs, /listConfiguredMcpPrompts/);
  assert.match(serverJs, /getConfiguredMcpPrompt/);
  assert.match(mcpConfigJs, /mcp-servers\.json/);
  assert.match(mcpConfigJs, /redacted/);
  assert.match(mcpConfigJs, /runtime: "not_started"/);
});

test("server capability gates cover direct web, MCP runtime, and file execution routes", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/tools\/fetch-url"\) \{\s*requireCapability\("web"\)/);
  assert.match(serverJs, /\/api\/tools\/web-search"\) \{\s*requireCapability\("web"\)/);
  for (const route of ["tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get"]) {
    const escaped = route.replace("/", "\\/");
    assert.match(serverJs, new RegExp(`/api/mcp/${escaped}[^]*?requireCapability\\(\"mcp\"\\)`));
  }
  for (const route of ["approve", "auto-approve", "execute", "restore"]) {
    assert.match(serverJs, new RegExp(`/api/file-operations/${route}[^]*?requireCapability\\(\"files\"\\)`));
  }
  assert.match(serverJs, /error\.statusCode = 409/);
  assert.match(serverJs, /error\.code = "capability_disabled"/);
  assert.match(serverJs, /\.\.\.\(error\.code \? \{ code: error\.code \} : \{\}\)/);
});

test("CLI council runs use the same persisted global capability policy", () => {
  const cliJs = fs.readFileSync(path.join(root, "src", "cli.js"), "utf8");
  assert.match(cliJs, /readAppSettings/);
  assert.match(cliJs, /runCouncil\(question, group, baseDir, \{\s*appSettings: readAppSettings\(baseDir\)/);
});

test("server exposes guarded real skill pack APIs", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const skillJs = fs.readFileSync(path.join(root, "src", "skillPacks.js"), "utf8");
  for (const endpoint of ["/api/skills", "/api/skills/catalog", "/api/skills/search", "/api/skills/install", "/api/skills/enable", "/api/skills/disable", "/api/skills/remove"]) {
    assert.match(serverJs, new RegExp(endpoint.replaceAll("/", "\\/")));
  }
  assert.match(serverJs, /resolveWorkspacePath\(.*groupPath/);
  assert.match(serverJs, /installRemoteSkillPack/);
  assert.match(serverJs, /enableSkillForGroup/);
  assert.match(skillJs, /fetchPublicText/);
  assert.match(skillJs, /skill_download_truncated/);
  assert.match(skillJs, /sha256/);
});
