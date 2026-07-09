import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./appSettings.js";

export function readMcpServerConfigs(baseDir) {
  const filePath = mcpServersPath(baseDir);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeServers(Array.isArray(parsed?.servers) ? parsed.servers : []);
}

export function listMcpServerConfigs(baseDir) {
  return readMcpServerConfigs(baseDir).map(redactServer);
}

export function upsertMcpServerConfig(baseDir, input = {}) {
  const servers = readMcpServerConfigs(baseDir);
  const next = normalizeServer(input, { createId: true });
  const index = servers.findIndex((item) => item.id === next.id);
  if (index >= 0) servers[index] = { ...servers[index], ...next };
  else servers.push(next);
  writeServers(baseDir, servers);
  return redactServer(next);
}

export function deleteMcpServerConfig(baseDir, id) {
  const target = String(id || "").trim();
  if (!target) throw new Error("Missing MCP server id.");
  const servers = readMcpServerConfigs(baseDir);
  const next = servers.filter((item) => item.id !== target);
  writeServers(baseDir, next);
  return {
    ok: true,
    deleted: next.length !== servers.length,
    id: target
  };
}

export function mcpServersPath(baseDir) {
  return path.join(userDataDir(baseDir), "mcp-servers.json");
}

function writeServers(baseDir, servers) {
  const filePath = mcpServersPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, servers: normalizeServers(servers) }, null, 2), "utf8");
}

function normalizeServers(value) {
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => normalizeServer(item, { createId: false }));
}

function normalizeServer(value, options = {}) {
  const id = normalizeId(value.id) || (options.createId ? `mcp_${crypto.randomUUID()}` : "");
  const name = String(value.name || value.label || id || "").trim();
  const command = String(value.command || "").trim();
  if (!id) throw new Error("MCP server id is required.");
  if (!name) throw new Error("MCP server name is required.");
  if (!command) throw new Error("MCP server command is required.");
  return {
    id,
    name,
    enabled: value.enabled !== false,
    transport: normalizeTransport(value.transport),
    command,
    args: normalizeStringArray(value.args),
    cwd: String(value.cwd || "").trim(),
    env: normalizeEnv(value.env),
    source: normalizeSource(value.source),
    install: normalizeInstall(value.install)
  };
}

function redactServer(server) {
  const env = {};
  for (const [key, value] of Object.entries(server.env || {})) {
    env[key] = {
      configured: Boolean(String(value || "").trim()),
      redacted: Boolean(String(value || "").trim())
    };
  }
  return {
    ...server,
    env,
    status: server.enabled ? "configured" : "disabled",
    runtime: "not_started",
    install: server.install
  };
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .slice(0, 120);
}

function normalizeTransport(value) {
  const text = String(value || "stdio").trim().toLowerCase();
  if (text !== "stdio") throw new Error("Only stdio MCP servers are supported in this config slice.");
  return "stdio";
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 40);
}

function normalizeEnv(value = {}) {
  const output = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    output[name] = String(raw || "");
  }
  return output;
}

function normalizeSource(value) {
  const text = String(value || "local_config").trim();
  if (["local_config", "managed_npm", "built_in"].includes(text)) return text;
  return "local_config";
}

function normalizeInstall(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const manager = String(value.manager || "").trim();
  if (manager !== "npm") return undefined;
  return {
    manager,
    packageSpec: String(value.packageSpec || "").trim(),
    packageName: String(value.packageName || "").trim(),
    packageVersion: String(value.packageVersion || "").trim(),
    binName: String(value.binName || "").trim(),
    installDir: String(value.installDir || "").trim(),
    installedAt: String(value.installedAt || "").trim()
  };
}
