import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";

const DEFAULT_MAX_ROWS = 100;
const MAX_ROWS = 1000;

export async function databaseQueryTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const dbPath = resolveDatabasePath(groupRoot, request.databasePath || request.path);
  const sql = requiredText(request.sql || request.query || request.command, "sql");
  const params = normalizeParams(request.params);
  const mode = normalizeMode(request.mode || request.action, sql);
  const writeMode = mode === "execute" || !isReadOnlySql(sql);
  const maxRows = clampNumber(request.maxRows || options.maxDatabaseRows, DEFAULT_MAX_ROWS, 1, MAX_ROWS);

  if (writeMode && options.permissionTier !== "full") {
    throw toolError("permission_denied", "database_query write operations require full permission.");
  }
  if (!fs.existsSync(dbPath)) {
    if (!request.create || options.permissionTier !== "full") {
      throw toolError("database_not_found", "Database file does not exist.");
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return databaseQueryWithPython({ dbPath, sql, params, writeMode, maxRows, groupRoot });
  }
  const { DatabaseSync } = sqlite;

  const startedAtMs = Date.now();
  const db = new DatabaseSync(dbPath, { readOnly: !writeMode });
  try {
    if (!writeMode) {
      const statement = db.prepare(sql);
      const rows = statement.all(...params).slice(0, maxRows).map(jsonSafe);
      return {
        ok: true,
        source: "local_sqlite_database",
        engine: "sqlite",
        mode: "query",
        databasePath: relativePath(groupRoot, dbPath),
        readOnly: true,
        rowCount: rows.length,
        truncated: rows.length === maxRows,
        rows,
        durationMs: Date.now() - startedAtMs
      };
    }

    const result = executeWrite(db, sql, params);
    return {
      ok: true,
      source: "local_sqlite_database",
      engine: "sqlite",
      mode: "execute",
      databasePath: relativePath(groupRoot, dbPath),
      readOnly: false,
      changes: result.changes || 0,
      lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
      durationMs: Date.now() - startedAtMs
    };
  } finally {
    db.close();
  }
}

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

async function databaseQueryWithPython({ dbPath, sql, params, writeMode, maxRows, groupRoot }) {
  const payload = { path: dbPath, sql, params, mode: writeMode ? "execute" : "query", maxRows };
  const result = await runPythonSqlite(payload);
  if (!result.ok) throw toolError(result.code || "sqlite_unavailable", result.error || "SQLite fallback failed.");
  return {
    ok: true,
    source: "local_sqlite_database_python",
    engine: "sqlite",
    mode: writeMode ? "execute" : "query",
    databasePath: relativePath(groupRoot, dbPath),
    readOnly: !writeMode,
    ...(writeMode
      ? { changes: Number(result.value.changes || 0), lastInsertRowid: result.value.lastInsertRowid ?? undefined }
      : { rowCount: result.value.rows.length, truncated: Boolean(result.value.truncated), rows: result.value.rows })
  };
}

function runPythonSqlite(payload) {
  const script = [
    "import json, sqlite3, sys",
    "p = json.load(sys.stdin)",
    "db = sqlite3.connect(p['path'])",
    "db.row_factory = sqlite3.Row",
    "try:",
    "  if p['mode'] == 'query':",
    "    cur = db.execute(p['sql'], p.get('params', []))",
    "    rows = [dict(row) for row in cur.fetchmany(p['maxRows'] + 1)]",
    "    print(json.dumps({'rows': rows[:p['maxRows']], 'truncated': len(rows) > p['maxRows']}))",
    "  else:",
    "    if p.get('params'):",
    "      cur = db.execute(p['sql'], p['params'])",
    "    else:",
    "      cur = db.executescript(p['sql'])",
    "    db.commit()",
    "    print(json.dumps({'changes': db.total_changes, 'lastInsertRowid': getattr(cur, 'lastrowid', None)}))",
    "finally:",
    "  db.close()"
  ].join("\n");
  return runPythonCandidates(["python3", "python"], script, payload);
}

function runPythonCandidates(commands, script, payload) {
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= commands.length) {
        resolve({ ok: false, code: "sqlite_unavailable", error: "Neither node:sqlite nor Python sqlite3 is available." });
        return;
      }
      const child = spawn(commands[index], ["-c", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const stdout = [];
      const stderr = [];
      let handedOff = false;
      const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        if (error.code === "ENOENT") {
          handedOff = true;
          tryNext(index + 1);
        }
        else resolve({ ok: false, code: "sqlite_fallback_failed", error: error.message });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (handedOff) return;
        if (exitCode !== 0) {
          resolve({ ok: false, code: "sqlite_query_failed", error: Buffer.concat(stderr).toString("utf8").trim() || `Python sqlite exited with ${exitCode}.` });
          return;
        }
        try {
          resolve({ ok: true, value: JSON.parse(Buffer.concat(stdout).toString("utf8")) });
        } catch (error) {
          resolve({ ok: false, code: "sqlite_invalid_output", error: error.message });
        }
      });
      child.stdin.end(JSON.stringify(payload));
    };
    tryNext(0);
  });
}

function executeWrite(db, sql, params) {
  if (params.length) {
    return jsonSafe(db.prepare(sql).run(...params));
  }
  db.exec(sql);
  return { changes: 0 };
}

function isReadOnlySql(sql) {
  const stripped = stripLeadingComments(sql).trim();
  if (!/^(select|with)\b/i.test(stripped)) return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex)\b/i.test(stripped);
}

function stripLeadingComments(sql) {
  return String(sql || "")
    .replace(/^\s*--.*(?:\r?\n|$)/gm, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//, "");
}

function normalizeMode(value, sql) {
  const raw = String(value || "").trim().toLowerCase();
  if (["query", "select", "read"].includes(raw)) return "query";
  if (["execute", "exec", "write", "run"].includes(raw)) return "execute";
  return isReadOnlySql(sql) ? "query" : "execute";
}

function normalizeParams(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item === null) return null;
    if (["string", "number", "boolean"].includes(typeof item)) return item;
    return String(item);
  });
}

function resolveDatabasePath(groupRoot, input) {
  const alias = normalizeWorkspacePathAlias(requiredText(input, "path"));
  const raw = alias.path;
  const candidate = !alias.aliased && path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(groupRoot, raw);
  const parent = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : path.dirname(candidate);
  const realParent = fs.existsSync(parent) ? fs.realpathSync.native(parent) : parent;
  const resolved = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : path.join(realParent, path.basename(candidate));
  if (!isInsidePath(groupRoot, resolved)) throw toolError("path_escape_denied", "Database path must stay inside the group workspace.");
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) throw toolError("database_not_file", "Database path is not a file.");
  return resolved;
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "database_query requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function jsonSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError(`missing_${name}`, `Missing ${name}.`);
  return text;
}

function relativePath(groupRoot, filePath) {
  return path.relative(groupRoot, filePath).replaceAll("\\", "/");
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
