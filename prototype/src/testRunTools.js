import { executeCommandTool } from "./commandTools.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runTestsTool(request, options = {}) {
  const runner = normalizeRunner(request.runner || request.framework || request.manager || request.type);
  const command = testCommand(runner, request.command);
  const result = await executeCommandTool({
    tool: "execute_command",
    command,
    cwd: request.cwd || request.path || ".",
    shell: process.platform === "win32" ? "cmd" : "sh",
    timeoutMs: request.timeoutMs || options.testTimeoutMs || DEFAULT_TIMEOUT_MS,
    maxOutputBytes: request.maxOutputBytes || options.maxTestOutputBytes
  }, {
    ...options,
    commandTimeoutMs: request.timeoutMs || options.testTimeoutMs || DEFAULT_TIMEOUT_MS
  });

  return {
    ok: result.ok,
    source: "local_test_runner",
    runner,
    command: result.command,
    cwd: result.cwd,
    shell: result.shell,
    passed: Boolean(result.ok),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code: result.code,
    error: result.error
  };
}

function testCommand(runner, customCommand) {
  if (runner === "custom") {
    const command = String(customCommand || "").trim();
    if (!command) throw toolError("missing_command", "run_tests custom runner requires command.");
    return command;
  }
  if (runner === "npm") return "npm test";
  if (runner === "pytest") return process.platform === "win32" ? "python -m pytest" : "python3 -m pytest";
  if (runner === "cargo") return "cargo test";
  throw toolError("unsupported_test_runner", `Unsupported test runner: ${runner}`);
}

function normalizeRunner(value) {
  const raw = String(value || "npm").trim().toLowerCase();
  if (["npm", "node", "nodejs", "javascript"].includes(raw)) return "npm";
  if (["pytest", "python", "python3", "py"].includes(raw)) return "pytest";
  if (["cargo", "rust"].includes(raw)) return "cargo";
  if (["custom", "shell", "command"].includes(raw)) return "custom";
  throw toolError("unsupported_test_runner", `Unsupported test runner: ${raw || "(empty)"}.`);
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
