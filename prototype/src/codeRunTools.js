import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeId } from "./types.js";
import { executeCommandTool } from "./commandTools.js";

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_CODE_BYTES = 512 * 1024;

export async function runCodeTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const language = normalizeLanguage(request.language || request.lang);
  const code = requiredCode(request.code || request.content || request.source);
  const codeBuffer = Buffer.from(code, "utf8");
  if (codeBuffer.length > MAX_CODE_BYTES) {
    throw toolError("code_too_large", "Code is too large to run directly.");
  }

  const runId = safeRunId(request.runId || request.id || makeId("run"));
  const runDir = path.join(groupRoot, "shared", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const fileName = fileNameForLanguage(language);
  const filePath = path.join(runDir, fileName);
  fs.writeFileSync(filePath, code, "utf8");

  const command = commandForLanguage(language, fileName);
  const result = await executeCommandTool({
    tool: "execute_command",
    command,
    cwd: runDir,
    shell: shellForLanguage(language),
    timeoutMs: request.timeoutMs || options.codeRunTimeoutMs || DEFAULT_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes || options.maxCodeOutputBytes
  }, {
    ...options,
    groupPath: groupRoot,
    commandTimeoutMs: request.timeoutMs || options.codeRunTimeoutMs || DEFAULT_TIMEOUT_MS
  });

  return {
    ok: result.ok,
    source: "local_code_runner",
    language,
    runId,
    codePath: path.relative(groupRoot, filePath).replaceAll("\\", "/"),
    codeBytes: codeBuffer.length,
    codeSha256: crypto.createHash("sha256").update(codeBuffer).digest("hex"),
    command: result.command,
    shell: result.shell,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    verificationIntent: looksLikeVerificationCode(code),
    code: result.code,
    error: result.error
  };
}

function looksLikeVerificationCode(code) {
  return /\b(?:assert|expect|verify|verification|validate|validation|test|check|lint|smoke)\b/i.test(String(code || ""));
}

function commandForLanguage(language, fileName) {
  const quoted = quoteShell(fileName);
  if (language === "javascript") return `${quoteShell(process.execPath)} ${quoted}`;
  if (language === "python") return `python ${quoted}`;
  if (language === "powershell") return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quoted}`;
  if (language === "shell") return process.platform === "win32"
    ? `cmd.exe /d /c ${quoted}`
    : `sh ${quoted}`;
  throw toolError("unsupported_language", `Unsupported code language: ${language}`);
}

function shellForLanguage(language) {
  if (language === "powershell") return "powershell";
  if (language === "shell") return process.platform === "win32" ? "cmd" : "sh";
  return process.platform === "win32" ? "cmd" : "sh";
}

function fileNameForLanguage(language) {
  if (language === "javascript") return "main.js";
  if (language === "python") return "main.py";
  if (language === "powershell") return "main.ps1";
  if (language === "shell") return process.platform === "win32" ? "main.cmd" : "main.sh";
  throw toolError("unsupported_language", `Unsupported code language: ${language}`);
}

function normalizeLanguage(value) {
  const raw = String(value || "javascript").trim().toLowerCase();
  if (["js", "node", "nodejs", "javascript", "typescript", "ts"].includes(raw)) return "javascript";
  if (["py", "python", "python3"].includes(raw)) return "python";
  if (["ps", "ps1", "pwsh", "powershell"].includes(raw)) return "powershell";
  if (["shell", "sh", "bash", "cmd", "bat"].includes(raw)) return "shell";
  throw toolError("unsupported_language", `Unsupported code language: ${raw || "(empty)"}.`);
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "run_code requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function safeRunId(value) {
  const text = String(value || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return text || makeId("run");
}

function requiredCode(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw toolError("missing_code", "run_code requires code.");
  }
  return value;
}

function quoteShell(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
