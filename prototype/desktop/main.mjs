import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell } from "electron";

const DEFAULT_PORT = Number(process.env.AI_COUNCIL_UI_PORT || 4317);
const HOST = "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composerDropProbePath = String(process.env.AI_COUNCIL_E2E_COMPOSER_DROP_FILE || "").trim();
const privateDraftProbeEnabled = process.env.AI_COUNCIL_E2E_PRIVATE_DRAFT_PROBE === "1";

let mainWindow;

app.setName("AI Council");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktop).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startDesktop().catch((error) => console.error(error));
  }
});

async function startDesktop() {
  if (mainWindow) return;
  Menu.setApplicationMenu(null);
  const port = await findOpenPort(DEFAULT_PORT);
  configureDataDirectory();
  process.env.AI_COUNCIL_UI_HOST = HOST;
  process.env.AI_COUNCIL_UI_PORT = String(port);
  await import("../src/server.js");
  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "AI Council",
    icon: resolveAppIconPath(),
    backgroundColor: "#f3f4f5",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("context-menu", (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    const wantsDevTools = (input.control && input.shift && key === "i") || key === "f12";
    if (!wantsDevTools) return;
    event.preventDefault();
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
      return;
    }
    mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    if (!composerDropProbePath && !privateDraftProbeEnabled) mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`http://${HOST}:${port}`);
  if (composerDropProbePath) {
    try {
      const result = await runComposerDropProbe(mainWindow, composerDropProbePath);
      console.log(`AI_COUNCIL_E2E_COMPOSER_DROP=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_COMPOSER_DROP_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  } else if (privateDraftProbeEnabled) {
    try {
      mainWindow.show();
      mainWindow.focus();
      const result = await runPrivateDraftProbe(mainWindow);
      console.log(`AI_COUNCIL_E2E_PRIVATE_DRAFT=${JSON.stringify(result)}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      console.error("AI_COUNCIL_E2E_PRIVATE_DRAFT_FAILED", error);
    } finally {
      setTimeout(() => app.quit(), 50);
    }
  }
}

async function runComposerDropProbe(window, filePath) {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, "utf8");
  const payload = JSON.stringify({ name: path.basename(resolved), text });
  return window.webContents.executeJavaScript(`
    (async () => {
      const payload = ${payload};
      const deadline = Date.now() + 8000;
      let textarea = null;
      while (Date.now() < deadline) {
        textarea = document.querySelector("textarea");
        if (textarea) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!textarea) return { ok: false, reason: "composer_textarea_missing" };
      const target = textarea.parentElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([payload.text], payload.name, { type: "text/plain" }));
      const dispatchResult = target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      const attachmentDeadline = Date.now() + 8000;
      while (Date.now() < attachmentDeadline) {
        if (document.body.textContent?.includes(payload.name)) {
          return {
            ok: true,
            defaultPrevented: !dispatchResult,
            attachment: payload.name
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        ok: false,
        reason: "attachment_not_rendered",
        defaultPrevented: !dispatchResult
      };
    })()
  `, true);
}

async function runPrivateDraftProbe(window) {
  const created = await window.webContents.executeJavaScript(`
    (async () => {
      async function request(path, body) {
        const token = window.__AI_COUNCIL_LOCAL_API_TOKEN__
          || document.querySelector('meta[name="ai-council-local-api-token"]')?.getAttribute("content")
          || "";
        const response = await fetch(path, {
          method: body ? "POST" : "GET",
          headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { "X-AI-Council-Token": token } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || response.statusText);
        return payload;
      }
      const health = await request("/api/health");
      return request("/api/workspace/init", {
        root: health.allowedWorkspaceRoot,
        groupFolderName: "private-draft-probe",
        members: [{
          seatId: "probe_member",
          displayName: "Probe Member",
          model: "probe-model",
          role: "ordinary",
        }],
      });
    })()
  `, true);
  if (!created?.groupPath || !created?.seats?.length) throw new Error("probe_group_not_created");

  await window.loadURL(window.webContents.getURL());
  const groupDraft = "group draft stays in the group composer";
  const privateDraft = "private draft stays with the selected member";
  await window.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const composer = document.querySelector("[data-testid='group-chat-draft']");
        const privateButton = document.querySelector("[data-testid='open-private-chat']");
        if (composer?.dataset.draftReady === "true" && privateButton && !privateButton.disabled) {
          composer.focus();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("group_composer_not_ready_after_group_creation");
    })()
  `, true);
  await typeProbeText(window, "[data-testid='group-chat-draft']", groupDraft, "group_composer_text_input_failed");
  await window.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      async function waitFor(getValue, reason, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = getValue();
          if (value) return value;
          await sleep(50);
        }
        throw new Error(reason);
      }
      const privateButton = await waitFor(
        () => {
          const candidate = document.querySelector("[data-testid='open-private-chat']");
          return candidate && !candidate.disabled ? candidate : null;
        },
        "private_chat_button_disabled"
      );
      await waitFor(
        () => Object.keys(localStorage).some((key) => key.startsWith("ai-council:draft:") && localStorage.getItem(key) === ${JSON.stringify(groupDraft)}),
        "group_draft_not_persisted"
      );
      privateButton.click();
      return;
    })()
  `, true);

  await focusProbeElement(window, "[data-testid='private-chat-draft']", "private_composer_missing");
  await typeProbeText(window, "[data-testid='private-chat-draft']", privateDraft, "private_composer_text_input_failed");
  return window.webContents.executeJavaScript(`
    (async () => {
      async function waitFor(getValue, reason, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = getValue();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(reason);
      }
      await waitFor(
        () => Object.keys(localStorage).some((key) => key.startsWith("ai-council:private-draft:") && localStorage.getItem(key) === ${JSON.stringify(privateDraft)}),
        "private_draft_not_persisted"
      );
      const groupComposer = document.querySelector("[data-testid='group-chat-draft']");
      const privateComposer = document.querySelector("[data-testid='private-chat-draft']");
      const beforeClose = {
        groupValue: groupComposer.value,
        privateValue: privateComposer.value,
        groupKeys: Object.keys(localStorage).filter((key) => key.startsWith("ai-council:draft:")),
        privateKeys: Object.keys(localStorage).filter((key) => key.startsWith("ai-council:private-draft:")),
      };
      if (beforeClose.groupValue !== ${JSON.stringify(groupDraft)} || beforeClose.privateValue !== ${JSON.stringify(privateDraft)}) {
        throw new Error("draft_values_not_independent_before_close");
      }
      if (beforeClose.groupKeys.length !== 1 || beforeClose.privateKeys.length !== 1) {
        throw new Error("draft_storage_keys_not_isolated");
      }
      const closeButton = await waitFor(
        () => document.querySelector("[role='dialog'] button[aria-label]"),
        "private_chat_close_button_missing"
      );
      closeButton.click();
      await waitFor(
        () => !document.querySelector("[data-testid='private-chat-draft']"),
        "private_chat_did_not_close"
      );
      document.querySelector("[data-testid='open-private-chat']").click();
      const reopenedPrivateComposer = await waitFor(
        () => document.querySelector("[data-testid='private-chat-draft']"),
        "private_composer_missing_after_reopen"
      );
      if (reopenedPrivateComposer.value !== ${JSON.stringify(privateDraft)}) throw new Error("private_draft_not_restored_after_reopen");
      if (document.querySelector("[data-testid='group-chat-draft']").value !== ${JSON.stringify(groupDraft)}) {
        throw new Error("group_draft_changed_after_private_chat");
      }
      return {
        ok: true,
        probe: "electron_private_draft",
        groupDraft: ${JSON.stringify(groupDraft)},
        privateDraft: ${JSON.stringify(privateDraft)},
        groupKey: beforeClose.groupKeys[0],
        privateKey: beforeClose.privateKeys[0],
      };
    })()
  `, true);
}

async function focusProbeElement(window, selector, reason) {
  return window.webContents.executeJavaScript(`
    (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element?.dataset.draftReady === "true") {
          element.focus();
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(${JSON.stringify(reason)});
    })()
  `, true);
}

async function typeProbeText(window, selector, value, reason) {
  await focusProbeElement(window, selector, reason);
  window.show();
  window.focus();
  window.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.select()`, true);
  await window.webContents.insertText(value);
  const accepted = await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
    true
  );
  if (!accepted) throw new Error(reason);
}

function resolveAppIconPath() {
  const appRoot = path.resolve(__dirname, "..");
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const packagedIcon = path.join(appRoot, "build", iconName);
  if (fs.existsSync(packagedIcon)) return packagedIcon;
  return path.join(appRoot, "renderer", "public", "logo.png");
}

function configureDataDirectory() {
  if (process.env.AI_COUNCIL_DATA_DIR) return;
  const configuredPath = readConfiguredDataPath();
  const dataDir = configuredPath || app.getPath("userData");
  process.env.AI_COUNCIL_DATA_DIR = path.resolve(dataDir);
  if (!process.env.AI_COUNCIL_WORKSPACE_ROOT) {
    process.env.AI_COUNCIL_WORKSPACE_ROOT = process.env.AI_COUNCIL_DATA_DIR;
  }
}

function readConfiguredDataPath() {
  if (!app.isPackaged) return "";
  const installDir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(installDir, "data-path.txt"),
    path.join(process.resourcesPath, "data-path.txt")
  ]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      continue;
    }
  }
  return "";
}

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
          return;
        }
        reject(error);
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, HOST);
    };
    tryPort(startPort);
  });
}

async function waitForServer(port) {
  const url = `http://${HOST}:${port}/api/health`;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await canReach(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`AI Council server did not start on ${url}`);
}

function canReach(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}
