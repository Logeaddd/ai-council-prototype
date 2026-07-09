import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { userDataDir } from "./appSettings.js";
import { deleteMcpServerConfig, readMcpServerConfigs, upsertMcpServerConfig } from "./mcpConfig.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 12;

const CATALOG = [
  {
    id: "filesystem",
    name: "Filesystem",
    manager: "npm",
    packageName: "@modelcontextprotocol/server-filesystem",
    binName: "mcp-server-filesystem",
    defaultArgs: [],
    verifiedSource: "npm view @modelcontextprotocol/server-filesystem",
    verifiedAt: "2026-07-10"
  },
  {
    id: "memory",
    name: "Memory",
    manager: "npm",
    packageName: "@modelcontextprotocol/server-memory",
    binName: "mcp-server-memory",
    defaultArgs: [],
    verifiedSource: "npm view @modelcontextprotocol/server-memory",
    verifiedAt: "2026-07-10"
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    manager: "npm",
    packageName: "@modelcontextprotocol/server-sequential-thinking",
    binName: "mcp-server-sequential-thinking",
    defaultArgs: [],
    verifiedSource: "npm view @modelcontextprotocol/server-sequential-thinking",
    verifiedAt: "2026-07-10"
  }
];

export function listMcpInstallCatalog(baseDir) {
  const configs = readMcpServerConfigs(baseDir);
  return {
    catalog: CATALOG.map((item) => {
      const record = readInstallRecord(baseDir, item.id);
      const server = configs.find((config) => config.id === item.id);
      return {
        ...item,
        installed: Boolean(record?.installedAt && fs.existsSync(record.installDir || "")),
        installedVersion: record?.packageVersion || "",
        serverConfigured: Boolean(server),
        serverEnabled: server ? server.enabled !== false : false
      };
    })
  };
}

export async function searchMcpNpmPackages(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) {
    return {
      ok: false,
      source: "npm_registry_search",
      code: "missing_query",
      error: "Missing search query.",
      results: []
    };
  }
  const count = clampNumber(options.count, 8, 1, MAX_SEARCH_RESULTS);
  const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1000, DEFAULT_SEARCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", text);
    url.searchParams.set("size", String(count));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "AI-Council/0.2"
      }
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        source: "npm_registry_search",
        status: response.status,
        error: body.slice(0, 500),
        results: []
      };
    }
    const parsed = JSON.parse(body);
    return {
      ok: true,
      source: "npm_registry_search",
      query: text,
      results: (parsed.objects || [])
        .map((item) => normalizeNpmSearchResult(item))
        .filter(Boolean)
        .slice(0, count)
    };
  } catch (error) {
    return {
      ok: false,
      source: "npm_registry_search",
      code: error.name === "AbortError" ? "npm_search_timeout" : "npm_search_failed",
      error: error.message || "npm search failed.",
      results: []
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function installMcpNpmServer(baseDir, input = {}, options = {}) {
  const catalogItem = findCatalogItem(input.catalogId || input.id);
  const packageSpec = requiredText(input.packageSpec || input.packageName || catalogItem?.packageName, "packageSpec");
  const id = normalizeManagedId(input.serverId || input.id || catalogItem?.id || packageSpec);
  const name = String(input.name || catalogItem?.name || id).trim();
  const binName = String(input.binName || catalogItem?.binName || "").trim();
  const args = normalizeStringArray(input.args !== undefined ? input.args : catalogItem?.defaultArgs);
  const env = normalizeEnv(input.env);
  const timeoutMs = clampNumber(input.timeoutMs || options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, DEFAULT_TIMEOUT_MS);
  const installDir = resolveInstallDir(baseDir, id);
  const startedAtMs = Date.now();

  fs.mkdirSync(installDir, { recursive: true });
  ensurePackageJson(installDir, id);

  const npm = resolveNpmInvoker();
  let stdout = "";
  let stderr = "";
  let packageDir;
  let packageJson;
  let selectedBin;
  try {
    const result = await execFileAsync(npm.command, [...npm.args, "install", packageSpec, "--no-audit", "--no-fund"], {
      cwd: installDir,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true
    });
    stdout = result.stdout || "";
    stderr = result.stderr || "";
    const packageName = resolvePackageName(packageSpec, input.installedPackageName || catalogItem?.packageName);
    packageDir = resolveInstalledPackageDir(installDir, packageName);
    packageJson = readJson(path.join(packageDir, "package.json"));
    selectedBin = selectPackageBin(packageJson, binName);
  } catch (error) {
    return {
      ok: false,
      source: "mcp_npm_install",
      code: error.code || (error.killed || error.signal === "SIGTERM" ? "mcp_install_timeout" : "mcp_install_failed"),
      error: error.message || "npm install failed.",
      id,
      packageSpec: redactPackageSpec(packageSpec),
      installDir,
      durationMs: Date.now() - startedAtMs,
      stdout: redactSecrets(String(error.stdout || stdout || "")),
      stderr: redactSecrets(String(error.stderr || stderr || "")),
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }

  const binPath = path.resolve(packageDir, selectedBin.path);
  if (!fs.existsSync(binPath)) {
    return {
      ok: false,
      source: "mcp_npm_install",
      code: "mcp_bin_not_found",
      error: `Installed package bin was not found: ${selectedBin.path}`,
      id,
      packageSpec: redactPackageSpec(packageSpec),
      installDir,
      durationMs: Date.now() - startedAtMs,
      stdout: redactSecrets(stdout),
      stderr: redactSecrets(stderr)
    };
  }

  const server = upsertMcpServerConfig(baseDir, {
    id,
    name,
    enabled: input.enabled !== false,
    transport: "stdio",
    command: process.execPath,
    args: [binPath, ...args],
    cwd: installDir,
    env,
    source: "managed_npm",
    install: {
      manager: "npm",
      packageSpec: redactPackageSpec(packageSpec),
      packageName: packageJson.name,
      packageVersion: packageJson.version || "",
      binName: selectedBin.name,
      installDir,
      installedAt: new Date().toISOString()
    }
  });

  const record = {
    id,
    name,
    manager: "npm",
    packageSpec: redactPackageSpec(packageSpec),
    packageName: packageJson.name,
    packageVersion: packageJson.version || "",
    binName: selectedBin.name,
    binPath,
    args,
    installDir,
    installedAt: server.install?.installedAt || new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr)
  };
  writeInstallRecord(baseDir, id, record);

  return {
    ok: true,
    source: "mcp_npm_install",
    id,
    server,
    install: record
  };
}

export function uninstallManagedMcpServer(baseDir, input = {}) {
  const id = normalizeManagedId(input.serverId || input.id);
  const installDir = resolveInstallDir(baseDir, id);
  const existed = fs.existsSync(installDir);
  if (existed) removeInstallDirWithRetry(installDir);
  const configResult = input.deleteConfig === false
    ? { ok: true, deleted: false, id }
    : deleteMcpServerConfig(baseDir, id);
  return {
    ok: true,
    source: "mcp_npm_uninstall",
    id,
    removedInstallDir: existed,
    installDir,
    config: configResult
  };
}

export function mcpInstallRoot(baseDir) {
  return path.join(userDataDir(baseDir), "mcp-installs");
}

function findCatalogItem(id) {
  const target = String(id || "").trim();
  if (!target) return null;
  return CATALOG.find((item) => item.id === target) || null;
}

function normalizeNpmSearchResult(item) {
  const pkg = item?.package;
  if (!pkg?.name) return null;
  return {
    id: normalizeManagedId(pkg.name),
    name: String(pkg.name || "").trim(),
    packageName: String(pkg.name || "").trim(),
    version: String(pkg.version || "").trim(),
    description: String(pkg.description || "").slice(0, 240),
    keywords: normalizeStringArray(pkg.keywords).slice(0, 12),
    date: String(pkg.date || "").trim(),
    score: Number(item.score?.final || 0)
  };
}

function resolveInstallDir(baseDir, id) {
  const root = mcpInstallRoot(baseDir);
  const resolved = path.resolve(root, id);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw toolError("mcp_install_path_escape", "MCP install id must stay inside the managed install root.");
  }
  return resolved;
}

function ensurePackageJson(dir, id) {
  const filePath = path.join(dir, "package.json");
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, JSON.stringify({
    private: true,
    name: `ai-council-mcp-${id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
    version: "0.0.0"
  }, null, 2), "utf8");
}

function resolveNpmInvoker() {
  const cliPath = resolveNpmCliPath();
  if (cliPath) return { command: process.execPath, args: [cliPath] };
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: []
  };
}

function resolveNpmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return candidates.find((candidate) => candidate && candidate.endsWith(".js") && fs.existsSync(candidate)) || "";
}

function resolvePackageName(packageSpec, fallback) {
  const spec = String(packageSpec || "").trim();
  if (fallback) return String(fallback);
  if (fs.existsSync(spec)) {
    const pkg = readJson(path.join(fs.realpathSync.native(spec), "package.json"));
    return pkg.name;
  }
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1].split("@")[0]}`;
  }
  return spec.split("@")[0];
}

function resolveInstalledPackageDir(installDir, packageName) {
  const parts = String(packageName || "").split("/").filter(Boolean);
  if (!parts.length) throw toolError("mcp_package_name_unknown", "Could not resolve installed package name.");
  const packageDir = path.join(installDir, "node_modules", ...parts);
  if (!fs.existsSync(packageDir)) {
    throw toolError("mcp_package_not_found", `Installed package directory was not found: ${packageName}`);
  }
  return packageDir;
}

function selectPackageBin(packageJson, requestedBinName) {
  const bin = packageJson.bin;
  if (!bin) throw toolError("mcp_package_has_no_bin", "Installed package does not expose a bin entry.");
  if (typeof bin === "string") {
    return { name: packageJson.name, path: bin };
  }
  if (requestedBinName && bin[requestedBinName]) {
    return { name: requestedBinName, path: bin[requestedBinName] };
  }
  const first = Object.entries(bin)[0];
  if (!first) throw toolError("mcp_package_has_no_bin", "Installed package does not expose a bin entry.");
  return { name: first[0], path: first[1] };
}

function readInstallRecord(baseDir, id) {
  const filePath = path.join(resolveInstallDir(baseDir, id), "install-record.json");
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function writeInstallRecord(baseDir, id, record) {
  const filePath = path.join(resolveInstallDir(baseDir, id), "install-record.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
}

function removeInstallDirWithRetry(dir) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    sleepSync(125);
  }
  if (fs.existsSync(dir)) {
    throw lastError || toolError("mcp_install_remove_failed", "Managed MCP install directory could not be removed.");
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeManagedId(value) {
  const text = String(value || "").trim();
  if (!text) throw toolError("missing_mcp_install_id", "MCP install requires an id or serverId.");
  return text.replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, 120);
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 40);
}

function normalizeEnv(value = {}) {
  const output = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    output[name] = String(raw || "");
  }
  return output;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError(`missing_${name}`, `Missing ${name}.`);
  return text;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function redactPackageSpec(value) {
  return String(value || "")
    .replace(/(\/\/[^/:]+:)[^@/]+(@)/g, "$1[redacted]$2")
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]");
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]");
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
