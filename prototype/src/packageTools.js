import fs from "node:fs";
import path from "node:path";
import { executeCommandTool } from "./commandTools.js";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function installPackageTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const manager = normalizeManager(request.manager || request.packageManager || request.ecosystem);
  const packageName = normalizePackageSpec(requiredPackage(request.packageName || request.package || request.name || request.query), groupRoot);
  const envRoot = prepareEnvironment(groupRoot, manager);
  const command = installCommand(manager, packageName);
  const result = await executeCommandTool({
    tool: "execute_command",
    command,
    cwd: envRoot,
    shell: process.platform === "win32" ? "cmd" : "sh",
    timeoutMs: request.timeoutMs || options.packageInstallTimeoutMs || DEFAULT_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes || options.maxPackageOutputBytes
  }, {
    ...options,
    groupPath: groupRoot,
    commandTimeoutMs: request.timeoutMs || options.packageInstallTimeoutMs || DEFAULT_TIMEOUT_MS
  });

  return {
    ok: result.ok,
    source: "local_package_manager",
    manager,
    packageName: redactPackageSpec(packageName),
    capabilityReferences: result.ok ? discoverCapabilityReferences(manager, packageName, envRoot, result.stdout) : [],
    environmentPath: path.relative(groupRoot, envRoot).replaceAll("\\", "/"),
    command: result.command,
    shell: result.shell,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code: result.code,
    error: result.error
  };
}

function discoverCapabilityReferences(manager, packageName, envRoot, stdout = "") {
  if (manager !== "pip") return packageReferences(packageName);
  const requested = new Set([
    ...packageReferences(packageName),
    ...successfulPipDistributions(stdout)
  ].map(normalizeDistributionName).filter(Boolean));
  const sitePackages = path.join(envRoot, ".venv", process.platform === "win32" ? "Lib" : "lib", "site-packages");
  if (!fs.existsSync(sitePackages)) return [];
  const references = [];
  for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/\.(?:dist|egg)-info$/i.test(entry.name)) continue;
    const metadataPath = path.join(sitePackages, entry.name, "METADATA");
    const metadata = readText(metadataPath);
    const name = metadata.match(/^Name:\s*(.+)$/mi)?.[1] || entry.name.replace(/\.(?:dist|egg)-info$/i, "");
    if (!requested.has(normalizeDistributionName(name))) continue;
    const topLevel = readText(path.join(sitePackages, entry.name, "top_level.txt"));
    references.push(...topLevel.split(/\r?\n/).map(normalizeImportReference).filter(Boolean));
    references.push(...pipRecordReferences(readText(path.join(sitePackages, entry.name, "RECORD"))));
  }
  return [...new Set([...packageReferences(packageName), ...references])];
}

function pipRecordReferences(record) {
  return String(record || "").split(/\r?\n/).flatMap((line) => {
    const relative = line.split(",", 1)[0].replaceAll("\\", "/");
    if (!relative || relative.startsWith("../") || /\.(?:dist|egg)-info\//i.test(relative)) return [];
    const topLevel = relative.split("/", 1)[0].replace(/\.py$/i, "");
    if (!topLevel || topLevel.startsWith("__") || topLevel === "bin") return [];
    return [normalizeImportReference(topLevel)];
  }).filter(Boolean);
}

function successfulPipDistributions(stdout) {
  const line = String(stdout || "").match(/Successfully installed\s+([^\r\n]+)/i)?.[1] || "";
  return line.split(/\s+/).map((item) => item.replace(/-[0-9][A-Za-z0-9.+!_-]*$/, ""));
}

function packageReferences(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\\/]/.test(raw)) return [];
  const withoutRange = raw.split(/[<>=!~\s\[]/, 1)[0];
  const secondAt = raw.startsWith("@") ? raw.indexOf("@", 1) : raw.indexOf("@");
  const withoutAtVersion = secondAt > 0 ? raw.slice(0, secondAt) : raw;
  return [...new Set([raw, withoutRange, withoutAtVersion].map(normalizeImportReference).filter(Boolean))];
}

function normalizeDistributionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[_.-]+/g, "-");
}

function normalizeImportReference(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_./-]/g, "");
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function prepareEnvironment(groupRoot, manager) {
  const base = path.join(groupRoot, "shared", "environments", manager);
  fs.mkdirSync(base, { recursive: true });
  if (manager === "npm") {
    const packageJson = path.join(base, "package.json");
    if (!fs.existsSync(packageJson)) {
      fs.writeFileSync(packageJson, JSON.stringify({
        private: true,
        name: "ai-council-managed-node-env",
        version: "0.0.0"
      }, null, 2), "utf8");
    }
  }
  if (manager === "cargo") {
    const cargoToml = path.join(base, "Cargo.toml");
    if (!fs.existsSync(cargoToml)) {
      fs.writeFileSync(cargoToml, [
        "[package]",
        "name = \"ai_council_managed_rust_env\"",
        "version = \"0.0.0\"",
        "edition = \"2021\"",
        "",
        "[dependencies]",
        ""
      ].join("\n"), "utf8");
    }
    fs.mkdirSync(path.join(base, "src"), { recursive: true });
    const mainRs = path.join(base, "src", "main.rs");
    if (!fs.existsSync(mainRs)) fs.writeFileSync(mainRs, "fn main() {}\n", "utf8");
  }
  if (manager === "go") {
    const goMod = path.join(base, "go.mod");
    if (!fs.existsSync(goMod)) {
      fs.writeFileSync(goMod, "module ai-council-managed-go-env\n\ngo 1.22\n", "utf8");
    }
  }
  if (manager === "gem") {
    fs.mkdirSync(path.join(base, "gems"), { recursive: true });
    fs.mkdirSync(path.join(base, "bin"), { recursive: true });
  }
  return base;
}

function installCommand(manager, packageName) {
  const quoted = quoteShell(packageName);
  if (manager === "npm") return `npm install ${quoted} --no-audit --no-fund`;
  if (manager === "pip") {
    const python = process.platform === "win32" ? "python" : "python3";
    const venv = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
    const create = `${python} -m venv .venv`;
    const install = `${quoteShell(venv)} -m pip install ${quoted}`;
    return process.platform === "win32"
      ? `(if not exist ".venv" (${create})) & ${install}`
      : `test -d .venv || ${create}; ${install}`;
  }
  if (manager === "cargo") return `cargo add ${quoted}`;
  if (manager === "go") return `go get ${quoted}`;
  if (manager === "gem") return `gem install ${quoted} --install-dir gems --bindir bin --no-document`;
  throw toolError("unsupported_package_manager", `Unsupported package manager: ${manager}`);
}

function normalizeManager(value) {
  const raw = String(value || "npm").trim().toLowerCase();
  if (["npm", "node", "nodejs", "javascript"].includes(raw)) return "npm";
  if (["pip", "python", "python3", "py"].includes(raw)) return "pip";
  if (["cargo", "rust", "rustlang"].includes(raw)) return "cargo";
  if (["go", "golang"].includes(raw)) return "go";
  if (["gem", "ruby", "rubygems"].includes(raw)) return "gem";
  throw toolError("unsupported_package_manager", `Unsupported package manager: ${raw || "(empty)"}.`);
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "install_package requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function requiredPackage(value) {
  const text = String(value || "").trim();
  if (!text) throw toolError("missing_package", "install_package requires a package name or spec.");
  return text;
}

function normalizePackageSpec(value, groupRoot) {
  const alias = normalizeWorkspacePathAlias(value);
  if (!alias.aliased) return value;
  const candidate = path.resolve(groupRoot, alias.path);
  if (!isInsidePath(groupRoot, candidate)) throw toolError("path_escape_denied", "Package path must stay inside the group workspace.");
  return candidate;
}

function quoteShell(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function redactPackageSpec(value) {
  return String(value || "")
    .replace(/(\/\/[^/:]+:)[^@/]+(@)/g, "$1[redacted]$2")
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]");
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
