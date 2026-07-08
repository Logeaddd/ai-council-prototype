import fs from "node:fs";
import path from "node:path";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_WAIT_MS = 5000;
const MAX_TEXT_CHARS = 8000;

export async function runBrowserAutomation(input = {}, electron = {}) {
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) throw toolError("browser_runtime_unavailable", "Electron BrowserWindow is not available.");
  const outputDir = String(input.outputDir || "").trim();
  if (!outputDir) throw toolError("missing_output_dir", "Browser automation requires an output directory.");
  fs.mkdirSync(outputDir, { recursive: true });

  const width = clampNumber(input.viewport?.width, DEFAULT_WIDTH, 320, 3840);
  const height = clampNumber(input.viewport?.height, DEFAULT_HEIGHT, 240, 2160);
  const startedAtMs = Date.now();
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  const steps = [];
  try {
    await loadUrl(win, input.url, input.timeoutMs);
    for (const [index, step] of normalizeSteps(input.steps).entries()) {
      steps.push(await runStep(win, step, index, {
        outputDir,
        timeoutMs: input.timeoutMs
      }));
    }
    const final = await pageSnapshot(win);
    return {
      ok: true,
      source: "local_browser_control",
      url: final.url,
      title: final.title,
      text: final.text,
      viewport: { width, height },
      steps,
      durationMs: Date.now() - startedAtMs
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function runStep(win, step, index, options) {
  const startedAtMs = Date.now();
  if (step.action === "open" || step.action === "navigate") {
    await loadUrl(win, step.url, options.timeoutMs);
    return stepResult(step, index, startedAtMs, { url: win.webContents.getURL() });
  }
  if (step.action === "wait") {
    await delay(clampNumber(step.waitMs, 500, 1, 60 * 1000));
    return stepResult(step, index, startedAtMs);
  }
  if (step.action === "wait_for_selector") {
    await waitForSelector(win, step.selector, step.waitMs || DEFAULT_WAIT_MS);
    return stepResult(step, index, startedAtMs, { selector: step.selector });
  }
  if (step.action === "click") {
    const point = await selectorCenter(win, step.selector);
    await win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    await win.webContents.sendInputEvent({ type: "mouseDown", button: "left", x: point.x, y: point.y, clickCount: 1 });
    await win.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: point.x, y: point.y, clickCount: 1 });
    await delay(100);
    return stepResult(step, index, startedAtMs, { selector: step.selector });
  }
  if (step.action === "type") {
    await focusSelector(win, step.selector);
    await win.webContents.insertText(String(step.text || ""));
    await delay(100);
    return stepResult(step, index, startedAtMs, {
      selector: step.selector,
      textBytes: Buffer.byteLength(String(step.text || ""), "utf8")
    });
  }
  if (step.action === "evaluate") {
    const value = await win.webContents.executeJavaScript(String(step.expression || ""), true);
    return stepResult(step, index, startedAtMs, { value: serializeValue(value) });
  }
  if (step.action === "screenshot") {
    const image = await win.webContents.capturePage();
    const fileName = `screenshot-${String(index + 1).padStart(2, "0")}.png`;
    const filePath = path.join(options.outputDir, fileName);
    fs.writeFileSync(filePath, image.toPNG());
    return stepResult(step, index, startedAtMs, {
      screenshotPath: fileName,
      bytes: fs.statSync(filePath).size
    });
  }
  throw toolError("unsupported_browser_action", `Unsupported browser action: ${step.action || "(empty)"}.`);
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      action: normalizeAction(item.action || item.type || item.name),
      url: String(item.url || "").trim(),
      selector: String(item.selector || "").trim(),
      text: String(item.text || item.value || item.inputText || ""),
      expression: String(item.expression || item.script || item.js || ""),
      waitMs: Number(item.waitMs || item.wait_ms || item.timeoutMs || item.timeout_ms)
    }));
}

function normalizeAction(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (raw === "waitforselector") return "wait_for_selector";
  return raw || "open";
}

async function loadUrl(win, url, timeoutMs) {
  const target = String(url || "").trim();
  if (!target) throw toolError("missing_url", "Browser automation requires a URL.");
  await withTimeout(win.loadURL(target), timeoutMs || DEFAULT_WAIT_MS * 2, `Timed out loading ${target}.`);
  await waitForLoad(win);
}

async function waitForLoad(win) {
  try {
    await win.webContents.executeJavaScript("document.readyState", true);
  } catch {
    await delay(200);
  }
}

async function selectorCenter(win, selector) {
  const found = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `, true);
  if (!found) throw toolError("selector_not_found", `Selector not found: ${selector}`);
  return found;
}

async function focusSelector(win, selector) {
  const ok = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      return true;
    })()
  `, true);
  if (!ok) throw toolError("selector_not_found", `Selector not found: ${selector}`);
}

async function waitForSelector(win, selector, waitMs) {
  const startedAtMs = Date.now();
  const timeoutMs = clampNumber(waitMs, DEFAULT_WAIT_MS, 100, 60 * 1000);
  while (Date.now() - startedAtMs < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, true);
    if (ok) return;
    await delay(100);
  }
  throw toolError("selector_timeout", `Timed out waiting for selector: ${selector}`);
}

async function pageSnapshot(win) {
  const value = await win.webContents.executeJavaScript(`
    (() => ({
      title: document.title || "",
      url: location.href,
      text: (document.body && document.body.innerText || "").slice(0, ${MAX_TEXT_CHARS})
    }))()
  `, true);
  return value || { title: "", url: win.webContents.getURL(), text: "" };
}

function stepResult(step, index, startedAtMs, extra = {}) {
  return {
    index,
    action: step.action,
    selector: step.selector || "",
    durationMs: Date.now() - startedAtMs,
    ...extra
  };
}

function serializeValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(toolError("browser_timeout", message)), timeoutMs))
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
