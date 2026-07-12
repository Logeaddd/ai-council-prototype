import fs from "node:fs";
import path from "node:path";
import { executeCommandTool } from "./commandTools.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const KNOWN_TOOLS = {
  "7zip": { command: "7z", winget: "7zip.7zip", choco: "7zip", brew: "sevenzip", apt: "p7zip-full" },
  git: { command: "git", winget: "Git.Git", choco: "git", brew: "git", apt: "git" },
  gradle: { command: "gradle", choco: "gradle", scoop: "gradle", brew: "gradle", apt: "gradle" },
  jdk17: { command: "java", winget: "EclipseAdoptium.Temurin.17.JDK", choco: "temurin17", brew: "openjdk@17", apt: "openjdk-17-jdk" },
  libreoffice: { command: "soffice", winget: "TheDocumentFoundation.LibreOffice", choco: "libreoffice-fresh", brew: "--cask libreoffice", apt: "libreoffice" },
  node: { command: "node", winget: "OpenJS.NodeJS.LTS", choco: "nodejs-lts", brew: "node", apt: "nodejs" },
  pandoc: { command: "pandoc", winget: "JohnMacFarlane.Pandoc", choco: "pandoc", brew: "pandoc", apt: "pandoc" },
  python: { command: "python", winget: "Python.Python.3.12", choco: "python312", brew: "python", apt: "python3" }
};

export async function provisionTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const name = requiredText(request.name || request.toolName || request.query, "tool name");
  const key = normalizeKey(name);
  const known = KNOWN_TOOLS[key] || {};
  const command = requiredText(request.commandName || request.executable || known.command || name, "command name");
  const managedRoot = path.join(groupRoot, "shared", "tools");
  const installRoot = path.join(managedRoot, safeSegment(key || command));
  fs.mkdirSync(installRoot, { recursive: true });
  const commandOptions = {
    ...options,
    groupPath: groupRoot,
    commandTimeoutMs: request.timeoutMs || options.toolProvisionTimeoutMs || DEFAULT_TIMEOUT_MS,
    managedToolRoots: [...new Set([managedRoot, ...(options.managedToolRoots || [])])]
  };

  const before = await probeCommand(command, request.verifyCommand, commandOptions);
  if (before.ok) return provisionResult({ name, command, status: "already_available", probe: before });

  const strategy = chooseStrategy(request, known, installRoot);
  if (!strategy.command) {
    throw toolError("tool_source_required", `No automatic source is known for ${name}. Provide manager/packageId, installCommand, or downloadUrl.`);
  }
  const installed = await executeCommandTool({
    tool: "execute_command",
    command: strategy.command,
    cwd: ".",
    shell: strategy.shell,
    timeoutMs: request.timeoutMs || options.toolProvisionTimeoutMs || DEFAULT_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes || options.maxToolProvisionOutputBytes
  }, commandOptions);
  if (!installed.ok) {
    return provisionResult({ name, command, status: "install_failed", strategy, install: installed, ok: false });
  }

  const after = await probeCommand(command, request.verifyCommand, commandOptions, request.executablePath, installRoot);
  return provisionResult({
    name,
    command,
    status: after.ok ? "installed" : "verification_failed",
    strategy,
    install: installed,
    probe: after,
    ok: after.ok
  });
}

function chooseStrategy(request, known, installRoot) {
  if (request.installCommand) {
    return { type: "custom_command", command: String(request.installCommand), shell: request.shell };
  }
  if (request.downloadUrl) return downloadStrategy(request, installRoot);
  const manager = normalizeManager(request.manager || preferredManager(known));
  const packageId = String(request.packageId || request.package || known[manager] || "").trim();
  if (!manager || !packageId) return { type: "unavailable", command: "" };
  return { type: "system_package_manager", manager, packageId, command: managerCommand(manager, packageId), shell: platformShell() };
}

function downloadStrategy(request, installRoot) {
  const url = requiredText(request.downloadUrl, "downloadUrl");
  const archiveName = safeSegment(request.fileName || path.basename(new URL(url).pathname) || "tool-download");
  const relativeRoot = relativeForShell(installRoot);
  const relativeArchive = relativeForShell(path.join(installRoot, archiveName));
  if (process.platform === "win32") {
    const download = `Invoke-WebRequest -UseBasicParsing -Uri '${psQuote(url)}' -OutFile '${psQuote(relativeArchive)}'`;
    const unpack = /\.zip$/i.test(archiveName)
      ? `; Expand-Archive -LiteralPath '${psQuote(relativeArchive)}' -DestinationPath '${psQuote(relativeRoot)}' -Force`
      : "";
    return { type: "download", url, command: `${download}${unpack}`, shell: "powershell" };
  }
  const unpack = /\.(?:tar\.gz|tgz)$/i.test(archiveName)
    ? ` && tar -xzf '${shQuote(relativeArchive)}' -C '${shQuote(relativeRoot)}'`
    : /\.zip$/i.test(archiveName)
      ? ` && unzip -o '${shQuote(relativeArchive)}' -d '${shQuote(relativeRoot)}'`
      : "";
  return { type: "download", url, command: `curl -fL '${shQuote(url)}' -o '${shQuote(relativeArchive)}'${unpack}`, shell: "sh" };
}

async function probeCommand(command, verifyCommand, options, executablePath, installRoot) {
  const explicit = executablePath ? resolveManagedExecutable(installRoot, executablePath) : "";
  const target = explicit || command;
  const check = verifyCommand || (process.platform === "win32"
    ? `& ${quoteCommand(target)} --version`
    : `${quoteCommand(target)} --version`);
  const result = await executeCommandTool({
    tool: "execute_command",
    command: check,
    cwd: ".",
    shell: platformShell(),
    timeoutMs: Math.min(60_000, options.commandTimeoutMs || DEFAULT_TIMEOUT_MS),
    maxOutputBytes: 64 * 1024
  }, options);
  return {
    ok: result.ok,
    command: check,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    error: result.error
  };
}

function preferredManager(known) {
  const order = process.platform === "win32" ? ["winget", "choco", "scoop"] : process.platform === "darwin" ? ["brew"] : ["apt", "brew"];
  return order.find((manager) => known[manager]) || "";
}

function normalizeManager(value) {
  const manager = String(value || "").trim().toLowerCase();
  return ["winget", "choco", "scoop", "brew", "apt"].includes(manager) ? manager : "";
}

function managerCommand(manager, packageId) {
  const id = quoteCommand(packageId);
  if (manager === "winget") return `winget install --id ${id} --exact --silent --accept-package-agreements --accept-source-agreements`;
  if (manager === "choco") return `choco install ${id} -y --no-progress`;
  if (manager === "scoop") return `scoop install ${id}`;
  if (manager === "brew") return `brew install ${packageId}`;
  if (manager === "apt") return `sudo apt-get update && sudo apt-get install -y ${id}`;
  return "";
}

function provisionResult({ name, command, status, strategy, install, probe, ok = true }) {
  return {
    ok,
    source: "managed_tool_provisioner",
    name,
    command,
    status,
    strategy: strategy ? { type: strategy.type, manager: strategy.manager, packageId: strategy.packageId, url: strategy.url } : undefined,
    install: install ? {
      ok: install.ok,
      exitCode: install.exitCode,
      durationMs: install.durationMs,
      stdout: install.stdout,
      stderr: install.stderr,
      code: install.code,
      error: install.error,
      workspaceChanges: install.workspaceChanges
    } : undefined,
    verification: probe
  };
}

function resolveManagedExecutable(root, value) {
  const candidate = path.resolve(root, String(value || ""));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw toolError("path_escape_denied", "executablePath must stay inside the managed tool directory.");
  return candidate;
}

function resolveGroupRoot(groupPath) {
  if (!groupPath || !fs.existsSync(groupPath)) throw toolError("missing_workspace", "provision_tool requires a group workspace.");
  return fs.realpathSync.native(groupPath);
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function safeSegment(value) {
  return String(value || "tool").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "tool";
}

function relativeForShell(value) {
  return String(value).replaceAll("\\", "/");
}

function platformShell() {
  return process.platform === "win32" ? "powershell" : "sh";
}

function quoteCommand(value) {
  const text = String(value || "");
  return process.platform === "win32" ? `"${text.replace(/"/g, '\\"')}"` : `'${shQuote(text)}'`;
}

function psQuote(value) {
  return String(value || "").replace(/'/g, "''");
}

function shQuote(value) {
  return String(value || "").replace(/'/g, "'\\''");
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError("missing_value", `provision_tool requires ${name}.`);
  return text;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
