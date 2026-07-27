import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-electron-transcript-follow-"));
const output = [];
const port = 50000 + Math.floor(Math.random() * 1000);
const child = spawn(electronPath, [path.join(root, "desktop", "main.mjs")], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    AI_COUNCIL_DATA_DIR: path.join(tempRoot, "data"),
    AI_COUNCIL_WORKSPACE_ROOT: path.join(tempRoot, "workspace"),
    AI_COUNCIL_UI_PORT: String(port),
    AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW_PROBE: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

const timer = setTimeout(() => child.kill(), 45_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

const transcript = output.join("");
const resultLine = transcript.split(/\r?\n/).find((line) => line.startsWith("AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW="));
if (exit.code !== 0 || !resultLine) {
  throw new Error(`Electron transcript follow probe failed (${JSON.stringify(exit)}).\n${transcript.slice(-4000)}`);
}
const result = JSON.parse(resultLine.slice("AI_COUNCIL_E2E_TRANSCRIPT_FOLLOW=".length));
if (!result.ok || result.afterManualScroll?.remaining <= 48 || result.afterManualScroll?.scrollTop > 2) {
  throw new Error(`Electron transcript follow probe did not preserve the manual scroll position.\n${JSON.stringify(result)}\n${transcript.slice(-4000)}`);
}
console.log(JSON.stringify({ ok: true, probe: "electron_transcript_follow", result }));
