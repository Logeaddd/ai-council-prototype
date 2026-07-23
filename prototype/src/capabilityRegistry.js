import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capabilityEnabled } from "./capabilityPolicy.js";
import { listCapabilityFacts, mergeCapabilityFacts } from "./capabilityFacts.js";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function listCapabilities(options = {}) {
  const keyInfo = resolveSearchApiKeyInfo(options);
  const searchConfigured = Boolean(keyInfo.apiKey);
  const runtime = options.runtimeFacts || probeCapabilityRuntime(options);
  const local = (ok) => ok ? "ready" : "unavailable";
  const external = (ok) => ok ? "unverified" : "unavailable";
  const enabled = (family) => capabilityEnabled(normalizedSettings(options), family);

  const capabilities = [
    capability("web-search", "联网搜索", "tool", external(runtime.webRuntime), enabled("web"), "web", {
      provider: searchConfigured ? "Brave Search" : "Bing Web",
      source: searchConfigured ? keyInfo.source : "built_in_html",
      requirement: "本地搜索实现已检查；公共网络与搜索服务未在状态查询中发起实时请求。",
      health: health(runtime.webRuntime, false, runtime.webRuntime ? "local web search implementation present" : "web search implementation missing")
    }),
    capability("fetch-url", "读取网页", "tool", external(runtime.webRuntime), enabled("web"), "web", {
      provider: "built-in",
      source: "local_server",
      requirement: "仅允许公共 URL；状态查询不代表目标网站当前可达。",
      health: health(runtime.webRuntime, false, runtime.webRuntime ? "local fetch implementation present" : "fetch implementation missing")
    }),
    capability("api-request", "接口请求", "tool", external(runtime.webRuntime), enabled("web"), "web", {
      provider: "built-in",
      source: "local_server",
      requirement: "仅允许公共 URL；状态查询不代表外部 API 当前可达。",
      health: health(runtime.webRuntime, false, runtime.webRuntime ? "local HTTP client present" : "HTTP client implementation missing")
    }),
    capability("workspace-files", "工作区文件", "tool", local(runtime.filesystem), enabled("files"), "files", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要工具或完全权限，以及工作区或用户明确授权的项目目录。",
      health: health(runtime.filesystem, true, runtime.filesystem ? "local filesystem is readable and writable" : "local filesystem is not writable")
    }),
    capability("extract-archive", "解压归档", "tool", local(runtime.archiveRuntime), enabled("files"), "files", archiveMetadata(runtime)),
    capability("create-archive", "创建归档", "tool", local(runtime.archiveRuntime), enabled("files"), "files", archiveMetadata(runtime)),
    capability("execute-command", "终端", "tool", local(runtime.shell), enabled("automation"), "automation", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要完全权限；管道、重定向和 Shell 后台语法由所选 Shell 执行。",
      health: health(runtime.shell, true, runtime.shellDetail)
    }),
    capability("background-processes", "后台进程", "tool", local(runtime.backgroundRuntime), enabled("automation"), "automation", {
      provider: "built-in",
      source: "managed_background_process",
      requirement: "需要完全权限。",
      health: health(runtime.backgroundRuntime, true, runtime.backgroundRuntime ? "background supervisor present" : "background supervisor unavailable")
    }),
    capability("run-code", "运行代码", "tool", local(runtime.codeRuntime), enabled("automation"), "automation", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要完全权限。",
      health: health(runtime.codeRuntime, true, runtime.codeRuntimeDetail)
    }),
    capability("install-package", "安装语言依赖", "tool", local(runtime.packageRuntime), enabled("automation"), "automation", {
      provider: "built-in",
      source: "managed_environment",
      requirement: "需要完全权限。",
      health: health(runtime.packageRuntime, true, runtime.packageRuntimeDetail)
    }),
    capability("provision-tool", "获取外部工具", "tool", local(runtime.provisionRuntime), enabled("automation"), "automation", {
      provider: "built-in",
      source: "managed_tool_provisioner",
      requirement: "需要完全权限；未知工具仍需模型搜索出包名、安装命令或下载地址。",
      health: health(runtime.provisionRuntime, true, runtime.provisionRuntimeDetail)
    }),
    capability("run-tests", "运行测试", "tool", local(runtime.testRuntime), enabled("automation"), "automation", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要完全权限。",
      health: health(runtime.testRuntime, true, runtime.testRuntimeDetail)
    }),
    capability("git-operation", "Git", "tool", local(runtime.git), enabled("automation"), "automation", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要完全权限。",
      health: health(runtime.git, true, runtime.gitDetail)
    }),
    capability("browser-control", "浏览器控制", "tool", local(runtime.browser), enabled("browser"), "browser", {
      provider: "Electron",
      source: "local_server",
      requirement: "需要完全权限。",
      health: health(runtime.browser, true, runtime.browserDetail)
    }),
    capability("database-query", "数据库", "tool", local(runtime.database), enabled("database"), "database", {
      provider: "built-in SQLite",
      source: "local_server",
      requirement: "读取需要工具权限，写入需要完全权限。",
      health: health(runtime.database, true, runtime.databaseDetail)
    }),
    capability("public-memory", "公共记忆", "memory", local(runtime.memoryRuntime), enabled("memory"), "memory", {
      provider: "built-in",
      source: "local_server",
      requirement: "需要可写的小组工作区。",
      health: health(runtime.memoryRuntime, true, runtime.memoryRuntime ? "memory implementation and writable data root present" : "memory storage unavailable")
    }),
    capability("skill-packs", "技能", "skill", local(runtime.skillRuntime), enabled("skills"), "skills", {
      provider: "built-in",
      source: "local_skill_store",
      requirement: "安装远程技能还需要真实公共网络。",
      health: health(runtime.skillRuntime, true, runtime.skillRuntime ? "local skill store writable" : "skill store unavailable")
    }),
    capability("mcp-web-tools", "MCP 联网工具", "mcp_server", local(runtime.mcpRuntime), enabled("mcp") && enabled("web"), "mcp", {
      provider: "built-in",
      source: "local_stdio",
      command: "npm run mcp:web",
      tools: ["web_search", "fetch_url"],
      requirement: enabled("web") ? "本地 MCP stdio 运行时已检查；公共网络状态另行验证。" : "联网工具已停用。",
      health: health(runtime.mcpRuntime, true, runtime.mcpRuntimeDetail)
    }),
    capability("mcp-marketplace", "MCP 能力市场", "mcp_catalog", external(runtime.mcpMarketplaceRuntime), enabled("mcp"), "mcp", {
      provider: "npm registry",
      source: "local_installer",
      requirement: "npm 本地运行时已检查；状态查询未实时访问 npm registry。",
      health: health(runtime.mcpMarketplaceRuntime, false, runtime.mcpMarketplaceDetail)
    })
  ];
  return mergeCapabilityFacts(capabilities, options.capabilityFacts || listCapabilityFacts(options.groupPath));
}

export function probeCapabilityRuntime(options = {}) {
  const root = path.resolve(options.baseDir || MODULE_ROOT);
  const shellProbe = process.platform === "win32"
    ? probeCandidates([["powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]], ["cmd.exe", ["/d", "/c", "ver"]]])
    : probeCandidates([["sh", ["-lc", "printf ok"]], ["bash", ["-lc", "printf ok"]]]);
  const nodeProbe = probeCandidates([[process.execPath, ["--version"]], ["node", ["--version"]]]);
  const npmProbe = probeCandidates(process.platform === "win32" ? [["npm.cmd", ["--version"]], ["npm", ["--version"]]] : [["npm", ["--version"]]]);
  const pythonProbe = probeCandidates(process.platform === "win32"
    ? [["python", ["--version"]], ["py", ["-3", "--version"]]]
    : [["python3", ["--version"]], ["python", ["--version"]]]);
  const pipProbe = probeCandidates(process.platform === "win32"
    ? [["python", ["-m", "pip", "--version"]], ["py", ["-3", "-m", "pip", "--version"]]]
    : [["python3", ["-m", "pip", "--version"]], ["python", ["-m", "pip", "--version"]]]);
  const gitProbe = probeCandidates([["git", ["--version"]]]);
  const cargoProbe = probeCandidates([["cargo", ["--version"]]]);
  const goProbe = probeCandidates([["go", ["version"]]]);
  const gemProbe = probeCandidates([["gem", ["--version"]]]);
  const systemManagerProbe = probeCandidates(process.platform === "win32"
    ? [["winget", ["--version"]], ["choco", ["--version"]], ["scoop", ["--version"]]]
    : process.platform === "darwin" ? [["brew", ["--version"]]] : [["apt-get", ["--version"]], ["apt", ["--version"]], ["brew", ["--version"]]]);
  const sqliteProbe = probeCandidates(process.platform === "win32"
    ? [["python", ["-c", "import sqlite3; print(sqlite3.sqlite_version)"]], ["py", ["-3", "-c", "import sqlite3; print(sqlite3.sqlite_version)"]]]
    : [["python3", ["-c", "import sqlite3; print(sqlite3.sqlite_version)"]], ["python", ["-c", "import sqlite3; print(sqlite3.sqlite_version)"]]]);
  const curlProbe = probeCandidates([["curl", ["--version"]]]);
  const nodeSqliteProbe = nodeProbe.ok ? probeCandidates([[process.execPath, ["--no-warnings", "-e", "require('node:sqlite'); process.stdout.write('node:sqlite')"]]]) : { ok: false, command: "", version: "" };
  const electronPath = resolveElectronPath(root);
  const browserRunner = path.join(root, "src", "browserRunner.mjs");
  const backgroundSupervisor = path.join(root, "src", "backgroundSupervisor.mjs");
  const filesystem = writableDirectory(root);
  const packageCommands = [npmProbe, pipProbe, cargoProbe, goProbe, gemProbe].filter((item) => item.ok).map((item) => item.command);
  const codeCommands = [nodeProbe, pythonProbe].filter((item) => item.ok).map((item) => item.command);
  const webRuntime = ["webTools.js", "apiTools.js"].every((file) => fs.existsSync(path.join(root, "src", file)));
  const archiveRuntime = fs.existsSync(path.join(root, "src", "archiveTools.js"));
  const nodeSqlite = nodeSqliteProbe.ok;

  return {
    webRuntime,
    filesystem,
    archiveRuntime,
    shell: shellProbe.ok,
    shellDetail: probeDetail(shellProbe, "no supported shell found"),
    backgroundRuntime: nodeProbe.ok && fs.existsSync(backgroundSupervisor),
    codeRuntime: codeCommands.length > 0,
    codeRuntimeDetail: codeCommands.length ? `verified: ${codeCommands.join(", ")}` : "no supported code runtime found",
    packageRuntime: packageCommands.length > 0,
    packageRuntimeDetail: packageCommands.length ? `verified: ${packageCommands.join(", ")}` : "no supported language package manager found",
    provisionRuntime: shellProbe.ok && (systemManagerProbe.ok || process.platform === "win32" || curlProbe.ok),
    provisionRuntimeDetail: systemManagerProbe.ok ? `verified system package manager: ${systemManagerProbe.command}` : shellProbe.ok ? "custom install or direct download path available" : "no shell available for provisioning",
    testRuntime: shellProbe.ok && codeCommands.length > 0,
    testRuntimeDetail: shellProbe.ok && codeCommands.length ? `shell plus ${codeCommands.join(", ")}` : "test command runtime unavailable",
    git: gitProbe.ok,
    gitDetail: probeDetail(gitProbe, "git command unavailable"),
    browser: Boolean(electronPath) && fs.existsSync(browserRunner),
    browserDetail: electronPath && fs.existsSync(browserRunner) ? `verified Electron runtime: ${path.basename(electronPath)}` : "Electron browser runtime unavailable",
    database: nodeSqlite || sqliteProbe.ok,
    databaseDetail: nodeSqlite ? "node:sqlite available" : probeDetail(sqliteProbe, "SQLite runtime unavailable"),
    memoryRuntime: filesystem && fs.existsSync(path.join(root, "src", "publicMemory.js")),
    skillRuntime: filesystem && fs.existsSync(path.join(root, "src", "skillPacks.js")),
    mcpRuntime: nodeProbe.ok && fs.existsSync(path.join(root, "src", "mcpServer.js")),
    mcpRuntimeDetail: nodeProbe.ok ? "Node.js MCP stdio runtime present" : "Node.js MCP runtime unavailable",
    mcpMarketplaceRuntime: npmProbe.ok,
    mcpMarketplaceDetail: probeDetail(npmProbe, "npm runtime unavailable")
  };
}

export function hasSearchApiKey(options = process.env) {
  return Boolean(resolveSearchApiKey(options));
}

export function resolveSearchApiKey(options = process.env) {
  return resolveSearchApiKeyInfo(options).apiKey;
}

export function resolveSearchApiKeyInfo(options = process.env) {
  const normalized = normalizeSearchOptions(options);
  const localKey = String(normalized.appSettings?.capabilities?.webSearch?.apiKey || normalized.searchApiKey || "").trim();
  if (localKey) return { apiKey: localKey, source: "configured_local" };
  const envKey = String(normalized.env.AI_COUNCIL_BRAVE_SEARCH_API_KEY || normalized.env.BRAVE_SEARCH_API_KEY || "").trim();
  if (envKey) return { apiKey: envKey, source: "configured_env" };
  return { apiKey: "", source: "not_configured" };
}

function capability(id, label, kind, status, enabled, capabilityKey, extra = {}) {
  return { id, label, kind, status, enabled, capabilityKey, ...extra };
}

function archiveMetadata(runtime) {
  return {
    provider: "built-in",
    source: "local_server",
    requirement: "需要完全权限。",
    health: health(runtime.archiveRuntime, true, runtime.archiveRuntime ? "archive implementation present" : "archive implementation missing")
  };
}

function health(localVerified, externalVerified, detail) {
  return { localVerified: Boolean(localVerified), externalVerified: Boolean(externalVerified), checkedAt: new Date().toISOString(), detail: String(detail || "") };
}

function normalizedSettings(options) {
  return options?.appSettings || {};
}

function normalizeSearchOptions(options) {
  if (options && (options.AI_COUNCIL_BRAVE_SEARCH_API_KEY !== undefined || options.BRAVE_SEARCH_API_KEY !== undefined)) return { env: options };
  return { env: options?.env || process.env, appSettings: options?.appSettings, searchApiKey: options?.searchApiKey };
}

function probeCandidates(candidates) {
  for (const [command, args] of candidates) {
    const isCommandScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const file = isCommandScript ? "cmd.exe" : command;
    const invocationArgs = isCommandScript ? ["/d", "/c", command, ...args] : args;
    const result = spawnSync(file, invocationArgs, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    if (!result.error && result.status === 0) {
      return { ok: true, command, version: String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0].slice(0, 160) };
    }
  }
  return { ok: false, command: "", version: "" };
}

function probeDetail(probe, fallback) {
  return probe.ok ? `verified: ${probe.command}${probe.version ? ` (${probe.version})` : ""}` : fallback;
}

function writableDirectory(value) {
  try {
    fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveElectronPath(root) {
  const candidates = process.platform === "win32"
    ? [path.join(root, "node_modules", "electron", "dist", "electron.exe")]
    : process.platform === "darwin"
      ? [path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")]
      : [path.join(root, "node_modules", "electron", "dist", "electron")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}
