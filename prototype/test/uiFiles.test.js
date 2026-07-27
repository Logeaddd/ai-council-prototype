import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("renderer migration has one real UI entrypoint and no legacy public UI", () => {
  assert.ok(fs.existsSync(path.join(root, "renderer", "app", "page.tsx")));
  assert.ok(fs.existsSync(path.join(root, "renderer", "components", "council", "council-app.tsx")));
  assert.ok(fs.existsSync(path.join(root, "renderer", "out", "index.html")), "renderer/out/index.html should exist");
  assert.equal(fs.existsSync(path.join(root, "public", "app.js")), false);
  assert.equal(fs.existsSync(path.join(root, "public", "index.html")), false);
  assert.equal(fs.existsSync(path.join(root, "public", "styles.css")), false);

  const server = read("src/server.js");
  assert.match(server, /const publicDir = rendererOutDir/);
  assert.doesNotMatch(server, /legacyPublicDir/);
});

test("renderer build is static, type checked, and offline-friendly for Electron", () => {
  const nextConfig = read("renderer/next.config.mjs");
  const layout = read("renderer/app/layout.tsx");
  const rendererPackage = read("renderer/package.json");
  assert.match(nextConfig, /output: "export"/);
  assert.doesNotMatch(nextConfig, /ignoreBuildErrors/);
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.doesNotMatch(layout, /@vercel\/analytics/);
  assert.doesNotMatch(rendererPackage, /@vercel\/analytics/);
  assert.match(layout, /AI Council · 智能议会/);
});

test("renderer defaults to a warm light theme and persists optional dark mode", () => {
  const globals = read("renderer/app/globals.css");
  const layout = read("renderer/app/layout.tsx");
  const settings = read("renderer/components/council/settings-sheet.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");

  assert.match(globals, /:root\s*\{\s*color-scheme: light/);
  assert.match(globals, /\.dark\s*\{\s*color-scheme: dark/);
  assert.match(globals, /--background: oklch\(0\.955 0\.014 88\)/);
  assert.match(layout, /ai-council:theme/);
  assert.match(layout, /theme === "dark"/);
  assert.match(settings, /id: "appearance", label: "外观"/);
  assert.match(settings, /label: "浅色"/);
  assert.match(settings, /label: "暗色"/);
  assert.match(settings, /theme: selectedTheme/);
  assert.match(app, /appearance: \{ theme: values\.theme \}/);
  assert.match(app, /applyAppearanceTheme/);
  assert.match(live, /AppearanceTheme = "light" \| "dark"/);
});

test("renderer retains the injected local API token after static head hydration", () => {
  const server = read("src/server.js");
  const live = read("renderer/lib/council-live.ts");

  assert.match(server, /__AI_COUNCIL_LOCAL_API_TOKEN__/);
  assert.match(server, /JSON\.stringify\(localApiToken\)/);
  assert.match(live, /__AI_COUNCIL_LOCAL_API_TOKEN__/);
  assert.match(live, /X-AI-Council-Token/);
});

test("renderer uses the provided logo asset for visible branding and icons", () => {
  const sidebar = read("renderer/components/council/groups-sidebar.tsx");
  const layout = read("renderer/app/layout.tsx");
  assert.ok(fs.existsSync(path.join(root, "renderer", "public", "logo.png")));
  assert.ok(fs.existsSync(path.join(root, "renderer", "public", "logo-256.png")));
  assert.ok(fs.existsSync(path.join(root, "renderer", "public", "apple-icon.png")));
  for (const staleAsset of [
    "icon.svg",
    "placeholder-logo.png",
    "placeholder-logo.svg",
    "placeholder-user.jpg",
    "placeholder.jpg",
    "placeholder.svg",
  ]) {
    assert.equal(fs.existsSync(path.join(root, "renderer", "public", staleAsset)), false);
  }
  assert.match(sidebar, /src="\/logo\.png"/);
  assert.doesNotMatch(sidebar, /Users className/);
  assert.match(layout, /\/logo\.png/);
  assert.match(layout, /\/apple-icon\.png/);
});

test("renderer wires the real council APIs instead of mock-only UI state", () => {
  const live = read("renderer/lib/council-live.ts");
  const app = read("renderer/components/council/council-app.tsx");
  const privateChat = read("renderer/components/council/private-chat-sheet.tsx");
  for (const endpoint of [
    "/api/groups-index",
    "/api/group?groupPath=",
    "/api/council/runs",
    "/events?",
    "/api/private-chat",
    "/api/providers",
    "/api/models/discover",
    "/api/models/health",
    "/api/workspace/init",
    "/api/workspace/add-member",
    "/api/group/settings",
    "/api/group/seat",
    "/api/file-operations/approve",
    "/api/file-operations/reject",
    "/api/file-operations/execute",
  ]) {
    assert.match(`${live}\n${app}\n${privateChat}`, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(app, /streamCouncilEvents/);
  assert.match(app, /AbortController/);
  assert.match(app, /workspaceGroupToRuntimeGroup/);
});

test("settings skills panel uses real installable skill records", () => {
  const live = read("renderer/lib/council-live.ts");
  const settings = read("renderer/components/council/settings-sheet.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  for (const endpoint of [
    "/api/skills?groupPath=",
    "/api/skills/catalog",
    "/api/skills/search",
    "/api/skills/install",
    "/api/skills/enable",
    "/api/skills/disable",
    "/api/skills/remove",
  ]) {
    assert.match(live, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(app, /groupPath=\{group\.path \|\| ""\}/);
  assert.match(settings, /fetchSkills\(groupPath\)/);
  assert.match(settings, /searchSkills\(query\)/);
  assert.match(settings, /installSkill\(/);
  assert.match(settings, /setSkillEnabled\(/);
  assert.match(settings, /removeSkill\(/);
  assert.doesNotMatch(settings, /\.filter\(\(item\) => item\.kind === "tool" \|\| item\.kind === "memory" \|\| item\.kind === "mcp_server"\)/);
});

test("add member opens the template configuration sheet before creating a seat", () => {
  const app = read("renderer/components/council/council-app.tsx");
  const sheet = read("renderer/components/council/member-config-sheet.tsx");
  const addMemberStart = app.indexOf("async function handleAddMember()");
  const discoverStart = app.indexOf("async function handleDiscoverModels", addMemberStart);
  const addMemberBody = app.slice(addMemberStart, discoverStart);

  assert.match(app, /CREATE_MEMBER_ID/);
  assert.match(app, /function buildCreateMemberDraft/);
  assert.match(addMemberBody, /setCreateMemberDraft\(buildCreateMemberDraft\(members\.length \+ 1, providerOptions\)\)/);
  assert.doesNotMatch(addMemberBody, /addWorkspaceMember/);
  assert.doesNotMatch(app, /window\.prompt\("新成员名称"/);
  assert.match(sheet, /creating\?: boolean/);
  assert.match(sheet, /创建成员/);
});

test("create group button directly creates a uniquely named council group", () => {
  const app = read("renderer/components/council/council-app.tsx");
  const createGroupStart = app.indexOf("async function handleCreateGroup()");
  const addMemberStart = app.indexOf("async function handleAddMember()", createGroupStart);
  const createGroupBody = app.slice(createGroupStart, addMemberStart);

  assert.match(app, /function nextDefaultGroupName\(groups: LiveGroup\[\]\)/);
  assert.match(app, /const baseName = "新议会组"/);
  assert.match(createGroupBody, /const name = nextDefaultGroupName\(groupList\)/);
  assert.match(createGroupBody, /createWorkspaceGroup/);
  assert.match(createGroupBody, /groupFolderName: name/);
  assert.doesNotMatch(createGroupBody, /window\.prompt/);
});

test("member configuration keeps model discovery and provider controls in the template sheet", () => {
  const sheet = read("renderer/components/council/member-config-sheet.tsx");
  const live = read("renderer/lib/council-live.ts");
  const app = read("renderer/components/council/council-app.tsx");
  assert.match(sheet, /模型供应商/);
  assert.match(sheet, /接口地址/);
  assert.match(sheet, /https:\/\/code-plan\.site\/v1/);
  assert.match(sheet, /检测可用性/);
  assert.match(sheet, /发现模型/);
  assert.match(sheet, /来源：/);
  assert.match(sheet, /真实响应/);
  assert.match(sheet, /超时推断/);
  assert.match(sheet, /留空表示不修改已有密钥/);
  assert.match(live, /export async function checkProviderHealth/);
  assert.match(live, /\/api\/models\/health/);
  assert.match(app, /handleCheckProviderHealth/);
  assert.match(app, /onCheckProviderHealth=\{handleCheckProviderHealth\}/);
});

test("provider presets include common OpenAI-compatible cloud and local providers", () => {
  const registry = read("src/providerRegistry.js");
  const fallback = read("renderer/lib/council-data.ts");
  for (const provider of [
    "deepseek",
    "openai",
    "openrouter",
    "anthropic",
    "siliconflow",
    "groq",
    "xai",
    "gemini-openai",
    "moonshot",
    "zhipu",
    "dashscope",
    "qianfan",
    "hunyuan",
    "volcengine-ark",
    "together",
    "fireworks",
    "mistral",
    "ollama",
    "lmstudio",
    "vllm-local",
    "custom",
  ]) {
    assert.match(registry, new RegExp(`id: "${provider}"`));
    assert.match(fallback, new RegExp(`id: "${provider}"`));
  }
  assert.match(registry, /https:\/\/api\.groq\.com\/openai\/v1/);
  assert.match(registry, /Claude 官方（Anthropic）/);
  assert.match(registry, /anthropic-messages/);
  assert.match(registry, /https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1/);
  assert.match(registry, /http:\/\/localhost:1234\/v1/);
});

test("top bar keeps the disabled roundtable placeholder without shipping a fake roundtable view", () => {
  const topBar = read("renderer/components/council/top-bar.tsx");
  assert.match(topBar, /开始/);
  assert.match(topBar, /value: "roundtable"/);
  assert.match(topBar, /disabled: true/);
  assert.equal(fs.existsSync(path.join(root, "renderer", "components", "council", "roundtable-view.tsx")), false);
});

test("composer keeps continue beside icon-only send and pause controls", () => {
  const composer = read("renderer/components/council/composer.tsx");
  assert.match(composer, /StepForward/);
  assert.match(composer, /继续/);
  assert.match(composer, /Pause/);
  assert.match(composer, /aria-label=\{running \? "暂停"/);
  assert.doesNotMatch(composer, />发送<\/button>/);
  assert.doesNotMatch(composer, />暂停<\/button>/);
});

test("right panel uses plain wording and keeps real member and file-operation controls", () => {
  const rightPanel = read("renderer/components/council/right-panel.tsx");
  assert.match(rightPanel, /待处理问题/);
  assert.doesNotMatch(rightPanel, /阻塞项/);
  assert.match(rightPanel, /<Plus className="size-3" \/> 添加/);
  assert.match(rightPanel, /onAddMember/);
  assert.match(rightPanel, /onConfigureMember/);
  assert.match(rightPanel, /aria-label="批准"/);
  assert.match(rightPanel, /aria-label="拒绝"/);
});

test("right panel can drag members and persist their order", () => {
  const rightPanel = read("renderer/components/council/right-panel.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");

  assert.match(rightPanel, /GripVertical/);
  assert.match(rightPanel, /draggable=\{members\.length > 1\}/);
  assert.match(rightPanel, /onDragStart/);
  assert.match(rightPanel, /onDrop/);
  assert.match(rightPanel, /onReorderMembers\(next\)/);
  assert.match(app, /async function handleReorderMembers\(seatIds: string\[\]\)/);
  assert.match(app, /reorderSeats\(\{ groupPath: group\.path, seatIds \}\)/);
  assert.match(app, /onReorderMembers=\{handleReorderMembers\}/);
  assert.match(live, /export async function reorderSeats/);
  assert.match(live, /\/api\/group\/seats\/reorder/);
});

test("independent mode is named proctoring and uses supervisors", () => {
  const data = read("renderer/lib/council-data.ts");
  const rightPanel = read("renderer/components/council/right-panel.tsx");
  const memberSheet = read("renderer/components/council/member-config-sheet.tsx");
  assert.match(data, /independent: "监考模式"/);
  assert.match(data, /监督员可见全部答卷/);
  assert.match(rightPanel, /mode === "independent" \? "监督员" : "审查者"/);
  assert.match(memberSheet, /监督员越严格/);
});

test("private chat is wired through the renderer and backend API", () => {
  const composer = read("renderer/components/council/composer.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const privateChat = read("renderer/components/council/private-chat-sheet.tsx");
  const server = read("src/server.js");
  assert.match(composer, /onOpenPrivateChat/);
  assert.match(composer, /data-testid="open-private-chat"/);
  assert.match(composer, /data-testid="group-chat-draft"/);
  assert.match(composer, /data-draft-ready=\{draftLoaded \? "true" : "false"\}/);
  assert.match(app, /PrivateChatSheet/);
  assert.doesNotMatch(composer, /privateMode/);
  assert.doesNotMatch(app, /private-reply-/);
  assert.match(privateChat, /\/api\/private-chat/);
  assert.match(privateChat, /ai-council:private-draft:/);
  assert.match(privateChat, /data-testid="private-chat-draft"/);
  assert.match(privateChat, /data-draft-ready=\{loadedDraftKey === draftKey \? "true" : "false"\}/);
  assert.match(privateChat, /runtimeGroup/);
  assert.match(privateChat, /loadedDraftKey !== draftKey/);
  assert.match(privateChat, /persistPrivateDraft\(draftKey, value\)/);
  assert.match(server, /\/api\/private-chat/);
  assert.match(server, /status: "error"/);
});

test("desktop private-draft probe exercises the real API and browser interaction path", () => {
  const desktop = read("desktop/main.mjs");
  const probe = read("scripts/probe-electron-private-draft.mjs");
  const packageJson = read("package.json");

  assert.match(desktop, /AI_COUNCIL_E2E_PRIVATE_DRAFT_PROBE/);
  assert.match(desktop, /\/api\/workspace\/init/);
  assert.match(desktop, /ai-council-local-api-token/);
  assert.match(desktop, /__AI_COUNCIL_LOCAL_API_TOKEN__/);
  assert.match(desktop, /typeProbeText/);
  assert.match(desktop, /\[data-testid='group-chat-draft'\]/);
  assert.match(desktop, /\[data-testid='private-chat-draft'\]/);
  assert.match(desktop, /private_draft_not_restored_after_reopen/);
  assert.match(probe, /AI_COUNCIL_E2E_PRIVATE_DRAFT_PROBE: "1"/);
  assert.match(probe, /electron_private_draft/);
  assert.match(packageJson, /probe:electron-private-draft/);
});

test("renderer opens with blank current-session usage instead of stale demo totals", () => {
  const data = read("renderer/lib/council-data.ts");
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");
  const rightPanel = read("renderer/components/council/right-panel.tsx");
  const topBar = read("renderer/components/council/top-bar.tsx");

  assert.match(data, /tokensTotal:\s*0/);
  assert.match(data, /tokensBudget:\s*null/);
  assert.match(data, /costUsd:\s*null/);
  assert.match(data, /costBudgetUsd:\s*null/);
  assert.match(data, /costAccounting:\s*"not_configured"/);
  assert.match(data, /apiCalls:\s*0/);
  assert.doesNotMatch(`${data}\n${live}\n${rightPanel}\n${topBar}`, /tokensBudget:\s*200000/);
  assert.doesNotMatch(`${data}\n${live}\n${rightPanel}\n${topBar}`, /costBudgetUsd:\s*5(?:\.0)?/);
  assert.match(rightPanel, /限额未配置/);
  assert.match(rightPanel, /单价未配置/);
  assert.match(topBar, /usage\.costUsd == null/);
  assert.match(topBar, /成本未配置/);
  assert.match(app, /usageBaseline/);
  assert.match(app, /usageSnapshotDelta\(usageSnapshot,\s*usageBaseline\)/);
  assert.match(app, /refreshUsageAndFiles\(nextGroup\.path,\s*\{\s*asBaseline:\s*true\s*\}\)/);
  assert.match(live, /export function usageSnapshotDelta/);
  assert.match(live, /subtractUsageTotals/);
});

test("transcript follows live output only while the reader remains at the bottom", () => {
  const app = read("renderer/components/council/council-app.tsx");

  assert.match(app, /transcriptAtBottom/);
  assert.match(app, /remaining <= 48/);
  assert.match(app, /scrollTop = scrollContainer\.scrollHeight/);
  assert.match(app, /onScroll=\{updateTranscriptScrollPosition\}/);
});

test("task header does not show generic AI mode helper text", () => {
  const transcriptPanel = read("renderer/components/council/transcript-panel.tsx");
  assert.doesNotMatch(transcriptPanel, /WORK_MODE_HINT/);
  assert.doesNotMatch(transcriptPanel, /<span>\{WORK_MODE_HINT\[mode\]\}<\/span>/);
});

test("preferences wording is removed while group pin and delete actions are wired", () => {
  const sidebar = read("renderer/components/council/groups-sidebar.tsx");
  const topBar = read("renderer/components/council/top-bar.tsx");
  const settings = read("renderer/components/council/settings-sheet.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");

  assert.doesNotMatch(`${sidebar}\n${topBar}\n${settings}`, /偏好设置/);
  assert.doesNotMatch(`${sidebar}\n${topBar}`, /Settings2/);
  assert.match(sidebar, /aria-label=\{group\.pinned \? "取消置顶" : "置顶"\}/);
  assert.match(sidebar, /aria-label="删除小组"/);
  assert.match(app, /handleToggleGroupPin/);
  assert.match(app, /handleDeleteGroup/);
  assert.match(live, /\/api\/groups-index\/update/);
  assert.match(live, /\/api\/groups-index\/remove/);
});

test("settings page is category-first and avoids explanatory filler text", () => {
  const settings = read("renderer/components/council/settings-sheet.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const sidebar = read("renderer/components/council/groups-sidebar.tsx");
  const live = read("renderer/lib/council-live.ts");

  for (const label of [
    "议会规则",
    "模型服务",
    "网络搜索",
    "MCP 服务器",
    "技能",
    "插件",
    "公共记忆",
    "数据设置",
    "权限安全",
  ]) {
    assert.match(settings, new RegExp(label));
  }

  assert.doesNotMatch(settings, /disabled:\s*true/);
  assert.doesNotMatch(settings, /未接入/);
  assert.match(settings, /fetchProviderPresets/);
  assert.match(settings, /fetchCapabilities/);
  assert.match(settings, /fetchMcpCatalog/);
  assert.match(settings, /fetchMcpServers/);
  assert.match(settings, /searchMcpPackages/);
  assert.match(settings, /installMcpCatalogItem/);
  assert.match(settings, /installMcpPackage/);
  assert.match(settings, /uninstallMcpServer/);
  assert.match(settings, /mcpCatalogDisplay/);
  assert.match(settings, /runtimeStatus === "files_missing"/);
  assert.match(settings, /runtimeStatus === "package_only"/);
  assert.match(settings, /文件缺失/);
  assert.doesNotMatch(settings, /serverConfigured && item\.packageInstalled === false/);
  assert.match(settings, /item\.packageInstalled && !item\.serverConfigured/);
  assert.match(settings, /item\.serverConfigured && item\.serverEnabled === false/);
  assert.match(live, /\/api\/capabilities/);
  assert.match(live, /\/api\/mcp\/catalog/);
  assert.match(live, /\/api\/mcp\/search/);
  assert.match(live, /\/api\/mcp\/install/);
  assert.match(live, /\/api\/mcp\/uninstall/);
  assert.match(settings, /CAPABILITY_SWITCHES\.map/);
  assert.match(settings, /checked=\{access\[item\.key\] !== false\}/);
  assert.match(settings, /onChange=\{\(\) => onToggle\(item\.key\)\}/);
  for (const key of ["web", "files", "automation", "browser", "database", "memory", "mcp", "skills"]) {
    assert.match(settings, new RegExp(`key: ["']${key}["']`));
  }
  assert.match(app, /toolAccess: values\.toolAccess/);
  assert.match(live, /toolAccess\?: CapabilityAccess/);

  for (const text of [
    "议会规则应用",
    "能力设置",
    "填写 Brave",
    "工具授权或完全允许",
    "这些设置会",
    "控制成员之间",
    "对全体成员生效",
    "达到上限后",
    "限制单个成员",
  ]) {
    assert.doesNotMatch(settings, new RegExp(text));
  }

  assert.doesNotMatch(settings, /description=/);
  assert.doesNotMatch(settings, /hint=/);
  assert.doesNotMatch(sidebar, />\s*全局要求\s*</);
  assert.match(sidebar, />\s*设置\s*</);
});

test("renderer does not seed undeletable demo council groups", () => {
  const data = read("renderer/lib/council-data.ts");
  const app = read("renderer/components/council/council-app.tsx");

  for (const text of [
    "架构评审议会",
    "安全合规小组",
    "增长策略圆桌",
    "文案润色组",
    "论文调研团",
    "g-arch",
    "g-sec",
    "v0 示例",
  ]) {
    assert.doesNotMatch(`${data}\n${app}`, new RegExp(text));
  }

  assert.match(data, /export const groups: Group\[\] = \[\]/);
  assert.match(data, /export const members: AgentMember\[\] = \[\]/);
  assert.doesNotMatch(app, /fallbackGroups/);
  assert.doesNotMatch(app, /fallbackMembers/);
  assert.match(app, /useState<LiveGroup\[\]>\(\[\]\)/);
});

test("server exposes actual guarded file-operation APIs", () => {
  const live = read("renderer/lib/council-live.ts");
  const server = read("src/server.js");
  const app = read("renderer/components/council/council-app.tsx");
  const right = read("renderer/components/council/right-panel.tsx");
  assert.match(live, /\/api\/file-operations\/approve/);
  assert.match(live, /\/api\/file-operations\/reject/);
  assert.match(live, /\/api\/file-operations\/execute/);
  assert.match(live, /\/api\/file-operations\/restore/);
  assert.match(live, /canRestore/);
  assert.match(app, /handleFileOperation\("restore"/);
  assert.match(right, /onRestoreFileOp/);
  assert.match(right, /RotateCcw/);
  assert.match(right, /fileOp\.status === "approved" && !fileOp\.canRestore/);
  assert.match(server, /approvePendingFileOperation/);
  assert.match(server, /rejectPendingFileOperation/);
  assert.match(server, /executeApprovedFileOperation/);
  assert.doesNotMatch(live, /["']\/api\/execute["']/);
  assert.doesNotMatch(server, /["']\/api\/execute["']/);
});

test("file operation audit history is not rendered as actionable pending work", () => {
  const live = read("renderer/lib/council-live.ts");
  const queue = read("src/fileOperationQueue.js");
  assert.match(live, /const terminalAudit = audit\.filter/);
  assert.match(live, /terminalAuditFileOpStatus\(item\.status, item\.action\)/);
  assert.match(live, /fileOperationToUi\(raw, index, false\)/);
  assert.match(live, /fileOperationToUi\(raw, pending\.length \+ index, true\)/);
  assert.match(live, /function terminalAuditFileOpStatus\(status\?: string, action\?: string\)/);
  assert.match(live, /return null/);
  assert.match(queue, /status: item\.status/);
});

test("renderer source does not contain common mojibake markers", () => {
  const files = [
    "renderer/app/layout.tsx",
    "renderer/components/council/council-app.tsx",
    "renderer/components/council/groups-sidebar.tsx",
    "renderer/components/council/settings-sheet.tsx",
    "renderer/components/council/top-bar.tsx",
    "renderer/components/council/right-panel.tsx",
    "renderer/components/council/member-config-sheet.tsx",
    "renderer/components/council/composer.tsx",
    "renderer/components/council/transcript-panel.tsx",
    "renderer/lib/council-data.ts",
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /灏忕粍|璇达細|鍏ㄥ|鏅鸿兘|闃诲|绉佽亰|寰呭|鐩戣€?/);
  }
});

test("renderer sends real file attachments with council messages", () => {
  const composer = read("renderer/components/council/composer.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");
  assert.match(composer, /Paperclip/);
  assert.doesNotMatch(composer, /FolderOpen/);
  assert.match(composer, /type="file"/);
  assert.match(composer, /file\.text\(\)/);
  assert.match(composer, /importProjectFolder/);
  assert.match(composer, /onDrop/);
  assert.match(composer, /dataTransfer\.items/);
  assert.match(composer, /getDesktopFilePath/);
  assert.match(composer, /readDroppedDirectory/);
  assert.doesNotMatch(composer, /pickProjectFolder/);
  assert.match(composer, /MAX_ATTACHMENT_BYTES/);
  assert.match(composer, /attachments: files/);
  assert.doesNotMatch(live, /\/api\/project-folder-picker/);
  assert.match(live, /\/api\/project\/import/);
  assert.match(app, /type FileAttachment/);
  assert.match(app, /attachments,\s*\n\s*\}/);
});

test("renderer keeps per-group drafts and opens real chat history", () => {
  const composer = read("renderer/components/council/composer.tsx");
  const app = read("renderer/components/council/council-app.tsx");
  const topBar = read("renderer/components/council/top-bar.tsx");
  const history = read("renderer/components/council/chat-history-sheet.tsx");
  const live = read("renderer/lib/council-live.ts");
  const data = read("renderer/lib/council-data.ts");

  assert.match(composer, /DRAFT_PREFIX/);
  assert.match(composer, /draftKey/);
  assert.match(composer, /localStorage\.getItem/);
  assert.match(composer, /localStorage\.setItem/);
  assert.match(app, /draftKey=\{group\.path \|\| group\.id \|\| ""\}/);
  assert.match(topBar, /聊天记录/);
  assert.match(history, /fetchChatSessions/);
  assert.match(history, /fetchChatSession/);
  assert.match(history, /window\.setInterval/);
  assert.match(history, /window\.clearInterval/);
  assert.match(history, /setSelectedId\(\(currentId\)/);
  assert.match(live, /\/api\/sessions\?groupPath=/);
  assert.match(live, /\/api\/session\?groupPath=/);
  assert.match(data, /完全允许就是自主执行/);
});

test("renderer data layer exposes real public memory APIs for the future settings UI", () => {
  const live = read("renderer/lib/council-live.ts");
  assert.match(live, /PublicMemoryRecord/);
  assert.match(live, /fetchPublicMemories/);
  assert.match(live, /savePublicMemory/);
  assert.match(live, /deletePublicMemory/);
  assert.match(live, /\/api\/public-memory/);
});

test("renderer does not show failed or incomplete final decisions as completed", () => {
  const live = fs.readFileSync(path.join(root, "renderer", "lib", "council-live.ts"), "utf8");
  assert.match(live, /finalState === "ready_to_execute" \|\| finalState === "usable_with_risks" \? "completed" : "unavailable"/);
});

test("renderer preserves interim streamed member attempts in live and saved history", () => {
  const app = fs.readFileSync(path.join(root, "renderer", "components", "council", "council-app.tsx"), "utf8");
  const history = fs.readFileSync(path.join(root, "renderer", "components", "council", "chat-history-sheet.tsx"), "utf8");
  const live = fs.readFileSync(path.join(root, "renderer", "lib", "council-live.ts"), "utf8");

  assert.match(app, /event\.type === "agent_interim"/);
  assert.match(app, /partials\.current\[event\.message\.agentId\] = ""/);
  assert.match(history, /sessionTranscriptMessages\(session\)/);
  assert.match(history, /session\.interimMessages/);
  assert.match(live, /interimMessages\?: CouncilMessage\[\]/);
});

test("renderer displays real duration fields and configurable agent timeout", () => {
  const data = read("renderer/lib/council-data.ts");
  const live = read("renderer/lib/council-live.ts");
  const app = read("renderer/components/council/council-app.tsx");
  const settings = read("renderer/components/council/settings-sheet.tsx");
  const transcript = read("renderer/components/council/transcript-panel.tsx");

  assert.match(data, /durationMs\?: number/);
  assert.match(live, /durationMs: Number\(message\.durationMs/);
  assert.match(live, /second: "2-digit"/);
  assert.match(app, /agentTimeoutMinutes/);
  assert.match(app, /agentTimeoutMs: values\.agentTimeoutMinutes \* 60_000/);
  assert.match(settings, /单个 AI 最长等待时间/);
  assert.match(transcript, /用时 \{formatDuration\(item\.durationMs\)\}/);
});

test("renderer does not prefix the user's submitted question with a speaker label", () => {
  const app = read("renderer/components/council/council-app.tsx");
  const transcript = read("renderer/components/council/transcript-panel.tsx");
  assert.match(app, /:\s*question,/);
  assert.doesNotMatch(app, /`你：\$\{question\}/);
  assert.match(transcript, /cleanSystemBody\(item\.body\)/);
  assert.match(transcript, /replace\(\/\^\\s\*你\[:：\]\\s\*\//);
});
