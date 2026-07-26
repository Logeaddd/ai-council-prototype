import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");
const localApiToken = "test-local-api-token-0123456789abcdef";

test("persisted capability switches block direct server execution routes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-capabilities-"));
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: dataDir,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    await requestJson(port, "/api/app-settings", {
      appearance: { theme: "dark" },
      capabilities: {
        toolAccess: { web: false, files: false, mcp: false }
      }
    });

    const appSettings = await requestJson(port, "/api/app-settings", undefined, "GET");
    assert.equal(appSettings.status, 200);
    assert.equal(appSettings.body.appearance.theme, "dark");

    const capabilityState = await requestJson(port, "/api/capabilities", undefined, "GET");
    assert.equal(capabilityState.status, 200);
    assert.equal(capabilityState.body.toolAccess.web, false);
    assert.equal(capabilityState.body.toolAccess.files, false);
    assert.equal(capabilityState.body.toolAccess.mcp, false);

    for (const route of [
      "/api/tools/web-search",
      "/api/tools/fetch-url",
      "/api/mcp/tools/list",
      "/api/mcp/tools/call",
      "/api/mcp/resources/list",
      "/api/mcp/resources/read",
      "/api/mcp/prompts/list",
      "/api/mcp/prompts/get",
      "/api/file-operations/approve",
      "/api/file-operations/auto-approve",
      "/api/file-operations/execute",
      "/api/file-operations/restore"
    ]) {
      const response = await requestJson(port, route, {});
      assert.equal(response.status, 409, route);
      assert.equal(response.body.code, "capability_disabled", route);
    }

    const rejectResponse = await requestJson(port, "/api/file-operations/reject", {});
    assert.notEqual(rejectResponse.body.code, "capability_disabled");

    await requestJson(port, "/api/app-settings", {
      capabilities: {
        toolAccess: { mcp: true, web: false }
      }
    });
    const builtInWeb = await requestJson(port, "/api/mcp/tools/call", {
      serverId: "web-tools",
      mcpToolName: "web_search",
      arguments: { query: "must not run" }
    });
    assert.equal(builtInWeb.status, 409);
    assert.equal(builtInWeb.body.code, "capability_disabled");
    assert.equal(builtInWeb.body.error, "web_capability_disabled");
  } finally {
    child.kill();
    await waitForExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("local API requires the per-server token and rejects cross-origin or non-JSON mutations", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-server-auth-"));
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      AI_COUNCIL_DATA_DIR: dataDir,
      AI_COUNCIL_UI_PORT: String(port),
      AI_COUNCIL_UI_HOST: "127.0.0.1",
      AI_COUNCIL_LOCAL_API_TOKEN: localApiToken
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(port, child, () => output);
    const rootPage = await fetch(`http://127.0.0.1:${port}/`);
    const html = await rootPage.text();
    assert.match(html, new RegExp(`name="ai-council-local-api-token" content="${localApiToken}"`));

    const missingToken = await fetch(`http://127.0.0.1:${port}/api/providers`);
    assert.equal(missingToken.status, 401);
    assert.equal((await missingToken.json()).code, "local_api_auth_required");

    const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      headers: {
        "X-AI-Council-Token": localApiToken,
        Origin: "https://untrusted.example"
      }
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).code, "local_api_untrusted_origin");

    const wrongContentType = await fetch(`http://127.0.0.1:${port}/api/providers`, {
      method: "POST",
      headers: {
        "X-AI-Council-Token": localApiToken,
        "Content-Type": "text/plain"
      },
      body: "{}"
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal((await wrongContentType.json()).code, "local_api_json_required");
  } finally {
    child.kill();
    await waitForExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output()}`);
    try {
      const response = await requestJson(port, "/api/health", undefined, "GET");
      if (response.status === 200) return;
    } catch {
      // The server has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output()}`);
}

async function requestJson(port, pathname, body, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? { "X-AI-Council-Token": localApiToken } : { "Content-Type": "application/json", "X-AI-Council-Token": localApiToken },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
