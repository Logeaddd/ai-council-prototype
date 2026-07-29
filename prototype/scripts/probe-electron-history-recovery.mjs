import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-electron-history-recovery-"));
const marker = `history-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

try {
  const seeded = await runProbe("AI_COUNCIL_E2E_HISTORY_SEED", {
    AI_COUNCIL_E2E_HISTORY_SEED_PROBE: "1",
    AI_COUNCIL_E2E_HISTORY_MARKER: marker,
  });
  if (!seeded.ok || seeded.marker !== marker || !seeded.sessionId || seeded.status === "running" || Number(seeded.messageCount || 0) < 2) {
    throw new Error(`History seed probe did not persist a session. ${JSON.stringify(seeded)}`);
  }

  const reopened = await runProbe("AI_COUNCIL_E2E_HISTORY_REOPEN", {
    AI_COUNCIL_E2E_HISTORY_REOPEN_PROBE: "1",
    AI_COUNCIL_E2E_HISTORY_MARKER: marker,
  });
  if (!reopened.ok || reopened.marker !== marker || !reopened.visibleHistory) {
    throw new Error(`History reopen probe did not render the persisted session. ${JSON.stringify(reopened)}`);
  }

  console.log(JSON.stringify({ ok: true, probe: "electron_history_recovery", marker, seed: seeded, reopened }));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function runProbe(prefix, flags) {
  const output = [];
  const port = 51000 + Math.floor(Math.random() * 1000);
  const child = spawn(electronPath, [path.join(root, "desktop", "main.mjs")], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: path.join(tempRoot, "data"),
      AI_COUNCIL_WORKSPACE_ROOT: path.join(tempRoot, "workspace"),
      AI_COUNCIL_UI_PORT: String(port),
      ...flags,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const timer = setTimeout(() => child.kill(), 60_000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const transcript = output.join("");
  const resultLine = transcript.split(/\r?\n/).find((line) => line.startsWith(`${prefix}=`));
  if (exit.code !== 0 || !resultLine) {
    throw new Error(`Electron history ${prefix} probe failed (${JSON.stringify(exit)}).\n${transcript.slice(-6000)}`);
  }
  return JSON.parse(resultLine.slice(`${prefix}=`.length));
}
