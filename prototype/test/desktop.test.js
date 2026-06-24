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
  assert.match(main, /BrowserWindow/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(main, /webContents\.on\("context-menu"/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /127\.0\.0\.1/);
  assert.match(main, /AI_COUNCIL_UI_PORT/);
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
  assert.match(portable, /group\.example\.json/);
  assert.match(portable, /group\.real\.example\.json/);
  assert.doesNotMatch(portable, /includeDirs = @\("config"/);
  assert.doesNotMatch(portable, /group\.real\.json/);
});
