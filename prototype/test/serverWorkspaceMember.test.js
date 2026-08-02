import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("workspace member deletion API persists removal and preserves private data", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-delete-"));
  const port = await reservePort();
  const token = "a".repeat(32);
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_LOCAL_API_TOKEN: token,
      AI_COUNCIL_WORKSPACE_ROOT: root,
      AI_COUNCIL_DATA_DIR: path.join(root, "app-data")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  await waitForHealth(port);
  const groupResult = await requestJson(port, "/api/workspace/init", {
    root,
    groupFolderName: "api-delete-group",
    members: [
      { seatId: "builder", displayName: "Builder", model: "mock-builder" },
      { seatId: "reviewer", displayName: "Reviewer", model: "mock-reviewer" }
    ]
  }, token);
  assert.equal(groupResult.status, 200);
  const groupPath = groupResult.body.groupPath;
  const privateFolder = groupResult.body.seats.find((seat) => seat.seatId === "reviewer").privateFolder;

  const deleteResult = await requestJson(port, "/api/workspace/delete-member", {
    groupPath,
    seatId: "reviewer"
  }, token);
  assert.equal(deleteResult.status, 200);
  assert.equal(deleteResult.body.deletedSeat.seatId, "reviewer");
  assert.equal(deleteResult.body.preservedPrivateFolder, privateFolder);
  assert.deepEqual(deleteResult.body.group.seats.map((seat) => seat.seatId), ["builder"]);
  assert.equal(fs.existsSync(path.join(groupPath, privateFolder, "handoff.md")), true);
});

test("workspace member deletion API requires the local API token", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-auth-"));
  const port = await reservePort();
  const token = "b".repeat(32);
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_LOCAL_API_TOKEN: token,
      AI_COUNCIL_WORKSPACE_ROOT: root,
      AI_COUNCIL_DATA_DIR: path.join(root, "app-data")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  await waitForHealth(port);
  const result = await requestJson(port, "/api/workspace/delete-member", {
    groupPath: root,
    seatId: "builder"
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "local_api_auth_required");
});

async function reservePort() {
  const net = await import("node:net");
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Server did not become healthy before the test deadline.");
}

async function requestJson(port, route, body, token = "") {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-ai-council-token": token } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
