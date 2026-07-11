import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");

test("HTTP stop aborts the active backend council and persists interruption", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-stop-"));
  const groupPath = path.join(dataDir, "workspace-ui", "group-a");
  fs.mkdirSync(path.join(groupPath, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({
    id: "group-a",
    name: "Group A",
    permissions: { defaultTier: "text", seatTiers: {} },
    seats: [{ seatId: "worker", displayName: "Worker", enabled: true }]
  }), "utf8");

  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: dataDir,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const response = await fetch(`http://127.0.0.1:${port}/api/council/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Build a real file.",
        workspaceGroupPath: groupPath,
        maxRounds: 100,
        runtimeGroup: {
          id: "group-a",
          name: "Group A",
          settings: { maxRounds: 100, minRounds: 100, stopWhenAllSkip: false, allowSoloCouncil: true, agentTimeoutMs: 1000 },
          agents: [{
            id: "worker",
            name: "Worker",
            role: "Builder",
            provider: "mock",
            apiBaseUrl: "mock://local",
            model: "mock-worker",
            weight: 1,
            enabled: true
          }]
        }
      })
    });
    assert.equal(response.status, 200);

    const stop = await requestJson(port, "/api/council/stop", { workspaceGroupPath: groupPath });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.stopped, true);
    await response.text();

    const sessionFile = await waitForSession(groupPath);
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.equal(session.status, "interrupted");
    assert.equal(session.interruptionReason, "stopped_by_user");
    assert.ok(session.modelCallCount <= 1);
  } finally {
    child.kill();
    await waitForExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Wait for the local server to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output()}`);
}

async function requestJson(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function waitForSession(groupPath) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const file = fs.readdirSync(path.join(groupPath, "sessions"))
      .find((name) => name.endsWith(".json"));
    if (file) return path.join(groupPath, "sessions", file);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Interrupted session was not persisted.");
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
