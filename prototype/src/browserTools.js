import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowserAutomation } from "./browserAutomation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

export async function browserControlTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const id = safeId(request.id);
  const outputDir = path.join(groupRoot, "shared", "browser", "runs", id);
  fs.mkdirSync(outputDir, { recursive: true });

  const timeoutMs = clampNumber(request.timeoutMs || options.browserTimeoutMs || options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const input = {
    url: requiredBrowserUrl(request.url),
    steps: normalizeBrowserSteps(request),
    outputDir,
    timeoutMs,
    viewport: normalizeViewport(request.viewport)
  };

  const startedAtMs = Date.now();
  const result = process.versions.electron
    ? await runInCurrentElectron(input)
    : await runWithElectronBinary(input, {
      outputDir,
      timeoutMs,
      maxOutputBytes: request.maxOutputBytes || options.maxBrowserOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
      signal: options.signal
    });

  return normalizeResult(result, {
    groupRoot,
    outputDir,
    durationMs: Date.now() - startedAtMs
  });
}

async function runInCurrentElectron(input) {
  const electron = await import("electron");
  return runBrowserAutomation(input, electron);
}

async function runWithElectronBinary(input, options) {
  const electronPath = await resolveElectronPath();
  const inputPath = path.join(options.outputDir, "input.json");
  const outputPath = path.join(options.outputDir, "output.json");
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), "utf8");
  const runnerPath = path.join(__dirname, "browserRunner.mjs");
  const childResult = await spawnElectron(electronPath, [runnerPath, inputPath, outputPath], options);
  if (!fs.existsSync(outputPath)) {
    return {
      ok: false,
      source: "local_browser_control",
      code: childResult.code || "browser_output_missing",
      error: childResult.error || "Browser runner did not write an output file.",
      stdout: childResult.stdout,
      stderr: childResult.stderr,
      exitCode: childResult.exitCode,
      timedOut: childResult.timedOut
    };
  }
  const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  return {
    ...parsed,
    stdout: childResult.stdout,
    stderr: childResult.stderr,
    exitCode: childResult.exitCode,
    timedOut: childResult.timedOut
  };
}

function spawnElectron(file, args, options = {}) {
  return new Promise((resolve) => {
    const stdout = outputBuffer(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
    const stderr = outputBuffer(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: path.dirname(file),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const abort = () => {
      timedOut = true;
      killProcess(child);
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
      resolve({
        ...payload,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated
      });
    };

    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        code: "browser_spawn_failed",
        error: error.message,
        exitCode: null,
        timedOut
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        ok: exitCode === 0 && !timedOut,
        code: timedOut ? "browser_timeout" : exitCode === 0 ? undefined : "browser_exit_nonzero",
        error: timedOut ? `Browser operation exceeded ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms and was stopped.` : exitCode === 0 ? "" : `Browser runner exited with code ${exitCode}.`,
        exitCode,
        signal,
        timedOut
      });
    });
  });
}

async function resolveElectronPath() {
  if (process.env.AI_COUNCIL_ELECTRON_PATH) return process.env.AI_COUNCIL_ELECTRON_PATH;
  try {
    const electronModule = await import("electron");
    const electronPath = typeof electronModule.default === "string" ? electronModule.default : "";
    if (electronPath) return electronPath;
  } catch {
    // Fall through to a clear not-configured error.
  }
  throw toolError("browser_runtime_unavailable", "Electron browser runtime is not available.");
}

function normalizeBrowserSteps(request) {
  const fromArray = Array.isArray(request.steps) ? request.steps : [];
  if (fromArray.length) return fromArray.map(normalizeStep).filter(Boolean);
  const action = normalizeAction(request.action || "open");
  if (action === "open") return request.screenshot ? [{ action: "screenshot" }] : [];
  const step = normalizeStep({
    action,
    url: request.url,
    selector: request.selector,
    text: request.inputText,
    expression: request.expression,
    waitMs: request.waitMs
  });
  return step ? [step] : [];
}

function normalizeStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  return {
    action: normalizeAction(step.action || step.type || step.name),
    url: step.url ? requiredBrowserUrl(step.url) : "",
    selector: String(step.selector || "").trim(),
    text: String(step.text || step.value || step.inputText || ""),
    expression: String(step.expression || step.script || step.js || ""),
    waitMs: normalizeOptionalNumber(step.waitMs || step.wait_ms || step.timeoutMs || step.timeout_ms)
  };
}

function normalizeAction(value) {
  const raw = String(value || "open").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["open", "navigate", "click", "type", "evaluate", "screenshot", "wait", "wait_for_selector"].includes(raw)) return raw;
  if (raw === "waitforselector") return "wait_for_selector";
  throw toolError("unsupported_browser_action", `Unsupported browser action: ${raw || "(empty)"}.`);
}

function normalizeViewport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    width: normalizeOptionalNumber(value.width),
    height: normalizeOptionalNumber(value.height)
  };
}

function normalizeResult(result, context) {
  const screenshots = collectScreenshots(result.steps || [], context.outputDir, context.groupRoot);
  return {
    ok: Boolean(result.ok),
    source: "local_browser_control",
    url: result.url || "",
    title: result.title || "",
    text: result.text || "",
    viewport: result.viewport || {},
    steps: (result.steps || []).map((step) => ({
      ...step,
      screenshotPath: step.screenshotPath
        ? path.join(path.relative(context.groupRoot, context.outputDir), step.screenshotPath).replaceAll("\\", "/")
        : ""
    })),
    screenshots,
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs || context.durationMs,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.code,
    error: result.error || ""
  };
}

function collectScreenshots(steps, outputDir, groupRoot) {
  return steps
    .filter((step) => step.screenshotPath)
    .map((step) => {
      const filePath = path.join(outputDir, step.screenshotPath);
      return {
        path: path.relative(groupRoot, filePath).replaceAll("\\", "/"),
        bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
      };
    });
}

function requiredBrowserUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw toolError("missing_url", "browser_control requires url.");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw toolError("invalid_url", "browser_control url must be a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw toolError("unsupported_url_protocol", "browser_control only supports http and https URLs.");
  }
  return parsed.toString();
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "browser_control requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function safeId(value) {
  return String(value || "browser")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80) || "browser";
}

function killProcess(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    child.kill("SIGTERM");
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

function normalizeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
