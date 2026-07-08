import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteMcpServerConfig,
  listMcpServerConfigs,
  mcpServersPath,
  readMcpServerConfigs,
  upsertMcpServerConfig
} from "../src/mcpConfig.js";

test("MCP server configs persist locally and redact env values for clients", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-config-"));
  const saved = upsertMcpServerConfig(baseDir, {
    id: "filesystem",
    name: "Filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: {
      API_KEY: "secret-value",
      BAD_NAME: "kept",
      "bad-name": "dropped"
    }
  });
  const listed = listMcpServerConfigs(baseDir);
  const raw = readMcpServerConfigs(baseDir);

  assert.equal(saved.id, "filesystem");
  assert.equal(saved.status, "configured");
  assert.equal(saved.runtime, "not_started");
  assert.deepEqual(saved.env.API_KEY, { configured: true, redacted: true });
  assert.equal(JSON.stringify(saved).includes("secret-value"), false);
  assert.equal(listed[0].env.API_KEY.redacted, true);
  assert.equal(raw[0].env.API_KEY, "secret-value");
  assert.equal(raw[0].env["bad-name"], undefined);
  assert.equal(fs.existsSync(mcpServersPath(baseDir)), true);
});

test("MCP server configs can be disabled and deleted", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-delete-"));
  upsertMcpServerConfig(baseDir, {
    id: "disabled-server",
    name: "Disabled",
    enabled: false,
    command: "node",
    args: ["server.js"]
  });
  const listed = listMcpServerConfigs(baseDir);
  const deleted = deleteMcpServerConfig(baseDir, "disabled-server");

  assert.equal(listed[0].status, "disabled");
  assert.equal(deleted.deleted, true);
  assert.deepEqual(readMcpServerConfigs(baseDir), []);
});

test("MCP config rejects missing commands and non-stdio transports", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-mcp-invalid-"));

  assert.throws(() => upsertMcpServerConfig(baseDir, {
    id: "bad",
    name: "Bad"
  }), /command is required/);
  assert.throws(() => upsertMcpServerConfig(baseDir, {
    id: "bad-transport",
    name: "Bad Transport",
    command: "node",
    transport: "sse"
  }), /Only stdio/);
});
