import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias } from "./pathGuards.js";

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export async function gitOperationTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const action = normalizeAction(request.action || request.command || request.query);
  const cwd = resolveGitCwd(groupRoot, action === "clone" ? (request.cwd || ".") : (request.cwd || request.path || "."));
  const timeoutMs = clampNumber(request.timeoutMs || options.gitTimeoutMs || options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = clampNumber(request.maxOutputBytes || options.maxGitOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
  const startedAtMs = Date.now();

  if (!["init", "clone"].includes(action)) await assertGitRepository(cwd, { timeoutMs, maxOutputBytes, signal: options.signal });

  const context = {
    action,
    groupRoot,
    cwd,
    timeoutMs,
    maxOutputBytes,
    signal: options.signal,
    startedAtMs,
    steps: []
  };

  if (action === "status") return statusOperation(context);
  if (action === "init") return singleGitOperation(context, ["init"]);
  if (action === "clone") return cloneOperation(context, request);
  if (action === "branch") return singleGitOperation(context, ["branch", "--list"]);
  if (action === "create_branch") {
    const branch = requiredName(request.branch || request.name, "branch");
    return singleGitOperation(context, ["switch", "-c", branch], { branch });
  }
  if (action === "switch_branch") {
    const branch = requiredName(request.branch || request.name, "branch");
    return singleGitOperation(context, ["switch", branch], { branch });
  }
  if (action === "commit") return commitOperation(context, request);
  if (action === "pull") return pullOperation(context, request);
  if (action === "push") return pushOperation(context, request);

  throw toolError("unsupported_git_operation", `Unsupported git operation: ${action || "(empty)"}.`);
}

async function statusOperation(context) {
  const porcelain = await runGit(context, ["status", "--porcelain=v1", "--branch"]);
  if (!porcelain.ok) return gitResult(context, { ok: false, code: porcelain.code, error: porcelain.error });
  const branch = await runGit(context, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return gitResult(context, {
    ok: true,
    branch: branch.ok ? branch.stdout.trim() : parseStatusBranch(porcelain.stdout),
    dirty: parsePorcelain(porcelain.stdout),
    stdout: porcelain.stdout,
    stderr: porcelain.stderr
  });
}

async function singleGitOperation(context, args, extra = {}) {
  const step = await runGit(context, args);
  return gitResult(context, {
    ok: step.ok,
    code: step.code,
    error: step.error,
    stdout: step.stdout,
    stderr: step.stderr,
    ...extra
  });
}

async function cloneOperation(context, request) {
  const url = requiredText(request.url || request.repository || request.repo || request.remote, "url");
  if (/[\r\n]/.test(url)) throw toolError("invalid_url", "Git clone URL cannot contain line breaks.");
  const destination = optionalCloneDestination(request.destination || request.dest || request.path || request.name, context);
  const branch = optionalName(request.branch);
  const args = ["clone"];
  if (branch) args.push("--branch", branch);
  args.push(url);
  if (destination.absolute) {
    fs.mkdirSync(path.dirname(destination.absolute), { recursive: true });
    args.push(destination.absolute);
  }
  const step = await runGit(context, args);
  return gitResult(context, {
    ok: step.ok,
    code: step.code,
    error: step.error,
    remote: redactSecrets(url),
    branch,
    paths: destination.relative ? [destination.relative] : [],
    stdout: step.stdout,
    stderr: step.stderr
  });
}

async function commitOperation(context, request) {
  const message = requiredText(request.message || request.reason, "message");
  const paths = normalizePaths(request.paths || request.path, context);
  const addArgs = paths.length ? ["add", "--", ...paths] : ["add", "-A"];
  const add = await runGit(context, addArgs);
  if (!add.ok) return gitResult(context, { ok: false, code: add.code, error: add.error, stdout: add.stdout, stderr: add.stderr });

  const commit = await runGit(context, ["commit", "-m", message]);
  if (!commit.ok) return gitResult(context, { ok: false, code: commit.code, error: commit.error, stdout: commit.stdout, stderr: commit.stderr });

  const hash = await runGit(context, ["rev-parse", "--short", "HEAD"]);
  return gitResult(context, {
    ok: hash.ok,
    code: hash.code,
    error: hash.error,
    commitHash: hash.stdout.trim(),
    paths: paths.length ? paths : ["."],
    stdout: [add.stdout, commit.stdout, hash.stdout].filter(Boolean).join("\n"),
    stderr: [add.stderr, commit.stderr, hash.stderr].filter(Boolean).join("\n")
  });
}

async function pullOperation(context, request) {
  const remote = optionalName(request.remote) || "origin";
  const branch = optionalName(request.branch);
  const args = branch ? ["pull", remote, branch] : ["pull", remote];
  const step = await runGit(context, args);
  return gitResult(context, {
    ok: step.ok,
    code: step.code,
    error: step.error,
    remote,
    branch,
    stdout: step.stdout,
    stderr: step.stderr
  });
}

async function pushOperation(context, request) {
  if (request.force) throw toolError("unsupported_git_operation", "Force push is not supported by git_operation.");
  const remote = optionalName(request.remote) || "origin";
  const branch = optionalName(request.branch);
  const args = branch ? ["push", remote, branch] : ["push", remote];
  const step = await runGit(context, args);
  return gitResult(context, {
    ok: step.ok,
    code: step.code,
    error: step.error,
    remote,
    branch,
    stdout: step.stdout,
    stderr: step.stderr
  });
}

async function assertGitRepository(cwd, options) {
  const result = await spawnGit(cwd, ["rev-parse", "--is-inside-work-tree"], options);
  if (!result.ok || result.stdout.trim() !== "true") {
    throw toolError("not_git_repository", "git_operation requires a Git repository. Use action init first if this workspace should become one.");
  }
}

async function runGit(context, args) {
  const step = await spawnGit(context.cwd, args, {
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal
  });
  context.steps.push({
    args,
    exitCode: step.exitCode,
    timedOut: step.timedOut,
    durationMs: step.durationMs,
    stdout: step.stdout,
    stderr: step.stderr,
    stdoutTruncated: step.stdoutTruncated,
    stderrTruncated: step.stderrTruncated
  });
  return step;
}

function spawnGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const stdout = outputBuffer(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
    const stderr = outputBuffer(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const abort = () => {
      timedOut = true;
      killProcess(child);
    };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      resolve({
        ...payload,
        stdout: redactSecrets(stdout.text()),
        stderr: redactSecrets(stderr.text()),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAtMs
      });
    };

    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        code: "git_spawn_failed",
        error: error.message,
        exitCode: null,
        timedOut
      });
    });
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish({
          ok: false,
          code: "git_timeout",
          error: `Git operation exceeded ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms and was stopped.`,
          exitCode,
          signal,
          timedOut
        });
        return;
      }
      if (exitCode !== 0) {
        finish({
          ok: false,
          code: "git_exit_nonzero",
          error: `Git exited with code ${exitCode}.`,
          exitCode,
          signal,
          timedOut
        });
        return;
      }
      finish({
        ok: true,
        exitCode,
        signal,
        timedOut
      });
    });
  });
}

function gitResult(context, payload) {
  return {
    ok: Boolean(payload.ok),
    source: "local_git_tool",
    action: context.action,
    cwd: relativeCwd(context.groupRoot, context.cwd),
    branch: payload.branch || "",
    remote: payload.remote || "",
    commitHash: payload.commitHash || "",
    paths: payload.paths || [],
    dirty: payload.dirty || [],
    steps: context.steps.map((step) => ({
      ...step,
      stdout: redactSecrets(step.stdout),
      stderr: redactSecrets(step.stderr)
    })),
    stdout: redactSecrets(payload.stdout || ""),
    stderr: redactSecrets(payload.stderr || ""),
    durationMs: Date.now() - context.startedAtMs,
    code: payload.code,
    error: payload.error || ""
  };
}

function normalizeAction(value) {
  const raw = String(value || "status").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["status", "init", "clone", "branch", "commit", "pull", "push"].includes(raw)) return raw;
  if (["create_branch", "branch_create", "new_branch"].includes(raw)) return "create_branch";
  if (["switch_branch", "checkout", "checkout_branch"].includes(raw)) return "switch_branch";
  if (["force_push", "push_force", "reset", "reset_hard", "hard_reset", "rebase"].includes(raw)) {
    throw toolError("unsupported_git_operation", `${raw} is not supported by git_operation.`);
  }
  return raw;
}

function parsePorcelain(output) {
  return String(output || "")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("## "))
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim().replace(/^"|"$/g, "")
    }));
}

function parseStatusBranch(output) {
  const first = String(output || "").split(/\r?\n/).find((line) => line.startsWith("## "));
  if (!first) return "";
  const text = first.slice(3).trim();
  const unborn = text.match(/^No commits yet on (.+)$/);
  if (unborn) return unborn[1].trim();
  return text.split(/[.\s]/)[0] || "";
}

function normalizePaths(value, context) {
  if (Array.isArray(value)) return value.map((item) => normalizeGitPath(item, context)).filter(Boolean);
  const normalized = normalizeGitPath(value, context);
  return normalized ? [normalized] : [];
}

function normalizeGitPath(value, context) {
  const text = String(value || "").trim();
  if (!text) return "";
  const alias = normalizeWorkspacePathAlias(text);
  if (!alias.aliased) return text;
  const absolute = path.resolve(context.groupRoot, alias.path);
  if (!isInsidePath(context.groupRoot, absolute)) throw toolError("path_escape_denied", "Git path must stay inside the group workspace.");
  return path.relative(context.cwd, absolute).replaceAll("\\", "/") || ".";
}

function resolveGroupRoot(groupPath) {
  if (!groupPath) throw toolError("missing_workspace", "git_operation requires a group workspace.");
  if (!fs.existsSync(groupPath)) throw toolError("missing_workspace", "Group workspace does not exist.");
  const real = fs.realpathSync.native(groupPath);
  if (!fs.statSync(real).isDirectory()) throw toolError("missing_workspace", "Group workspace is not a directory.");
  return real;
}

function resolveGitCwd(groupRoot, input) {
  const literal = resolveExistingRelativeLiteral(groupRoot, input || ".");
  if (literal) return literal;
  const alias = normalizeWorkspacePathAlias(input || ".");
  const raw = alias.path || ".";
  const candidate = !alias.aliased && path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(groupRoot, raw);
  const real = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : candidate;
  if (!isInsidePath(groupRoot, real)) throw toolError("path_escape_denied", "Git cwd must stay inside the group workspace.");
  if (!fs.existsSync(real)) throw toolError("cwd_not_found", "Git cwd does not exist.");
  if (!fs.statSync(real).isDirectory()) throw toolError("cwd_not_directory", "Git cwd is not a directory.");
  return real;
}

function resolveExistingRelativeLiteral(groupRoot, input) {
  const raw = String(input || ".").trim();
  if (!raw || path.isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\")) return "";
  const candidate = path.resolve(groupRoot, raw);
  if (!fs.existsSync(candidate)) return "";
  const real = fs.realpathSync.native(candidate);
  if (!isInsidePath(groupRoot, real)) throw toolError("path_escape_denied", "Git cwd must stay inside the group workspace.");
  if (!fs.statSync(real).isDirectory()) throw toolError("cwd_not_directory", "Git cwd is not a directory.");
  return real;
}

function optionalCloneDestination(value, context) {
  const raw = String(value || "").trim();
  if (!raw) return { absolute: "", relative: "" };
  if (/[\r\n]/.test(raw)) throw toolError("invalid_destination", "Git clone destination cannot contain line breaks.");
  const alias = (path.isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\"))
    ? normalizeWorkspacePathAlias(raw)
    : { path: raw, aliased: false };
  const absolute = !alias.aliased && path.isAbsolute(alias.path)
    ? path.resolve(alias.path)
    : path.resolve(context.groupRoot, alias.path);
  if (!isInsidePath(context.groupRoot, absolute)) {
    throw toolError("path_escape_denied", "Git clone destination must stay inside the group workspace.");
  }
  return {
    absolute,
    relative: path.relative(context.groupRoot, absolute).replaceAll("\\", "/") || "."
  };
}

function killProcess(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    child.kill("SIGTERM");
  } catch {}
}

function outputBuffer(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    add(chunk) {
      if (!maxBytes) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      const current = chunks.reduce((sum, item) => sum + item.length, 0);
      const remaining = maxBytes - current;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(buffer.length > remaining ? buffer.subarray(0, remaining) : buffer);
      if (buffer.length > remaining || bytes > maxBytes) truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError(`missing_${name}`, `Missing ${name}.`);
  return text;
}

function requiredName(value, name) {
  const text = requiredText(value, name);
  if (/[\r\n]/.test(text)) throw toolError(`invalid_${name}`, `${name} cannot contain line breaks.`);
  return text;
}

function optionalName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[\r\n]/.test(text)) throw toolError("invalid_git_name", "Git names cannot contain line breaks.");
  return text;
}

function relativeCwd(groupRoot, cwd) {
  const relative = path.relative(groupRoot, cwd).replaceAll("\\", "/");
  return relative || ".";
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(password\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^/:]+:)[^@/\s]+(@)/gi, "$1[redacted]$2");
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
