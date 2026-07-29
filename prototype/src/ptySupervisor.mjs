import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_MS = 1000;
const STOP_POLL_MS = 200;
const CONTROL_POLL_MS = 50;

receiveConfig().then((config) => {
  supervise(config).catch((error) => {
    try {
      writeState(config?.statePath, {
        ...(readState(config?.statePath) || {}),
        status: "failed",
        code: "pty_supervisor_failed",
        error: error.message || "Interactive terminal supervisor failed.",
        finishedAt: new Date().toISOString()
      });
    } catch {}
    process.exitCode = 1;
  });
});

async function receiveConfig() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function supervise(config = {}) {
  validateConfig(config);
  const ptyModule = await import("node-pty");
  const pty = ptyModule.default || ptyModule;
  if (typeof pty.spawn !== "function") throw new Error("The installed PTY runtime does not export spawn().");

  const maxOutputBytes = Math.max(1024, Number(config.maxOutputBytes) || 32768);
  const terminal = {
    columns: clamp(config.terminal?.columns, 100, 20, 300),
    rows: clamp(config.terminal?.rows, 30, 5, 200),
    lastControlId: "",
    lastControlAt: ""
  };
  fs.mkdirSync(config.processDir, { recursive: true });
  fs.mkdirSync(config.terminalControlPendingDir, { recursive: true });
  fs.mkdirSync(config.terminalControlAckDir, { recursive: true });
  const terminalInputRedactions = [];
  const stdout = boundedLog(config.stdoutPath, maxOutputBytes, { terminalInputRedactions });
  const stderr = boundedLog(config.stderrPath, maxOutputBytes);
  const child = pty.spawn(config.invocation.file, config.invocation.args || [], {
    name: "xterm-256color",
    cols: terminal.columns,
    rows: terminal.rows,
    cwd: config.cwd,
    env: config.env,
    windowsHide: true,
    // The bundled ConPTY helper is unstable with nested Windows command lines
    // under the Node 24 runtime used by the desktop app. winpty remains a real
    // PTY and has the compatible lifecycle here.
    useConpty: process.platform === "win32" ? false : undefined
  });
  let stopRequested = false;
  let stoppingAt = "";
  let finished = false;

  const baseState = {
    ...(readState(config.statePath) || {}),
    processId: config.processId,
    source: "managed_interactive_pty",
    interactive: true,
    status: "running",
    supervisorPid: process.pid,
    pid: child.pid || null,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  };

  const persist = (patch = {}) => {
    const state = {
      ...(readState(config.statePath) || {}),
      ...baseState,
      ...patch,
      interactive: true,
      terminal: { ...terminal, ...(patch.terminal || {}) },
      supervisorPid: process.pid,
      pid: child.pid || null,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated
    };
    writeState(config.statePath, state);
    return state;
  };

  const finish = ({ exitCode = null, signal = "", error = "" } = {}) => {
    if (finished) return;
    finished = true;
    stdout.close();
    stderr.close();
    const stopped = stopRequested;
    const succeeded = exitCode === 0;
    persist({
      status: stopped ? "stopped" : succeeded ? "exited" : "failed",
      code: stopped ? "process_stopped" : succeeded ? "" : "terminal_exit_nonzero",
      error: stopped || succeeded ? "" : error || `Interactive terminal exited with code ${exitCode ?? "unknown"}.`,
      exitCode,
      signal: signal || "",
      stopRequestedAt: stoppingAt,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    });
    cleanupAndExit(stopped || succeeded ? 0 : 1);
  };

  child.onData((data) => stdout.add(data));
  child.onExit(({ exitCode, signal }) => finish({ exitCode: Number.isInteger(exitCode) ? exitCode : null, signal }));
  persist({ terminal });
  if (config.initialInput) writeTerminalInput(String(config.initialInput));

  const heartbeat = setInterval(() => {
    if (!finished) persist({ status: stopRequested ? "stopping" : "running", heartbeatAt: new Date().toISOString(), terminal });
  }, HEARTBEAT_MS);
  const controls = setInterval(() => {
    if (!finished) processControls();
  }, CONTROL_POLL_MS);
  const stop = setInterval(() => {
    if (finished || !fs.existsSync(config.stopPath)) return;
    stopRequested = true;
    stoppingAt = new Date().toISOString();
    try { fs.rmSync(config.stopPath, { force: true }); } catch {}
    persist({ status: "stopping", stopRequestedAt: stoppingAt, heartbeatAt: stoppingAt, terminal });
    try { child.kill(); } catch {}
  }, STOP_POLL_MS);

  function processControls() {
    const entries = fs.readdirSync(config.terminalControlPendingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
    for (const entry of entries) {
      const pendingPath = path.join(config.terminalControlPendingDir, entry.name);
      const control = readJson(pendingPath);
      if (!control?.id || !control?.type) continue;
      const acknowledgedAt = new Date().toISOString();
      let status = "accepted";
      let error = "";
      try {
        if (control.type === "input") {
          writeTerminalInput(String(control.value || ""));
        } else if (control.type === "resize") {
          terminal.columns = clamp(control.columns, terminal.columns, 20, 300);
          terminal.rows = clamp(control.rows, terminal.rows, 5, 200);
          child.resize(terminal.columns, terminal.rows);
        } else {
          status = "rejected";
          error = "Unsupported terminal control type.";
        }
      } catch (failure) {
        status = "rejected";
        error = failure.message || "Terminal control could not be applied.";
      }
      terminal.lastControlId = String(control.id);
      terminal.lastControlAt = acknowledgedAt;
      // The acknowledgement is an API-level commit point: once a caller sees
      // it, the corresponding terminal state must already be observable.
      persist({ terminal });
      writeJson(path.join(config.terminalControlAckDir, `${control.id}.json`), {
        id: control.id,
        type: control.type,
        status,
        acknowledgedAt,
        error
      });
      try { fs.rmSync(pendingPath, { force: true }); } catch {}
    }
  }

  function cleanupAndExit(code) {
    clearInterval(heartbeat);
    clearInterval(controls);
    clearInterval(stop);
    stdout.close();
    stderr.close();
    setTimeout(() => process.exit(code), 10).unref();
  }

  function writeTerminalInput(value) {
    const input = String(value || "");
    for (const candidate of terminalInputCandidates(input)) {
      if (!terminalInputRedactions.includes(candidate)) terminalInputRedactions.push(candidate);
    }
    child.write(input);
  }
}

function boundedLog(filePath, maxBytes, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  let bytes = safeFileSize(filePath);
  let truncated = bytes >= maxBytes;
  let pending = "";
  const terminalInputRedactions = Array.isArray(options.terminalInputRedactions) ? options.terminalInputRedactions : [];
  return {
    get bytes() { return bytes; },
    get truncated() { return truncated; },
    add(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const drained = drainTerminalInput(pending, terminalInputRedactions);
      write(drained.output);
      pending = drained.pending;
    },
    close() {
      if (pending) write(redactTerminalInputRemainder(pending, terminalInputRedactions));
      pending = "";
      try { fs.closeSync(fd); } catch {}
    }
  };

  function write(text) {
    const remaining = maxBytes - bytes;
    if (remaining <= 0) { truncated = true; return; }
    const buffer = Buffer.from(text);
    const kept = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    fs.writeSync(fd, kept);
    bytes += kept.length;
    if (kept.length < buffer.length) truncated = true;
  }
}

function terminalInputCandidates(value) {
  const exact = String(value || "");
  const line = exact.replace(/[\r\n]+$/g, "");
  // Console hosts may wrap long command lines or inject control sequences
  // between words. Retaining individual input tokens closes that echo path as
  // well as the straightforward whole-line echo case.
  const tokens = line.split(/[^A-Za-z0-9_./:\\-]+/).filter(Boolean);
  return [...new Set([exact, line, ...tokens].filter((item) => item.length >= 1))];
}

function drainTerminalInput(text, redactions) {
  let pending = String(text || "");
  let output = "";
  const candidates = (redactions || []).map((item) => String(item || "")).filter(Boolean);
  while (pending) {
    const full = candidates.find((candidate) => pending.startsWith(candidate));
    if (full) {
      output += "[terminal-input-redacted]";
      pending = pending.slice(full.length);
      continue;
    }
    if (candidates.some((candidate) => candidate.startsWith(pending))) break;
    output += pending[0];
    pending = pending.slice(1);
  }
  return { output: redactSecrets(output), pending };
}

function redactTerminalInputRemainder(text, redactions) {
  const value = String(text || "");
  const candidates = (redactions || []).map((item) => String(item || "")).filter(Boolean);
  if (candidates.some((candidate) => candidate.startsWith(value))) return "[terminal-input-redacted]";
  return redactSecrets(value);
}

function validateConfig(config) {
  for (const key of ["processId", "processDir", "statePath", "stdoutPath", "stderrPath", "stopPath", "cwd", "terminalControlPendingDir", "terminalControlAckDir"]) {
    if (!config[key]) throw new Error(`Missing PTY supervisor ${key}.`);
  }
  if (!config.invocation?.file) throw new Error("Missing PTY supervisor invocation.");
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return undefined; }
}

function readState(filePath) {
  return readJson(filePath);
}

function writeState(filePath, state) {
  writeJson(filePath, state);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { fs.renameSync(temporary, filePath); } catch { fs.copyFileSync(temporary, filePath); fs.rmSync(temporary, { force: true }); }
}

function safeFileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]");
}
