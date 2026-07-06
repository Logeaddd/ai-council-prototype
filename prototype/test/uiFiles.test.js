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

test("renderer wires the real council APIs instead of mock-only UI state", () => {
  const live = read("renderer/lib/council-live.ts");
  const app = read("renderer/components/council/council-app.tsx");
  for (const endpoint of [
    "/api/groups-index",
    "/api/group?groupPath=",
    "/api/council/events",
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
    assert.match(`${live}\n${app}`, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(app, /streamCouncilEvents/);
  assert.match(app, /AbortController/);
  assert.match(app, /workspaceGroupToRuntimeGroup/);
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
  const server = read("src/server.js");
  assert.match(composer, /私聊会写入该成员的私有记录/);
  assert.match(composer, /privateMode/);
  assert.match(app, /async function handlePrivateMessage/);
  assert.match(app, /private-hint/);
  assert.match(app, /\/api\/private-chat/);
  assert.match(app, /reply\.status === "error"/);
  assert.match(server, /\/api\/private-chat/);
  assert.match(server, /status: "error"/);
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
  assert.match(live, /\/api\/file-operations\/approve/);
  assert.match(live, /\/api\/file-operations\/reject/);
  assert.match(live, /\/api\/file-operations\/execute/);
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
