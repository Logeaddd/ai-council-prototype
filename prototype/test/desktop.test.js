import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");

test("desktop shell is wired through package scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.main, "./desktop/main.mjs");
  assert.equal(pkg.scripts.desktop, "electron ./desktop/main.mjs");
  assert.match(pkg.devDependencies.electron, /^\^/);
});

test("desktop shell disables browser context menu and keeps renderer isolated", () => {
  const main = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  assert.match(main, /BrowserWindow/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(main, /webContents\.on\("context-menu"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("aiCouncilDesktop"/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.doesNotMatch(preload, /ipcRenderer|node:fs|require\("fs"\)/);
  assert.match(main, /127\.0\.0\.1/);
  assert.match(main, /AI_COUNCIL_UI_PORT/);
  assert.match(main, /resolveAppIconPath/);
  assert.match(main, /build", iconName/);
});

test("desktop shell exposes a DevTools shortcut for debugging", () => {
  const main = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  assert.match(main, /before-input-event/);
  assert.match(main, /input\.control && input\.shift && key === "i"/);
  assert.match(main, /key === "f12"/);
  assert.match(main, /openDevTools/);
});

test("desktop startup scripts avoid npm PowerShell execution policy traps", () => {
  const startup = fs.readFileSync(path.join(root, "start-desktop.ps1"), "utf8");
  const shortcut = fs.readFileSync(path.join(root, "scripts", "install-desktop-shortcut.ps1"), "utf8");
  assert.match(startup, /npm\.cmd install/);
  assert.match(startup, /npm\.cmd run desktop/);
  assert.match(shortcut, /\[char\]0x5c0f/);
  assert.match(shortcut, /\[char\]0x7ec4/);
  assert.match(shortcut, /\[char\]0x542f/);
  assert.match(shortcut, /\[char\]0x52a8/);
  assert.match(shortcut, /ai-council-start\.ps1/);
  assert.match(shortcut, /ToBase64String/);
  assert.match(shortcut, /FromBase64String/);
  assert.match(shortcut, /chcp 65001/);
});
test("desktop portable build script packages the local Electron runtime", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const portable = fs.readFileSync(path.join(root, "scripts", "build-portable.ps1"), "utf8");
  assert.equal(pkg.scripts["desktop:portable"], "powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-portable.ps1");
  assert.match(portable, /node_modules\\electron\\dist/);
  assert.match(portable, /AI-Council-Portable/);
  assert.match(portable, /GetFullPath/);
  assert.match(portable, /portableLeaf/);
  assert.match(portable, /EndsWith/);
  assert.match(portable, /Refusing to delete unexpected portable output path/);
  assert.match(portable, /resources\\app/);
  assert.match(portable, /AI-Council\.bat/);
  assert.match(portable, /AI-Council\.exe/);
  assert.match(portable, /Rename-Item/);
  assert.match(portable, /Compress-Archive/);
  assert.match(portable, /desktop\\main\.mjs/);
  assert.match(portable, /renderer\\out/);
  assert.match(portable, /group\.example\.json/);
  assert.match(portable, /group\.real\.example\.json/);
  assert.doesNotMatch(portable, /includeDirs = @\("config"/);
  assert.doesNotMatch(portable, /Copy-Item .*public/);
  assert.doesNotMatch(portable, /group\.real\.json/);
});

test("desktop shell reads packaged data directory selection", () => {
  const main = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  assert.match(main, /configureDataDirectory\(\)/);
  assert.match(main, /AI_COUNCIL_DATA_DIR/);
  assert.match(main, /AI_COUNCIL_WORKSPACE_ROOT/);
  assert.match(main, /app\.getPath\("userData"\)/);
  assert.match(main, /app\.isPackaged/);
  assert.match(main, /data-path\.txt/);
  assert.match(main, /process\.resourcesPath/);
});

test("installer build keeps application source in ASAR with native PTY unpacked", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const installer = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  assert.equal(pkg.scripts["desktop:installer"], "npm run renderer:build && electron-builder --win nsis");
  assert.equal(pkg.scripts["desktop:dist"], "npm run renderer:build && npm run desktop:portable && electron-builder --win nsis");
  assert.equal(pkg.build.productName, "AI Council");
  assert.equal(pkg.build.asar, true);
  assert.deepEqual(pkg.build.asarUnpack, ["node_modules/node-pty/**"]);
  assert.equal(pkg.build.directories.output, "dist-installer");
  assert.deepEqual(pkg.build.win.target, ["nsis"]);
  assert.equal(pkg.build.win.artifactName, "AI-Council-Setup-${version}.${ext}");
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
  assert.ok(pkg.build.files.includes("renderer/out/**/*"));
  assert.ok(pkg.build.files.includes("desktop/**/*"));
  assert.ok(pkg.build.files.includes("src/**/*"));
  assert.ok(pkg.build.files.includes("build/icon.ico"));
  assert.ok(fs.existsSync(path.join(root, "build", "icon.ico")));
  assert.match(installer, /Page custom DataDirPageCreate DataDirPageLeave/);
  assert.match(installer, /数据保存位置/);
  assert.match(installer, /SelectFolderDialog/);
  assert.match(installer, /CreateDirectory "\$AI_COUNCIL_DATA_DIR"/);
  assert.match(installer, /FileOpen \$0 "\$INSTDIR\\data-path\.txt" w/);
  assert.doesNotMatch(installer, /Codex|harness|prototype|debug/i);
});

test("Electron runs the detached supervisor as Node and retains a packaged PTY probe", () => {
  const main = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  const processTools = fs.readFileSync(path.join(root, "src", "processTools.js"), "utf8");
  assert.match(processTools, /ELECTRON_RUN_AS_NODE: "1"/);
  assert.match(main, /AI_COUNCIL_E2E_PTY_PROBE/);
  assert.match(main, /runPackagedPtyProbe/);
  assert.match(main, /startManagedInteractiveProcess/);
  assert.match(main, /processControlTool/);
  assert.match(main, /pty_input_echo_was_not_redacted/);
});

test("desktop history recovery probe restarts the app before checking the persisted UI history", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const main = fs.readFileSync(path.join(root, "desktop", "main.mjs"), "utf8");
  const probe = fs.readFileSync(path.join(root, "scripts", "probe-electron-history-recovery.mjs"), "utf8");
  const topBar = fs.readFileSync(path.join(root, "renderer", "components", "council", "top-bar.tsx"), "utf8");

  assert.equal(pkg.scripts["probe:electron-history-recovery"], "node ./scripts/probe-electron-history-recovery.mjs");
  assert.match(main, /AI_COUNCIL_E2E_HISTORY_SEED_PROBE/);
  assert.match(main, /AI_COUNCIL_E2E_HISTORY_REOPEN_PROBE/);
  assert.match(main, /runHistorySeedProbe/);
  assert.match(main, /runHistoryReopenProbe/);
  assert.match(main, /session\.status !== "running"/);
  assert.match(main, /Number\(session\.messageCount \|\| 0\) >= 2/);
  assert.match(topBar, /data-testid="open-chat-history"/);
  assert.match(probe, /AI_COUNCIL_E2E_HISTORY_SEED/);
  assert.match(probe, /AI_COUNCIL_E2E_HISTORY_REOPEN/);
  assert.match(probe, /await runProbe/);
});
