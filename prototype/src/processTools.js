import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeId, nowIso } from "./types.js";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "./workspaceChanges.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("./backgroundSupervisor.mjs", import.meta.url));
const PTY_SUPERVISOR_PATH = fileURLToPath(new URL("./ptySupervisor.mjs", import.meta.url));
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10000;
const DEFAULT_STOP_TIMEOUT_MS = 10000;
const HEARTBEAT_STALE_MS = 15000;
const PROCESS_ID_PATTERN = /^proc_[a-z0-9_]+$/i;
const TERMINAL_STATUSES = new Set(["exited", "failed", "stopped", "unknown"]);
const MAX_TERMINAL_INPUT_BYTES = 16 * 1024;
const DEFAULT_TERMINAL_COLUMNS = 100;
const DEFAULT_TERMINAL_ROWS = 30;

export async function startManagedBackgroundProcess(options = {}) {
  return startManagedProcess({ ...options, interactive: false });
}

export async function startManagedInteractiveProcess(options = {}) {
  return startManagedProcess({ ...options, interactive: true });
}

async function startManagedProcess(options = {}) {
  const processId = makeId("proc");
  const paths = processPaths(options.groupRoot, processId);
  const createdAt = nowIso();
  const interactive = Boolean(options.interactive);
  const terminal = interactive ? {
    columns: clampNumber(options.columns, DEFAULT_TERMINAL_COLUMNS, 20, 300),
    rows: clampNumber(options.rows, DEFAULT_TERMINAL_ROWS, 5, 200),
    lastControlId: "",
    lastControlAt: ""
  } : undefined;
  fs.mkdirSync(paths.processDir, { recursive: true });
  const workspaceTracking = createWorkspaceTracking(options, paths);
  writeJson(paths.statePath, {
    processId,
    source: interactive ? "managed_interactive_pty" : "managed_background_process",
    interactive,
    terminal,
    workspaceTracking,
    status: "starting",
    command: redactSecrets(options.command),
    shell: options.shell,
    cwd: relativeCwd(options.groupRoot, options.cwd),
    pid: null,
    supervisorPid: null,
    createdAt,
    startedAt: "",
    heartbeatAt: createdAt,
    finishedAt: "",
    exitCode: null,
    signal: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  });

  return new Promise((resolve) => {
    let settled = false;
    const supervisor = spawn(process.execPath, [interactive ? PTY_SUPERVISOR_PATH : SUPERVISOR_PATH], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"]
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      supervisor.removeAllListeners();
      supervisor.unref();
      resolve({ processId, ...result });
    };
    const fail = (code, error) => {
      const state = {
        ...(readJson(paths.statePath) || {}),
        status: "failed",
        code,
        error,
        finishedAt: nowIso()
      };
      writeJson(paths.statePath, state);
      finish({ ok: false, code, error, pid: state.pid, supervisorPid: supervisor.pid, process: publicProcessState(state) });
    };
    const timeout = setTimeout(() => {
      try {
        supervisor.kill();
      } catch {}
      fail("background_supervisor_timeout", "Background process supervisor did not confirm startup in time.");
    }, DEFAULT_START_TIMEOUT_MS);

    supervisor.once("error", (error) => fail("background_supervisor_spawn_failed", error.message));
    supervisor.once("exit", (code, signal) => {
      if (settled) return;
      fail("background_supervisor_exited", `Background process supervisor exited before startup confirmation (code=${code}, signal=${signal || "none"}).`);
    });
    const poll = setInterval(() => {
      const state = readJson(paths.statePath) || {};
      if (state.status === "failed") {
        clearInterval(poll);
        fail(state.code || "background_command_spawn_failed", state.error || "Background command failed to start.");
        return;
      }
      if (state.status !== "running" || !state.pid || !state.supervisorPid) return;
      clearInterval(poll);
      finish({
        ok: true,
        pid: state.pid,
        supervisorPid: state.supervisorPid,
        status: state.status || "running",
        process: publicProcessState(state)
      });
    }, 25);
    supervisor.stdin.end(JSON.stringify({
      processId,
      processDir: paths.processDir,
      statePath: paths.statePath,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      stopPath: paths.stopPath,
      invocation: options.invocation,
      cwd: options.cwd,
      env: options.env,
      interactive,
      terminal,
      initialInput: String(options.initialInput || ""),
      terminalControlPendingDir: paths.terminalControlPendingDir,
      terminalControlAckDir: paths.terminalControlAckDir,
      maxOutputBytes: clampNumber(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES)
    }));
  });
}

export async function processControlTool(request = {}, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const action = String(request.action || "list").trim().toLowerCase();
  if (action === "list") return listProcesses(groupRoot, request.count);
  const processId = requireProcessId(request.processId);
  let result;
  if (action === "status") result = processStatus(groupRoot, processId);
  else if (action === "output") result = processOutput(groupRoot, processId, request);
  else if (action === "input") result = await queueTerminalControl(groupRoot, processId, request, "input");
  else if (action === "resize") result = await queueTerminalControl(groupRoot, processId, request, "resize");
  else if (action === "stop") result = await stopProcess(groupRoot, processId, request);
  else throw toolError("unsupported_process_action", `Unsupported process action: ${action || "(empty)"}.`);
  return attachWorkspaceObservation(groupRoot, processId, result);
}

function listProcesses(groupRoot, countValue) {
  const root = processRoot(groupRoot);
  const limit = clampNumber(countValue, 20, 1, 100);
  if (!fs.existsSync(root)) return { ok: true, source: "managed_background_process", action: "list", processes: [], count: 0 };
  const processes = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROCESS_ID_PATTERN.test(entry.name))
    .map((entry) => readProcessState(groupRoot, entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit)
    .map(publicProcessState);
  return { ok: true, source: "managed_background_process", action: "list", processes, count: processes.length };
}

function processStatus(groupRoot, processId) {
  const state = requireProcessState(groupRoot, processId);
  return {
    ok: true,
    source: "managed_background_process",
    action: "status",
    process: publicProcessState(state)
  };
}

function processOutput(groupRoot, processId, request) {
  const state = requireProcessState(groupRoot, processId);
  const stream = normalizeStream(request.stream, state);
  const paths = processPaths(groupRoot, processId);
  const filePath = stream === "stderr" ? paths.stderrPath : paths.stdoutPath;
  const totalBytes = safeFileSize(filePath);
  const offset = clampNumber(request.offset, 0, 0, totalBytes);
  const maxBytes = clampNumber(request.maxBytes || request.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1024, 512 * 1024);
  const length = Math.min(maxBytes, Math.max(0, totalBytes - offset));
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  if (length > 0) {
    const fd = fs.openSync(filePath, "r");
    try {
      bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
  }
  const nextOffset = offset + bytesRead;
  return {
    ok: true,
    source: "managed_background_process",
    action: "output",
    processId,
    status: state.status,
    stream,
    offset,
    nextOffset,
    totalBytes,
    bytesRead,
    truncated: nextOffset < totalBytes,
    logTruncated: Boolean(stream === "stderr" ? state.stderrTruncated : state.stdoutTruncated),
    eof: TERMINAL_STATUSES.has(state.status) && nextOffset >= totalBytes,
    output: redactSecrets(buffer.subarray(0, bytesRead).toString("utf8"))
  };
}

async function queueTerminalControl(groupRoot, processId, request, action) {
  const state = requireProcessState(groupRoot, processId);
  if (!state.interactive) {
    throw toolError("process_not_interactive", "Terminal input and resize require an interactive PTY process.");
  }
  if (TERMINAL_STATUSES.has(state.status)) {
    return { ok: false, source: "managed_interactive_pty", action, code: "terminal_not_running", error: "The interactive terminal is no longer running.", process: publicProcessState(state) };
  }
  const controlId = makeId("ptyctl");
  let control;
  if (action === "input") {
    const input = String(request.inputText || request.input || "");
    const bytes = Buffer.byteLength(input, "utf8");
    if (!bytes) throw toolError("terminal_input_required", "Interactive terminal input cannot be empty.");
    if (bytes > MAX_TERMINAL_INPUT_BYTES) throw toolError("terminal_input_too_large", `Interactive terminal input is limited to ${MAX_TERMINAL_INPUT_BYTES} bytes per request.`);
    control = { id: controlId, type: "input", value: input, createdAt: nowIso() };
  } else {
    control = {
      id: controlId,
      type: "resize",
      columns: clampNumber(request.columns ?? request.cols, state.terminal?.columns || DEFAULT_TERMINAL_COLUMNS, 20, 300),
      rows: clampNumber(request.rows, state.terminal?.rows || DEFAULT_TERMINAL_ROWS, 5, 200),
      createdAt: nowIso()
    };
  }
  const paths = processPaths(groupRoot, processId);
  fs.mkdirSync(paths.terminalControlPendingDir, { recursive: true });
  writeJson(path.join(paths.terminalControlPendingDir, `${controlId}.json`), control);
  const deadline = Date.now() + 2000;
  let acknowledged = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(paths.terminalControlAckDir, `${controlId}.json`))) {
      acknowledged = true;
      break;
    }
    await delay(25);
  }
  const latest = requireProcessState(groupRoot, processId);
  return {
    ok: true,
    source: "managed_interactive_pty",
    action,
    processId,
    controlId,
    acknowledged,
    pending: !acknowledged,
    inputBytes: action === "input" ? Buffer.byteLength(String(request.inputText || request.input || ""), "utf8") : 0,
    terminal: latest.terminal || undefined,
    process: publicProcessState(latest)
  };
}

async function stopProcess(groupRoot, processId, request) {
  let state = requireProcessState(groupRoot, processId);
  if (TERMINAL_STATUSES.has(state.status)) {
    return { ok: true, source: "managed_background_process", action: "stop", alreadyTerminal: true, process: publicProcessState(state) };
  }
  if (!isPidAlive(state.supervisorPid)) {
    state = markUnknown(groupRoot, processId, state, "The process supervisor is not running, so safe process-tree ownership cannot be confirmed.");
    return { ok: false, source: "managed_background_process", action: "stop", code: "process_supervisor_unavailable", error: state.error, process: publicProcessState(state) };
  }
  const paths = processPaths(groupRoot, processId);
  writeJson(paths.stopPath, { requestedAt: nowIso(), reason: String(request.reason || "Stop requested by agent.").slice(0, 500) });
  const timeoutMs = clampNumber(request.timeoutMs, DEFAULT_STOP_TIMEOUT_MS, 1000, 60000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(100);
    state = requireProcessState(groupRoot, processId);
    if (TERMINAL_STATUSES.has(state.status)) {
      return { ok: state.status === "stopped", source: "managed_background_process", action: "stop", process: publicProcessState(state) };
    }
  }
  state = requireProcessState(groupRoot, processId);
  return {
    ok: false,
    source: "managed_background_process",
    action: "stop",
    code: "process_stop_timeout",
    error: `Process did not reach a terminal state within ${timeoutMs}ms.`,
    process: publicProcessState(state)
  };
}

function requireProcessState(groupRoot, processId) {
  const state = readProcessState(groupRoot, processId);
  if (!state) throw toolError("process_not_found", `Unknown background process: ${processId}.`);
  return state;
}

function readProcessState(groupRoot, processId) {
  const paths = processPaths(groupRoot, processId);
  const state = readJson(paths.statePath);
  if (!state) return undefined;
  if (["starting", "running", "stopping"].includes(state.status)) {
    const heartbeatAge = Date.now() - Date.parse(state.heartbeatAt || state.createdAt || 0);
    if (!isPidAlive(state.supervisorPid) || heartbeatAge > HEARTBEAT_STALE_MS) {
      return markUnknown(groupRoot, processId, state, "The process supervisor heartbeat is unavailable; current process state cannot be confirmed.");
    }
  }
  return state;
}

function markUnknown(groupRoot, processId, state, error) {
  const next = {
    ...state,
    status: "unknown",
    code: "process_state_unknown",
    error,
    detectedAt: nowIso()
  };
  writeJson(processPaths(groupRoot, processId).statePath, next);
  return next;
}

function publicProcessState(state = {}) {
  return {
    processId: state.processId,
    source: state.source || "managed_background_process",
    interactive: Boolean(state.interactive),
    terminal: state.interactive ? {
      columns: Number(state.terminal?.columns || 0),
      rows: Number(state.terminal?.rows || 0),
      lastControlId: state.terminal?.lastControlId || "",
      lastControlAt: state.terminal?.lastControlAt || ""
    } : undefined,
    status: state.status || "unknown",
    command: redactSecrets(state.command),
    shell: state.shell || "system",
    cwd: state.cwd || ".",
    pid: state.pid || null,
    supervisorPid: state.supervisorPid || null,
    createdAt: state.createdAt || "",
    startedAt: state.startedAt || "",
    heartbeatAt: state.heartbeatAt || "",
    stopRequestedAt: state.stopRequestedAt || "",
    finishedAt: state.finishedAt || "",
    exitCode: state.exitCode ?? null,
    signal: state.signal || "",
    stdoutBytes: Number(state.stdoutBytes || 0),
    stderrBytes: Number(state.stderrBytes || 0),
    stdoutTruncated: Boolean(state.stdoutTruncated),
    stderrTruncated: Boolean(state.stderrTruncated),
    code: state.code || "",
    error: redactSecrets(state.error)
  };
}

function processPaths(groupRoot, processId) {
  const safeId = requireProcessId(processId);
  const processDir = path.join(processRoot(groupRoot), safeId);
  return {
    processDir,
    statePath: path.join(processDir, "state.json"),
    stdoutPath: path.join(processDir, "stdout.log"),
    stderrPath: path.join(processDir, "stderr.log"),
    workspaceSnapshotPath: path.join(processDir, "workspace-snapshot.json"),
    stopPath: path.join(processDir, "stop-request.json"),
    terminalControlPendingDir: path.join(processDir, "terminal-controls", "pending"),
    terminalControlAckDir: path.join(processDir, "terminal-controls", "acknowledged")
  };
}

function createWorkspaceTracking(options, paths) {
  if (!options.workspaceRoot || !fs.existsSync(options.workspaceRoot)) return undefined;
  try {
    const root = fs.realpathSync.native(options.workspaceRoot);
    if (!fs.statSync(root).isDirectory()) return undefined;
    const tracking = {
      root,
      label: String(options.workspaceLabel || ""),
      maxEntries: positiveInteger(options.workspaceSnapshotOptions?.maxEntries),
      maxChanges: positiveInteger(options.workspaceSnapshotOptions?.maxChanges),
      snapshotPath: paths.workspaceSnapshotPath
    };
    writeWorkspaceSnapshot(tracking.snapshotPath, captureWorkspaceSnapshot(root, tracking));
    return tracking;
  } catch {
    return undefined;
  }
}

function attachWorkspaceObservation(groupRoot, processId, result) {
  const state = readProcessState(groupRoot, processId);
  if (!state?.workspaceTracking) return result;
  return { ...result, workspaceChanges: observeWorkspaceChanges(state.workspaceTracking) };
}

function observeWorkspaceChanges(tracking) {
  const unavailable = (reason) => ({
    source: "bounded_workspace_snapshot_diff",
    status: "unavailable",
    complete: false,
    created: [],
    modified: [],
    deleted: [],
    observedArtifacts: [],
    observedArtifactsComplete: false,
    observedArtifactsOmitted: 0,
    totalChanges: 0,
    keptChanges: 0,
    omittedChanges: 0,
    reason
  });
  try {
    const before = readWorkspaceSnapshot(tracking.snapshotPath);
    const after = captureWorkspaceSnapshot(tracking.root, tracking);
    writeWorkspaceSnapshot(tracking.snapshotPath, after);
    if (!before) return unavailable("The initial workspace snapshot was unavailable, so this process observation cannot claim file changes.");
    return labelWorkspaceChanges(diffWorkspaceSnapshots(before, after, tracking), tracking.label);
  } catch (error) {
    return unavailable(error.message || "Workspace change observation failed.");
  }
}

function writeWorkspaceSnapshot(filePath, snapshot) {
  const serializable = {
    ...snapshot,
    entries: [...(snapshot?.entries instanceof Map ? snapshot.entries : [])]
  };
  writeJson(filePath, serializable);
}

function readWorkspaceSnapshot(filePath) {
  const stored = readJson(filePath);
  if (!stored || !Array.isArray(stored.entries)) return undefined;
  return { ...stored, entries: new Map(stored.entries) };
}

function labelWorkspaceChanges(changes = {}, label = "") {
  if (!label) return changes;
  const prefix = (items) => (Array.isArray(items) ? items : []).map((item) => (
    typeof item === "string" ? `${label}:${item}` : { ...item, path: `${label}:${item.path}` }
  ));
  return {
    ...changes,
    root: label,
    created: prefix(changes.created),
    modified: prefix(changes.modified),
    deleted: prefix(changes.deleted),
    observedArtifacts: prefix(changes.observedArtifacts)
  };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function processRoot(groupRoot) {
  return path.join(path.resolve(groupRoot), "shared", "logs", "processes");
}

function resolveGroupRoot(groupPath) {
  if (!groupPath || !fs.existsSync(groupPath)) throw toolError("missing_workspace", "Process control requires a group workspace.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function requireProcessId(value) {
  const processId = String(value || "").trim();
  if (!PROCESS_ID_PATTERN.test(processId)) throw toolError("invalid_process_id", "A valid background process id is required.");
  return processId;
}

function normalizeStream(value, state = {}) {
  const stream = String(value || "stdout").trim().toLowerCase();
  if (state.interactive && ["stdout", "terminal"].includes(stream)) return "stdout";
  if (["stdout", "stderr"].includes(stream)) return stream;
  throw toolError("invalid_process_stream", "Process output stream must be stdout, stderr, or terminal for an interactive process.");
}

function relativeCwd(groupRoot, cwd) {
  const relative = path.relative(groupRoot, cwd).replaceAll("\\", "/");
  return relative || ".";
}

function isPidAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.copyFileSync(temporary, filePath);
    fs.rmSync(temporary, { force: true });
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
