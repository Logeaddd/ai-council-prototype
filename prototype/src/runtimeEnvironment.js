import fs from "node:fs";
import path from "node:path";

const PATH_COMMANDS = [
  "node", "npm", "npx", "python", "py", "java", "javac", "git",
  "gradle", "mvn", "cargo", "rustc", "go", "dotnet", "powershell"
];
const PROJECT_LAUNCHERS = new Set([
  "gradlew", "gradlew.bat", "mvnw", "mvnw.cmd", "mvnw.bat",
  "npmw", "npmw.cmd", "yarn", "yarn.cmd", "pnpm", "pnpm.cmd"
]);
const EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".ps1", ""]);
const SKIP_SCAN_DIRS = new Set([".git", ".gradle", ".next", "node_modules", "build", "dist", "out", "target"]);
const cache = new Map();
const hostCache = new Map();

export function discoverRuntimeEnvironment(groupPath, options = {}) {
  const root = safeRealDirectory(groupPath);
  const toolRootKey = (options.managedToolRoots || []).map((item) => String(item || "")).sort().join("|");
  const cacheKey = `${process.platform}:${root}:${toolRootKey}`;
  if (!options.refresh && cache.has(cacheKey)) return cache.get(cacheKey);

  const host = discoverHostRuntime();
  const environment = {
    platform: process.platform,
    workspace: root,
    pathCommands: host.pathCommands,
    projectLaunchers: root ? findProjectLaunchers(root) : [],
    managedTools: root ? findManagedTools([
      path.join(root, "tools"),
      path.join(root, "shared", "tools"),
      path.join(root, "shared", "environments"),
      path.join(path.dirname(root), "tools"),
      ...(options.managedToolRoots || [])
    ]) : [],
    configuredHomes: host.configuredHomes,
    invalidConfiguredHomes: host.invalidConfiguredHomes,
    javaHomes: host.javaHomes
  };
  cache.set(cacheKey, environment);
  return environment;
}

function discoverHostRuntime() {
  const key = [
    process.platform,
    process.env.PATH || process.env.Path || "",
    process.env.JAVA_HOME || "",
    process.env.PYTHONHOME || "",
    process.env.CARGO_HOME || "",
    process.env.GOPATH || "",
    process.env.DOTNET_ROOT || ""
  ].join("\n");
  if (hostCache.has(key)) return hostCache.get(key);
  const value = {
    pathCommands: PATH_COMMANDS.map((name) => ({ name, path: findOnPath(name) })).filter((item) => item.path),
    configuredHomes: configuredHomes(),
    invalidConfiguredHomes: invalidConfiguredHomes(),
    javaHomes: findJavaHomes()
  };
  hostCache.set(key, value);
  return value;
}

export function formatRuntimeEnvironment(environment = {}) {
  const platform = environment.platform || process.platform;
  const commands = formatEntries(environment.pathCommands, 14);
  const launchers = formatEntries(environment.projectLaunchers, 10);
  const managed = formatEntries(environment.managedTools, 14);
  const homes = formatEntries(environment.configuredHomes, 6);
  const invalidHomes = (environment.invalidConfiguredHomes || []).slice(0, 6).map((item) => item.name).join(", ");
  const javaHomes = formatEntries(environment.javaHomes, 6);
  return [
    `Detected tool runtime (real local discovery): platform=${platform}.`,
    commands ? `Commands on PATH: ${commands}.` : "Commands on PATH: none detected from the standard runtime list.",
    launchers ? `Project launchers: ${launchers}.` : "Project launchers: none detected.",
    managed ? `Managed/shared tools: ${managed}.` : "Managed/shared tools: none detected.",
    homes ? `Configured runtime homes: ${homes}.` : "Configured runtime homes: none detected.",
    invalidHomes ? `Ignored invalid runtime home variables: ${invalidHomes}.` : "",
    javaHomes ? `Detected Java homes: ${javaHomes}.` : "",
    "Reuse detected commands and tools before downloading or installing another copy. A launcher existing in the project does not prove it works; if it fails, use its real error and try another already-detected compatible tool before changing the toolchain."
  ].filter(Boolean).join(" ");
}

export function buildCommandEnvironment(groupPath, options = {}) {
  const root = safeRealDirectory(groupPath);
  const discovered = discoverRuntimeEnvironment(root, { ...options, refresh: true });
  const env = { ...process.env };
  const additions = [
    ...(discovered.managedTools || []).map((item) => path.dirname(item.path)),
    ...(discovered.configuredHomes || []).map((item) => path.join(item.path, "bin")),
    ...managedEnvironmentBins(root)
  ].filter(safeRealDirectory);
  const corrections = [];

  if (env.JAVA_HOME && !isJavaHome(env.JAVA_HOME)) {
    corrections.push("ignored invalid JAVA_HOME");
    delete env.JAVA_HOME;
  }
  if (!env.JAVA_HOME && discovered.javaHomes?.length) {
    env.JAVA_HOME = discovered.javaHomes[0].path;
    additions.unshift(path.join(env.JAVA_HOME, "bin"));
    corrections.push(`selected JAVA_HOME=${displayPath(env.JAVA_HOME)}`);
  }

  const currentPath = String(env.Path || env.PATH || "");
  const mergedPath = uniquePaths([...additions, ...currentPath.split(path.delimiter).filter(Boolean)]).join(path.delimiter);
  env.Path = mergedPath;
  env.PATH = mergedPath;
  return {
    env,
    discovered,
    pathAdditions: uniquePaths(additions),
    corrections
  };
}

function findOnPath(name) {
  const directories = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension.toLowerCase()}`);
      const alternate = path.join(directory, `${name}${extension.toUpperCase()}`);
      if (isExecutableFile(candidate)) return candidate;
      if (alternate !== candidate && isExecutableFile(alternate)) return alternate;
    }
  }
  return "";
}

function findProjectLaunchers(root) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && found.length < 20) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 4 && !SKIP_SCAN_DIRS.has(lower)) stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !PROJECT_LAUNCHERS.has(lower)) continue;
      found.push({ name: entry.name, path: path.relative(root, full).replaceAll("\\", "/") });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function findManagedTools(toolRoots) {
  const found = [];
  const stack = [...new Set((toolRoots || []).map(safeRealDirectory).filter(Boolean))]
    .map((dir) => ({ dir, depth: 0 }));
  while (stack.length && found.length < 30) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3) stack.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !EXECUTABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || !isExecutableFile(full)) continue;
      if (!/[\\/](?:bin|\.bin)[\\/]/i.test(full)) continue;
      found.push({ name: path.basename(entry.name, path.extname(entry.name)), path: full });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function configuredHomes() {
  return ["JAVA_HOME", "PYTHONHOME", "CARGO_HOME", "GOPATH", "DOTNET_ROOT"]
    .map((name) => ({ name, path: String(process.env[name] || "").trim() }))
    .filter((item) => item.path && safeRealDirectory(item.path));
}

function managedEnvironmentBins(root) {
  if (!root) return [];
  const environmentRoot = path.join(root, "shared", "environments");
  const candidates = [
    path.join(environmentRoot, "npm", "node_modules", ".bin"),
    path.join(environmentRoot, "pip", ".venv", process.platform === "win32" ? "Scripts" : "bin"),
    path.join(environmentRoot, "gem", "bin")
  ];
  return candidates.map(safeRealDirectory).filter(Boolean);
}

function invalidConfiguredHomes() {
  return ["JAVA_HOME", "PYTHONHOME", "CARGO_HOME", "GOPATH", "DOTNET_ROOT"]
    .map((name) => ({ name, path: String(process.env[name] || "").trim() }))
    .filter((item) => item.path && !safeRealDirectory(item.path));
}

function findJavaHomes() {
  const candidates = [];
  const configured = String(process.env.JAVA_HOME || "").trim();
  if (isJavaHome(configured)) candidates.push(configured);
  const roots = process.platform === "win32"
    ? [
        "C:/Program Files/Java",
        "C:/Program Files/Eclipse Adoptium",
        "C:/Program Files/Microsoft",
        "C:/Program Files/Amazon Corretto"
      ]
    : ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"];
  for (const root of roots) {
    const realRoot = safeRealDirectory(root);
    if (!realRoot) continue;
    for (const candidate of childDirectories(realRoot, 2)) {
      if (isJavaHome(candidate)) candidates.push(candidate);
      const contentsHome = path.join(candidate, "Contents", "Home");
      if (isJavaHome(contentsHome)) candidates.push(contentsHome);
    }
  }
  return uniquePaths(candidates)
    .map((javaHome) => ({ name: `java${javaVersionHint(javaHome) || ""}`, path: javaHome }))
    .sort((a, b) => javaVersionHint(b.path) - javaVersionHint(a.path) || a.path.localeCompare(b.path));
}

function childDirectories(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current.dir, entry.name);
      out.push(full);
      if (current.depth + 1 < maxDepth) stack.push({ dir: full, depth: current.depth + 1 });
    }
  }
  return out;
}

function isJavaHome(value) {
  const root = safeRealDirectory(value);
  if (!root) return false;
  const java = path.join(root, "bin", process.platform === "win32" ? "java.exe" : "java");
  const javac = path.join(root, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  return isExecutableFile(java) && isExecutableFile(javac);
}

function javaVersionHint(value) {
  const matches = String(value || "").match(/(?:jdk|java|corretto|openjdk)[-_ ]?(\d+)(?:\.\d+)*/ig) || [];
  const versions = matches.map((item) => Number(item.match(/\d+/)?.[0] || 0));
  return Math.max(0, ...versions);
}

function uniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = process.platform === "win32" ? text.toLowerCase() : text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    return process.platform === "win32" || Boolean(stat.mode & 0o111);
  } catch {
    return false;
  }
}

function formatEntries(entries, limit) {
  return (entries || []).slice(0, limit).map((item) => `${item.name}=${displayPath(item.path)}`).join(", ");
}

export function displayPath(value) {
  const text = String(value || "");
  const home = String(osHomeDirectory() || "");
  if (!home) return text;
  const lowerText = process.platform === "win32" ? text.toLowerCase() : text;
  const lowerHome = process.platform === "win32" ? home.toLowerCase() : home;
  if (lowerText === lowerHome) return "~";
  if (lowerText.startsWith(`${lowerHome}${path.sep}`)) return `~${text.slice(home.length)}`;
  return text;
}

function osHomeDirectory() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function safeRealDirectory(value) {
  try {
    if (!value || !fs.existsSync(value) || !fs.statSync(value).isDirectory()) return "";
    return fs.realpathSync.native(value);
  } catch {
    return "";
  }
}
