import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readAppSettings, updateAppSettings, userDataDir } from "./appSettings.js";
import { loadJson, validateGroupConfig, validateRuntimeEnv } from "./config.js";
import { runCouncil, runCouncilEvents } from "./discussionEngine.js";
import { approveExecutionStandards, prepareExecutionStandards, readExecutionStandards } from "./executionStandards.js";
import { approvePendingFileOperation, autoApprovePendingFileOperation, executeApprovedFileOperation, rejectPendingFileOperation } from "./fileOperationExecutor.js";
import { listFileOperationReviewItems, readFileOperationAuditLog } from "./fileOperationQueue.js";
import { readGroupIndex, recordIdForPath, removeGroupIndexRecord, updateGroupIndexRecord, upsertGroupIndexRecord } from "./groupIndex.js";
import { resolveInside } from "./pathGuards.js";
import { callAgent } from "./modelClient.js";
import { appendPrivateChatMessage, readPrivateChatMessages, readPrivateContextMessages } from "./privateChat.js";
import { listProviderPresets } from "./providerRegistry.js";
import { discoverProviderModels, checkProviderHealth } from "./modelDiscovery.js";
import { readUsageSnapshot } from "./usageStats.js";
import { addMember, initGroupWorkspace, replaceMember } from "./workspaceManager.js";
import { addReview, createRecorderDraft, finalizeDraft, listApproved, listDrafts } from "./writeFlow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, "..");
const rendererOutDir = path.join(baseDir, "renderer", "out");
const publicDir = rendererOutDir;
const port = Number(process.env.AI_COUNCIL_UI_PORT || 4317);
const host = process.env.AI_COUNCIL_UI_HOST || "127.0.0.1";
const dataDir = userDataDir(baseDir);
const allowedWorkspaceRoot = path.resolve(process.env.AI_COUNCIL_WORKSPACE_ROOT || (process.env.AI_COUNCIL_DATA_DIR ? dataDir : baseDir));
const defaultGroupsRoot = path.join(process.env.AI_COUNCIL_DATA_DIR ? dataDir : baseDir, "workspace-ui");
const execFileAsync = promisify(execFile);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`AI Council UI: http://${host}:${port}`);
  console.log(`Allowed workspace root: ${allowedWorkspaceRoot}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, baseDir, host, allowedWorkspaceRoot });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    sendJson(res, 200, {
      ok: true,
      modelApi: {
        canReadLocalFiles: false,
        canWriteLocalFiles: false,
        canCallLocalTools: false,
        transport: "OpenAI-compatible /chat/completions and Anthropic /messages text calls"
      },
      localServer: {
        canReadWriteWorkspaceFiles: true,
        allowedWorkspaceRoot,
        pathGuard: "resolveInside(allowedWorkspaceRoot, input)"
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/providers") {
    sendJson(res, 200, { providers: listProviderPresets() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/models/discover") {
    const body = await readBody(req);
    sendJson(res, 200, await discoverProviderModels({
      providerId: body.providerId,
      apiBaseUrl: body.apiBaseUrl,
      apiKey: body.apiKey,
      timeoutMs: body.timeoutMs,
      useCache: body.useCache
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/models/health") {
    const body = await readBody(req);
    sendJson(res, 200, await checkProviderHealth({
      providerId: body.providerId,
      apiBaseUrl: body.apiBaseUrl,
      apiKey: body.apiKey,
      timeoutMs: body.timeoutMs,
      useCache: body.useCache
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/git/status") {
    sendJson(res, 200, await gitStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/folder-picker") {
    sendJson(res, 200, await pickFolder());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/group") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, readJson(path.join(groupPath, "group.json")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/app-settings") {
    sendJson(res, 200, readAppSettings(baseDir, { groupsRoot: defaultGroupsRoot }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/app-settings") {
    const body = await readBody(req);
    const groupsRoot = body.groupsRoot ? resolveWorkspaceRoot(body.groupsRoot) : defaultGroupsRoot;
    sendJson(res, 200, updateAppSettings(baseDir, {
      groupsRoot,
      firstRunComplete: body.firstRunComplete !== false
    }, { groupsRoot: defaultGroupsRoot }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/groups-index") {
    sendJson(res, 200, readGroupIndex(baseDir));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/drafts") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, listDrafts(groupPath, { status: url.searchParams.get("status") || undefined }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/approved") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, listApproved(groupPath));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/execution-standards") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, readExecutionStandards(groupPath));
    return;
  }


  if (req.method === "GET" && url.pathname === "/api/file-operations") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, {
      pending: listFileOperationReviewItems(groupPath),
      audit: readFileOperationAuditLog(groupPath).slice(-50).reverse()
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/private-chat") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    const seatId = requireQuery(url, "seatId");
    const seat = optionalJsonQuery(url, "seat");
    sendJson(res, 200, { messages: readPrivateChatMessages(groupPath, seatId, { seat }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/private-chat") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    const seatId = String(body.seatId || "");
    const bossMessage = appendPrivateChatMessage(groupPath, seatId, body.text, { from: body.from || "boss", seat: body.seat });
    const reply = await replyToPrivateMessage(groupPath, seatId, body);
    sendJson(res, 200, { ok: true, message: bossMessage, reply });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const groupPath = resolveWorkspacePath(requireQuery(url, "groupPath"), "groupPath");
    sendJson(res, 200, readUsageSnapshot(groupPath, readJson(path.join(groupPath, "group.json"))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/init") {
    const body = await readBody(req);
    body.root = resolveWorkspaceRoot(body.root);
    const group = initGroupWorkspace(body);
    upsertGroupIndexRecord(baseDir, groupIndexRecordFromGroup(group));
    sendJson(res, 200, group);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/add-member") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    const result = addMember(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups-index/upsert") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.path || body.groupPath, "groupPath");
    sendJson(res, 200, upsertGroupIndexRecord(baseDir, {
      id: body.id || recordIdForPath(groupPath),
      name: body.name || path.basename(groupPath),
      path: groupPath,
      pinned: body.pinned,
      lastOpenedAt: body.lastOpenedAt || new Date().toISOString()
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups-index/update") {
    const body = await readBody(req);
    sendJson(res, 200, updateGroupIndexRecord(baseDir, String(body.id || ""), {
      name: body.name,
      pinned: body.pinned,
      lastOpenedAt: body.lastOpenedAt
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups-index/remove") {
    const body = await readBody(req);
    const id = String(body.id || "");
    const index = readGroupIndex(baseDir);
    const record = index.groups.find((item) => item.id === id);
    if (!record) throw new Error(`Unknown group id: ${id}`);
    let deletedPath;
    if (body.deleteData) {
      deletedPath = deleteWorkspaceGroupFolder(record.path);
    }
    sendJson(res, 200, {
      ok: true,
      index: removeGroupIndexRecord(baseDir, id),
      deletedPath
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/replace-member") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, replaceMember(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/write-flow/create-draft") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, createRecorderDraft(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/write-flow/add-review") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, addReview(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/write-flow/finalize") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, finalizeDraft(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execution-standards/prepare") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, prepareExecutionStandards(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execution-standards/approve") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, approveExecutionStandards(body));
    return;
  }


  if (req.method === "POST" && url.pathname === "/api/file-operations/approve") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, approvePendingFileOperation(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file-operations/reject") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, rejectPendingFileOperation(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file-operations/auto-approve") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, autoApprovePendingFileOperation(body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file-operations/execute") {
    const body = await readBody(req);
    body.groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    sendJson(res, 200, executeApprovedFileOperation(body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/council/run") {
    const body = await readBody(req);
    const group = loadCouncilGroupFromRequest(body);
    const workspaceGroupPath = body.workspaceGroupPath
      ? resolveWorkspacePath(body.workspaceGroupPath, "workspaceGroupPath")
      : undefined;
    const result = await runCouncil(body.question, group, baseDir, {
      groupPath: workspaceGroupPath,
      globalRequirement: body.globalRequirement || group.settings?.globalRequirement || "",
      continuationContext: body.continuationContext
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/group/global-requirement") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    const group = updateGroupGlobalRequirement(groupPath, body.globalRequirement || "");
    sendJson(res, 200, { ok: true, group });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/group/permissions") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    if (requiresGit(body.defaultTier) || Object.values(body.seatTiers || {}).some(requiresGit)) {
      const status = await gitStatus();
      if (!status.ok) throw new Error("Git is required before enabling tool permissions.");
    }
    const group = updateGroupPermissions(groupPath, {
      defaultTier: body.defaultTier,
      seatTiers: body.seatTiers
    });
    sendJson(res, 200, { ok: true, group });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/group/settings") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    const group = updateGroupSettings(groupPath, body);
    sendJson(res, 200, { ok: true, group });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/group/seat") {
    const body = await readBody(req);
    const groupPath = resolveWorkspacePath(body.groupPath, "groupPath");
    const tier = body.permission || body.tier;
    if (requiresGit(tier)) {
      const status = await gitStatus();
      if (!status.ok) throw new Error("Git is required before enabling tool permissions.");
    }
    sendJson(res, 200, updateGroupSeat(groupPath, body));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/council/events") {
    const body = await readBody(req);
    const group = loadCouncilGroupFromRequest(body);
    const workspaceGroupPath = body.workspaceGroupPath
      ? resolveWorkspacePath(body.workspaceGroupPath, "workspaceGroupPath")
      : undefined;
    await streamCouncilEvents(req, res, body.question, group, {
      groupPath: workspaceGroupPath,
      globalRequirement: body.globalRequirement || group.settings?.globalRequirement || "",
      startAfterAgentId: body.startAfterAgentId || "",
      startAtAgentId: body.startAtAgentId || "",
      resumeInstruction: body.resumeInstruction || "",
      continuationContext: body.continuationContext
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${cleanPath}`);
  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function groupIndexRecordFromGroup(group) {
  return {
    id: recordIdForPath(group.groupPath),
    name: group.groupFolderName || path.basename(group.groupPath),
    path: group.groupPath,
    pinned: false,
    lastOpenedAt: new Date().toISOString()
  };
}

function deleteWorkspaceGroupFolder(inputPath) {
  const groupPath = resolveWorkspacePath(inputPath, "groupPath");
  const groupConfigPath = path.join(groupPath, "group.json");
  if (!fs.existsSync(groupConfigPath)) {
    throw new Error("Cannot delete group data because group.json was not found");
  }
  if (path.resolve(groupPath) === path.resolve(allowedWorkspaceRoot)) {
    throw new Error("Cannot delete the workspace root");
  }
  fs.rmSync(groupPath, { recursive: true, force: true });
  return groupPath;
}

async function replyToPrivateMessage(groupPath, seatId, body) {
  const runtimeGroup = body.runtimeGroup && typeof body.runtimeGroup === "object" ? body.runtimeGroup : null;
  if (!runtimeGroup) return null;
  const agent = (runtimeGroup.agents || []).find((item) => item.id === seatId || item.name === seatId);
  if (!agent || agent.enabled === false) return null;
  const history = readPrivateContextMessages(groupPath, seatId, { seat: body.seat });
  const role = agent.role || agent.name || "成员";
  const messages = [
    {
      role: "system",
      content: `你是 ${role}（${agent.name || role}），正在与老板进行一对一私聊。请用中文简洁、直接地回复，只代表你自己，不要假装其他成员，也不要提及其他成员的私聊内容。`
    },
    ...history.map((item) => ({
      role: item.from === "boss" ? "user" : "assistant",
      content: item.text
    }))
  ];
  try {
    const replyText = await callAgent(agent, messages, { timeoutMs: 60000 });
    const text = String(replyText || "").trim();
    if (!text) return null;
    return appendPrivateChatMessage(groupPath, seatId, text, { from: seatId, seat: body.seat });
  } catch (error) {
    return appendPrivateChatMessage(groupPath, seatId, `（回复失败：${error.message}）`, { from: seatId, seat: body.seat, status: "error" });
  }
}

function loadCouncilGroupFromRequest(body) {
  const rawGroup = body.runtimeGroup && typeof body.runtimeGroup === "object"
    ? body.runtimeGroup
    : loadJson(body.groupConfigPath || path.join(baseDir, "config", "group.example.json"));
  if (body.maxRounds !== undefined) {
    rawGroup.settings = {
      ...(rawGroup.settings || {}),
      maxRounds: normalizeMaxRounds(body.maxRounds)
    };
  }
  const group = validateGroupConfig(rawGroup);
  validateRuntimeEnv(group);
  return group;
}

function normalizeMaxRounds(value) {
  const count = Number.parseInt(String(value || 1), 10);
  if (!Number.isFinite(count)) return 1;
  return Math.min(100, Math.max(1, count));
}

function updateGroupGlobalRequirement(groupPath, globalRequirement) {
  const groupFile = path.join(groupPath, "group.json");
  const group = readJson(groupFile);
  group.settings = {
    ...(group.settings || {}),
    globalRequirement: String(globalRequirement || "").trim()
  };
  fs.writeFileSync(groupFile, JSON.stringify(group, null, 2), "utf8");
  return group;
}

function updateGroupSettings(groupPath, settings = {}) {
  const groupFile = path.join(groupPath, "group.json");
  const group = readJson(groupFile);
  const nextSettings = { ...(group.settings || {}) };
  if (settings.globalRequirement !== undefined) {
    nextSettings.globalRequirement = String(settings.globalRequirement || "").trim();
  }
  if (settings.maxRounds !== undefined) {
    nextSettings.maxRounds = normalizeMaxRounds(settings.maxRounds);
  }
  if (settings.workMode !== undefined) {
    nextSettings.workMode = normalizeWorkMode(settings.workMode);
  }
  group.settings = nextSettings;
  fs.writeFileSync(groupFile, JSON.stringify(group, null, 2), "utf8");
  return group;
}

function updateGroupPermissions(groupPath, permissions = {}) {
  const groupFile = path.join(groupPath, "group.json");
  const group = readJson(groupFile);
  const defaultTier = normalizePermissionTier(permissions.defaultTier || group.permissions?.defaultTier || "text");
  const seatTiers = {};
  for (const [seatId, tier] of Object.entries(permissions.seatTiers || group.permissions?.seatTiers || {})) {
    seatTiers[seatId] = normalizePermissionTier(tier);
  }
  group.permissions = { defaultTier, seatTiers };
  fs.writeFileSync(groupFile, JSON.stringify(group, null, 2), "utf8");
  return group;
}

function updateGroupSeat(groupPath, body = {}) {
  const groupFile = path.join(groupPath, "group.json");
  const group = readJson(groupFile);
  const seatId = String(body.seatId || "").trim();
  if (!seatId) throw new Error("Missing seatId");
  const seats = group.seats || group.agents || [];
  const seat = seats.find((item) => (item.seatId || item.id) === seatId);
  if (!seat) throw new Error(`Unknown seatId: ${seatId}`);

  const patch = body.patch && typeof body.patch === "object" ? body.patch : body;
  if (patch.displayName !== undefined || patch.name !== undefined) {
    seat.displayName = cleanOptionalString(patch.displayName ?? patch.name);
  }
  if (patch.model !== undefined || patch.currentModel !== undefined) {
    const model = cleanOptionalString(patch.model ?? patch.currentModel);
    seat.currentModel = model;
    seat.model = model;
  }
  if (patch.apiBaseUrl !== undefined || patch.apiUrl !== undefined) {
    const apiBaseUrl = cleanOptionalString(patch.apiBaseUrl ?? patch.apiUrl);
    seat.apiBaseUrl = apiBaseUrl;
    seat.apiUrl = apiBaseUrl;
  }
  if (patch.providerPreset !== undefined) {
    seat.providerPreset = cleanOptionalString(patch.providerPreset);
  }
  if (patch.apiKey !== undefined) {
    const apiKey = cleanOptionalString(patch.apiKey);
    if (apiKey && !apiKey.includes("***")) seat.apiKey = apiKey;
  }
  if (patch.enabled !== undefined) {
    seat.enabled = Boolean(patch.enabled);
  }
  if (patch.reviewIntensity !== undefined) {
    seat.reviewIntensity = normalizeReviewIntensity(patch.reviewIntensity);
  }
  if (patch.role !== undefined) {
    applySeatRole(seat, patch.role);
  }
  const permission = patch.permission || patch.tier;
  if (permission !== undefined) {
    group.permissions = group.permissions || { defaultTier: "text", seatTiers: {} };
    group.permissions.defaultTier = normalizePermissionTier(group.permissions.defaultTier || "text");
    group.permissions.seatTiers = group.permissions.seatTiers || {};
    group.permissions.seatTiers[seatId] = normalizePermissionTier(permission);
  }

  fs.writeFileSync(groupFile, JSON.stringify(group, null, 2), "utf8");
  return { ok: true, group, seat };
}

function applySeatRole(seat, role) {
  const normalized = String(role || "ordinary");
  seat.role = normalized === "reviewer" || normalized === "summarizer" ? normalized : "ordinary";
  if (normalized === "reviewer") {
    seat.reviewer = true;
    seat.mandatoryRedTeam = true;
    seat.judge = false;
    return;
  }
  if (normalized === "summarizer") {
    seat.reviewer = false;
    seat.mandatoryRedTeam = false;
    seat.judge = true;
    return;
  }
  seat.reviewer = false;
  seat.mandatoryRedTeam = false;
  seat.judge = false;
}

function normalizeWorkMode(value) {
  return value === "independent" ? "independent" : "collab";
}

function normalizeReviewIntensity(value) {
  const count = Number.parseInt(String(value || 2), 10);
  if (count === 1 || count === 2 || count === 3) return count;
  return 2;
}

function cleanOptionalString(value) {
  return String(value || "").trim();
}

async function gitStatus() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: baseDir,
      timeout: 5000,
      windowsHide: true
    });
    return { ok: stdout.trim() === "true", requiredFor: ["tool", "full"] };
  } catch {
    return { ok: false, requiredFor: ["tool", "full"] };
  }
}

function normalizePermissionTier(value) {
  if (["text", "tool", "full"].includes(value)) return value;
  throw new Error(`Unknown permission tier: ${value}`);
}

function requiresGit(value) {
  return value === "tool" || value === "full";
}

async function pickFolder() {
  if (process.platform !== "win32") {
    return { supported: false, path: "" };
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择 AI 小组文件夹'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }"
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      script
    ], { timeout: 120000, windowsHide: false });
    const selected = stdout.trim();
    return {
      supported: true,
      path: selected,
      containsGroup: selected ? fs.existsSync(path.join(selected, "group.json")) : false
    };
  } catch {
    return { supported: false, path: "" };
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function streamCouncilEvents(req, res, question, group, options = {}) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  try {
    for await (const event of runCouncilEvents(question, group, baseDir, {
      ...options,
      signal: controller.signal
    })) {
      writeSse(res, event.type, event);
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      writeSse(res, "error", { type: "error", error: error.message, createdAt: new Date().toISOString() });
    }
  } finally {
    res.end();
  }
}

function writeSse(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function requireQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalJsonQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolveWorkspacePath(input, name) {
  return resolveInside(allowedWorkspaceRoot, input, { baseDir, name });
}

function resolveWorkspaceRoot(input) {
  return resolveInside(allowedWorkspaceRoot, input, { baseDir, name: "root" });
}
