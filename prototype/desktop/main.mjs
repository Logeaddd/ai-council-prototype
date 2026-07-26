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
    if (!composerDropProbePath) mainWindow.show();
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
