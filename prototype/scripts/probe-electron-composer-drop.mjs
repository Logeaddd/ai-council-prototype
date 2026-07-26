import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-electron-drop-"));
const fixturePath = path.join(tempRoot, "dropped-note.txt");
fs.writeFileSync(fixturePath, "Electron drag-and-drop probe.\n", "utf8");

const output = [];
const port = 48000 + Math.floor(Math.random() * 1000);
const child = spawn(electronPath, [path.join(root, "desktop", "main.mjs")], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    AI_COUNCIL_DATA_DIR: path.join(tempRoot, "data"),
    AI_COUNCIL_WORKSPACE_ROOT: path.join(tempRoot, "workspace"),
    AI_COUNCIL_UI_PORT: String(port),
    AI_COUNCIL_E2E_COMPOSER_DROP_FILE: fixturePath
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

const timer = setTimeout(() => {
  child.kill();
}, 30_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

const transcript = output.join("");
const resultLine = transcript.split(/\r?\n/).find((line) => line.startsWith("AI_COUNCIL_E2E_COMPOSER_DROP="));
if (exit.code !== 0 || !resultLine) {
  throw new Error(`Electron composer drop probe failed (${JSON.stringify(exit)}).\n${transcript.slice(-4000)}`);
}
const result = JSON.parse(resultLine.slice("AI_COUNCIL_E2E_COMPOSER_DROP=".length));
if (!result.ok || result.attachment !== path.basename(fixturePath)) {
  throw new Error(`Electron composer drop probe did not render the dropped attachment.\n${JSON.stringify(result)}\n${transcript.slice(-4000)}`);
}
console.log(JSON.stringify({ ok: true, probe: "electron_composer_drop", result }));
