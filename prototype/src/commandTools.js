import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";
import { buildCommandEnvironment, displayPath } from "./runtimeEnvironment.js";
import { backgroundWorkspaceChanges, captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./workspaceChanges.js";
import { startManagedBackgroundProcess } from "./processTools.js";

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export async function executeCommandTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const cwd = resolveCommandCwd(groupRoot, request.cwd || request.path || ".");
  const command = requiredText(request.command || request.query, "command");
  const shell = normalizeShell(request.shell);
  const timeoutMs = clampNumber(request.timeoutMs || options.commandTimeoutMs || options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = clampNumber(request.maxOutputBytes || options.maxCommandOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
  const invocation = buildShellInvocation(command, shell);
  const runtime = buildCommandEnvironment(groupRoot, { managedToolRoots: options.managedToolRoots });
  const workspaceSnapshotOptions = {
    maxEntries: options.maxWorkspaceSnapshotEntries,
    maxChanges: options.maxWorkspaceChanges
  };
  const startedAtMs = Date.now();

  if (request.background) {
    return startBackgroundCommand({
      invocation,
      cwd,
      groupRoot,
      command,
      shell,
      timeoutMs,
      maxOutputBytes,
      runtime,
      workspaceChanges: backgroundWorkspaceChanges(),
      startedAtMs
    });
  }

  const workspaceSnapshotBefore = captureWorkspaceSnapshot(groupRoot, workspaceSnapshotOptions);

  return runForegroundCommand({
    invocation,
    cwd,
    groupRoot,
    command,
    shell,
    timeoutMs,
    maxOutputBytes,
    signal: options.signal,
    runtime,
    workspaceSnapshotBefore,
    workspaceSnapshotOptions,
    startedAtMs
  });
}

function runForegroundCommand(options) {
  return new Promise((resolve) => {
    const child = spawn(options.invocation.file, options.invocation.args, {
      cwd: options.cwd,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(options.invocation.windowsVerbatimArguments),
      detached: process.platform !== "win32",
      env: options.runtime.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = outputBuffer(options.maxOutputBytes);
    const stderr = outputBuffer(options.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);
    const abort = () => {
      timedOut = true;
      killProcessTree(child);
    };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      const finishedAtMs = Date.now();
      let workspaceChanges;
      try {
        workspaceChanges = diffWorkspaceSnapshots(
          options.workspaceSnapshotBefore,
          captureWorkspaceSnapshot(options.groupRoot, options.workspaceSnapshotOptions),
          options.workspaceSnapshotOptions
        );
      } catch (error) {
        workspaceChanges = {
          source: "bounded_workspace_snapshot_diff",
          status: "unavailable",
          complete: false,
          created: [],
          modified: [],
          deleted: [],
          totalChanges: 0,
          keptChanges: 0,
          omittedChanges: 0,
          reason: error.message || "Workspace change scan failed."
        };
      }
      resolve(commandResult(options, { ...payload, finishedAtMs, workspaceChanges }));
    };

    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        code: "command_spawn_failed",
        error: error.message,
        exitCode: null,
        signal: "",
        timedOut,
        stdout,
        stderr
      });
    });
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: "command_timeout",
          error: `Command exceeded ${options.timeoutMs}ms and was stopped.`,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr
        });
        return;
      }
      if (exitCode !== 0) {
        finish({
          ok: false,
          code: "command_exit_nonzero",
          error: `Command exited with code ${exitCode}.`,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr
        });
        return;
      }
      finish({
        ok: true,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

async function startBackgroundCommand(options) {
  const managed = await startManagedBackgroundProcess({
    groupRoot: options.groupRoot,
    cwd: options.cwd,
    command: options.command,
    shell: options.shell,
    invocation: options.invocation,
    env: options.runtime.env,
    maxOutputBytes: options.maxOutputBytes
  });
  if (!managed.ok) {
    return commandResult(options, {
      ok: false,
      background: true,
      code: managed.code || "command_spawn_failed",
      error: managed.error || "Background command failed to start.",
      processId: managed.processId,
      process: managed.process,
      pid: managed.pid,
      supervisorPid: managed.supervisorPid,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: outputBuffer(0),
      stderr: outputBuffer(0)
    });
  }
  return commandResult(options, {
    ok: true,
    background: true,
    processId: managed.processId,
    process: managed.process,
    pid: managed.pid,
    supervisorPid: managed.supervisorPid,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: outputBuffer(0),
    stderr: outputBuffer(0)
  });
}

function commandResult(options, state) {
  const stdout = state.stdout?.text?.() || "";
  const stderr = state.stderr?.text?.() || "";
  const environmentHint = commandEnvironmentHint(options, state);
  return {
    ok: Boolean(state.ok),
    source: "local_command_tool",
    command: redactSecrets(options.command),
    shell: options.shell,
    cwd: relativeCwd(options.groupRoot, options.cwd),
    background: Boolean(state.background),
    processId: state.processId,
    process: state.process,
    pid: state.pid,
    supervisorPid: state.supervisorPid,
    exitCode: state.exitCode,
    signal: state.signal || "",
    timedOut: Boolean(state.timedOut),
    durationMs: Number(state.finishedAtMs || Date.now()) - options.startedAtMs,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    stdoutTruncated: Boolean(state.stdout?.truncated),
    stderrTruncated: Boolean(state.stderr?.truncated),
    environmentHint,
    environment: {
      pathAdditions: (options.runtime?.pathAdditions || []).map(displayPath),
      corrections: (options.runtime?.corrections || []).map(redactEmbeddedHomePath)
    },
    workspaceChanges: state.workspaceChanges || options.workspaceChanges,
    code: state.code,
    error: [state.error || "", environmentHint].filter(Boolean).join(" ")
  };
}

function redactEmbeddedHomePath(value) {
  const text = String(value || "");
  const home = String(process.env.USERPROFILE || process.env.HOME || "");
  if (!home) return text;
  const comparisonText = process.platform === "win32" ? text.toLowerCase() : text;
  const comparisonHome = process.platform === "win32" ? home.toLowerCase() : home;
  const index = comparisonText.indexOf(comparisonHome);
  if (index < 0) return text;
  return `${text.slice(0, index)}~${text.slice(index + home.length)}`;
}

function commandEnvironmentHint(options, state) {
  if (state.ok || process.platform !== "win32") return "";
  if (!["bash", "sh"].includes(options.shell)) return "";
  return "This command requested bash/sh on a Windows host; use shell=system, shell=cmd, or shell=powershell unless bash/sh has been verified available.";
}

function buildShellInvocation(command, shell) {
  if (shell === "system") return buildShellInvocation(command, defaultSystemShell());
  if (shell === "powershell") {
    return {
      file: process.platform === "win32" ? "powershell.exe" : "pwsh",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    };
  }
  if (shell === "cmd") return { file: "cmd.exe", args: ["/d", "/c", wrapCmdCommand(command)], windowsVerbatimArguments: true };
  if (shell === "bash") return { file: "bash", args: ["-lc", command] };
  if (shell === "sh") return { file: "sh", args: ["-lc", command] };
  return buildShellInvocation(command, defaultSystemShell());
}

function wrapCmdCommand(command) {
  const trimmed = String(command || "").trim();
  return trimmed.startsWith("\"") ? `"${trimmed}"` : command;
}

function normalizeShell(value) {
  const shell = String(value || "system").trim().toLowerCase();
  if (["system", "powershell", "cmd", "bash", "sh"].includes(shell)) return shell;
  return "system";
}

function defaultSystemShell() {
  return process.platform === "win32" ? "cmd" : "sh";
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "execute_command requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function resolveCommandCwd(groupRoot, input) {
  const literal = resolveExistingRelativeLiteral(groupRoot, input || ".");
  if (literal) return literal;
  const alias = normalizeWorkspacePathAlias(input || ".");
  const raw = alias.path || ".";
  const candidate = !alias.aliased && path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(groupRoot, raw);
  const real = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : candidate;
  if (!isInsidePath(groupRoot, real)) {
    throw toolError("path_escape_denied", "Command cwd must stay inside the group workspace.");
  }
  if (!fs.existsSync(real)) throw toolError("cwd_not_found", "Command cwd does not exist.");
  if (!fs.statSync(real).isDirectory()) throw toolError("cwd_not_directory", "Command cwd is not a directory.");
  return real;
}

function resolveExistingRelativeLiteral(groupRoot, input) {
  const raw = String(input || ".").trim();
  if (!raw || path.isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\")) return "";
  const candidate = path.resolve(groupRoot, raw);
  if (!fs.existsSync(candidate)) return "";
  const real = fs.realpathSync.native(candidate);
  if (!isInsidePath(groupRoot, real)) {
    throw toolError("path_escape_denied", "Command cwd must stay inside the group workspace.");
  }
  if (!fs.statSync(real).isDirectory()) throw toolError("cwd_not_directory", "Command cwd is not a directory.");
  return real;
}

function killProcessTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 1000).unref();
  } catch {}
}

function outputBuffer(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    add(chunk) {
      if (!maxBytes) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      const current = chunks.reduce((sum, item) => sum + item.length, 0);
      const remaining = maxBytes - current;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      if (buffer.length > remaining || bytes > maxBytes) truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

function relativeCwd(groupRoot, cwd) {
  const relative = path.relative(groupRoot, cwd).replaceAll("\\", "/");
  return relative || ".";
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

function redactSecrets(text) {
  return String(text || "")
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
