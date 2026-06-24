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

test("server exposes an SSE council events endpoint", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/council\/events/);
  assert.match(serverJs, /text\/event-stream/);
  assert.match(serverJs, /runCouncilEvents/);
  assert.match(serverJs, /loadCouncilGroupFromRequest/);
  assert.match(serverJs, /runtimeGroup/);
  assert.match(serverJs, /continuationContext: body\.continuationContext/);
  assert.match(serverJs, /req\.on\("close", \(\) => controller\.abort\(\)\)/);
});

test("server clamps requested autonomous max rounds", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /body\.maxRounds/);
  assert.match(serverJs, /normalizeMaxRounds/);
  assert.match(serverJs, /Math\.min\(100, Math\.max\(1, count\)\)/);
});

test("server exposes group index endpoints without folder deletion", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  const gitignore = readRepoGitignore();
  assert.match(serverJs, /\/api\/groups-index/);
  assert.match(serverJs, /upsertGroupIndexRecord/);
  assert.match(serverJs, /removeGroupIndexRecord/);
  assert.match(serverJs, /resolveWorkspacePath\(body\.path \|\| body\.groupPath, "groupPath"\)/);
  assert.doesNotMatch(serverJs, /rmSync\(.*group/i);
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
  assert.match(serverJs, /updateAppSettings/);
  assert.match(serverJs, /resolveWorkspaceRoot\(body\.groupsRoot\)/);
  assert.match(appSettingsJs, /user-data/);
  assert.match(appSettingsJs, /app-settings\.json/);
  assert.match(appSettingsJs, /groupsRoot/);
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

test("server exposes guarded file operation endpoints", () => {
  const serverJs = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
  assert.match(serverJs, /\/api\/file-operations/);
  assert.match(serverJs, /listFileOperationReviewItems/);
  assert.match(serverJs, /readFileOperationAuditLog/);
  assert.match(serverJs, /approvePendingFileOperation/);
  assert.match(serverJs, /autoApprovePendingFileOperation/);
  assert.match(serverJs, /executeApprovedFileOperation/);
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
