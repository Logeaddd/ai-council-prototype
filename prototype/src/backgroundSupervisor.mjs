import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const HEARTBEAT_MS = 1000;
const STOP_POLL_MS = 200;

receiveConfig().then((config) => {
  supervise(config).catch((error) => {
    try {
      writeState(config?.statePath, {
        ...(readState(config?.statePath) || {}),
        status: "failed",
        code: "background_supervisor_failed",
        error: error.message || "Background supervisor failed.",
        finishedAt: new Date().toISOString()
      });
    } catch {}
    process.exitCode = 1;
  });
});

async function receiveConfig() {
  if (process.send) {
    return new Promise((resolve) => process.once("message", resolve));
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function supervise(config = {}) {
  validateConfig(config);
  const maxOutputBytes = Math.max(1024, Number(config.maxOutputBytes) || 32768);
  fs.mkdirSync(config.processDir, { recursive: true });
  const stdout = boundedLog(config.stdoutPath, maxOutputBytes);
  const stderr = boundedLog(config.stderrPath, maxOutputBytes);
  const child = spawn(config.invocation.file, config.invocation.args || [], {
    cwd: config.cwd,
    windowsHide: true,
    windowsVerbatimArguments: Boolean(config.invocation.windowsVerbatimArguments),
    detached: process.platform !== "win32",
    env: config.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stopRequested = false;
  let stoppingAt = "";
  let finished = false;

  const baseState = {
    ...(readState(config.statePath) || {}),
    processId: config.processId,
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

  child.stdout?.on("data", stdout.add);
  child.stderr?.on("data", stderr.add);
  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    stdout.close();
    stderr.close();
    persist({
      status: "failed",
      code: "command_spawn_failed",
      error: error.message,
      exitCode: null,
      signal: "",
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    });
    cleanupAndExit(1);
  });
  child.on("close", (exitCode, signal) => {
    if (finished) return;
    finished = true;
    const stopped = stopRequested;
    stdout.close();
    stderr.close();
    persist({
      status: stopped ? "stopped" : exitCode === 0 ? "exited" : "failed",
      code: stopped ? "process_stopped" : exitCode === 0 ? "" : "command_exit_nonzero",
      error: stopped || exitCode === 0 ? "" : `Background command exited with code ${exitCode}.`,
      exitCode,
      signal: signal || "",
      stopRequestedAt: stoppingAt,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    });
    cleanupAndExit(exitCode === 0 || stopped ? 0 : 1);
  });

  persist();

  const heartbeat = setInterval(() => {
    if (finished) return;
    persist({ status: stopRequested ? "stopping" : "running", heartbeatAt: new Date().toISOString() });
  }, HEARTBEAT_MS);

  const control = setInterval(() => {
    if (finished || !fs.existsSync(config.stopPath)) return;
    stopRequested = true;
    stoppingAt = new Date().toISOString();
    try {
      fs.rmSync(config.stopPath, { force: true });
    } catch {}
    persist({ status: "stopping", stopRequestedAt: stoppingAt, heartbeatAt: stoppingAt });
    killProcessTree(child);
  }, STOP_POLL_MS);

  function cleanupAndExit(code) {
    clearInterval(heartbeat);
    clearInterval(control);
    stdout.close();
    stderr.close();
    setTimeout(() => process.exit(code), 10).unref();
  }
}

function boundedLog(filePath, maxBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  let bytes = safeFileSize(filePath);
  let truncated = bytes >= maxBytes;
  let pending = "";
  let discard = truncated;
  const redactTailCharacters = 512;
  const flush = (final = false) => {
    if (!pending) return;
    const lastNewline = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r"));
    const proposedLength = final
      ? pending.length
      : Math.max(lastNewline + 1, pending.length - redactTailCharacters, 0);
    const flushLength = final ? proposedLength : avoidSensitiveBoundary(pending, proposedLength);
    if (flushLength <= 0) return;
    const text = redactSecrets(pending.slice(0, flushLength));
    pending = pending.slice(flushLength);
    write(Buffer.from(text));
  };
  const write = (buffer) => {
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const kept = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    fs.writeSync(fd, kept);
    bytes += kept.length;
    if (kept.length < buffer.length) truncated = true;
  };
  return {
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    add(chunk) {
      if (discard) {
        truncated = true;
        return;
      }
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      flush(false);
    },
    close() {
      try {
        flush(true);
        if (pending) {
          write(Buffer.from(redactSecrets(pending)));
          pending = "";
        }
        fs.closeSync(fd);
      } catch {}
    }
  };
}

function avoidSensitiveBoundary(text, proposedLength) {
  let safeLength = proposedLength;
  const patterns = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /api[_-]?key\s*[:=]\s*[^\s'\"]+/gi,
    /authorization\s*[:=]\s*bearer\s+[^\s'\"]+/gi,
    /password\s*[:=]\s*[^\s'\"]+/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index || 0;
      const end = start + match[0].length;
      if (start < safeLength && end > safeLength) safeLength = start;
    }
  }
  return safeLength;
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'\"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'\"]+/gi, "$1[redacted]");
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
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
}

function validateConfig(config) {
  for (const key of ["processId", "processDir", "statePath", "stdoutPath", "stderrPath", "stopPath", "cwd"]) {
    if (!config[key]) throw new Error(`Missing background supervisor ${key}.`);
  }
  if (!config.invocation?.file) throw new Error("Missing background supervisor invocation.");
}

function readState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function writeState(filePath, state) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
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
