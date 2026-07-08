import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { executeFileTool, extractImportedProjectRoots } from "../src/fileTools.js";
import { executeToolRequests } from "../src/toolRequests.js";
import { writeContextArchive } from "../src/storage.js";

test("controlled file tool requests list, read, search, and grep real workspace files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-"));
  fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "shared", "logs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs", "notes.md"), "ALPHA_FACT: real file content\nsecond line", "utf8");

  const result = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 2,
    requests: [
      { tool: "list_directory", path: "docs", reason: "List docs" },
      { tool: "read_file", path: "docs/notes.md", reason: "Read notes" },
      { tool: "search_files", query: "notes", reason: "Find file names" },
      { tool: "grep_content", query: "ALPHA_FACT", reason: "Find content" }
    ]
  });

  assert.equal(result.accepted.length, 4);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.results.every((item) => item.status === "completed"), true);
  assert.equal(result.results.find((item) => item.tool === "read_file").result.content.includes("ALPHA_FACT"), true);
  assert.equal(result.results.find((item) => item.tool === "search_files").result.results[0].path, "docs/notes.md");
  assert.equal(result.results.find((item) => item.tool === "grep_content").result.results[0].line, 1);
  assert.equal(result.events.filter((event) => event.type === "tool_start").length, 4);
  assert.equal(result.events.filter((event) => event.type === "tool_success").length, 4);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "tools.jsonl")), true);
});

test("text-only seats cannot use controlled file tools", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-deny-"));
  fs.writeFileSync(path.join(tmp, "notes.md"), "content", "utf8");

  const result = await executeToolRequests({
    permissionTier: "text",
    groupPath: tmp,
    agent: { id: "text", name: "Text" },
    round: 1,
    requests: [{ tool: "read_file", path: "notes.md", reason: "Read notes" }]
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, "permission_denied");
  assert.equal(result.events[0].type, "tool_failure");
});

test("context search tool reads public archive snippets only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-tool-"));
  writeContextArchive({
    id: "session_context_tool_1",
    question: "Earlier context tool retrieval.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:00.000Z",
    status: "completed",
    messages: [
      {
        round: 1,
        agentId: "reader",
        agentName: "Reader",
        response: { status: "speak", argument: "CONTEXT_TOOL_PUBLIC_FACT is public archive content." }
      }
    ],
    finalDecision: { final_state: "ready_to_execute", answer: "Stored." }
  }, tmp);
  fs.mkdirSync(path.join(tmp, "members", "Reader", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "members", "Reader", "inbox", "private-chat.jsonl"), "CONTEXT_TOOL_PRIVATE_FACT", "utf8");

  const result = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [
      { tool: "search_context", query: "context tool", reason: "Find old public context." }
    ]
  });
  const payload = JSON.stringify(result.results[0].result);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].result.source, "local_context_archive");
  assert.match(payload, /CONTEXT_TOOL_PUBLIC_FACT/);
  assert.doesNotMatch(payload, /CONTEXT_TOOL_PRIVATE_FACT/);
  assert.equal(result.events.some((event) => event.type === "tool_success" && event.tool === "search_context"), true);
});

test("context load tool reads a public archived round", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-load-tool-"));
  writeContextArchive({
    id: "session_context_load_tool_1",
    question: "Earlier load context tool.",
    createdAt: "2026-07-08T10:00:00.000Z",
    completedAt: "2026-07-08T10:01:00.000Z",
    status: "completed",
    messages: [
      {
        round: 2,
        agentId: "reader",
        agentName: "Reader",
        response: { status: "speak", argument: "LOAD_TOOL_PUBLIC_FACT is public archive content." }
      }
    ],
    finalDecision: { final_state: "ready_to_execute", answer: "Stored." }
  }, tmp);

  const result = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [
      { tool: "load_context", sessionId: "session_context_load_tool_1", round: 2, reason: "Load the matching archived round." }
    ]
  });
  const payload = JSON.stringify(result.results[0].result);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].result.sourceType, "round_full");
  assert.match(payload, /LOAD_TOOL_PUBLIC_FACT/);
  assert.equal(result.events.some((event) => event.type === "tool_success" && event.tool === "load_context"), true);
});

test("extract_archive extracts safe zip files for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-extract-tool-"));
  fs.writeFileSync(path.join(tmp, "sample.zip"), makeZip([
    { name: "docs/readme.md", content: "ZIP_PUBLIC_FACT" },
    { name: "docs/nested/info.txt", content: "nested content" }
  ]));

  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "extract_archive", path: "sample.zip", destination: "unzipped", reason: "Extract docs." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "extract_archive", path: "sample.zip", destination: "unzipped", reason: "Extract docs." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.equal(allowed.results[0].result.extracted.length, 2);
  assert.equal(fs.readFileSync(path.join(tmp, "unzipped", "docs", "readme.md"), "utf8"), "ZIP_PUBLIC_FACT");
  assert.equal(allowed.events.some((event) => event.type === "tool_success" && event.tool === "extract_archive"), true);
});

test("extract_archive blocks zip slip entries", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-extract-slip-"));
  const outside = path.join(path.dirname(tmp), "escape.txt");
  fs.rmSync(outside, { force: true });
  fs.writeFileSync(path.join(tmp, "slip.zip"), makeZip([
    { name: "../escape.txt", content: "SHOULD_NOT_WRITE" },
    { name: "safe.txt", content: "SAFE_WRITE" }
  ]));

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "extract_archive", path: "slip.zip", destination: "out", reason: "Extract safely." }
    ]
  });

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].result.extracted.length, 1);
  assert.equal(result.results[0].result.skipped[0].reason, "unsafe_entry_path");
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readFileSync(path.join(tmp, "out", "safe.txt"), "utf8"), "SAFE_WRITE");
});

test("execute_command runs real shell commands for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-tool-"));
  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "execute_command", command: nodeCommand("console.log('COMMAND_DENIED')"), shell: shellForNodeCommand(), reason: "Run command." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command: nodeCommand("console.log('COMMAND_FACT')"), shell: shellForNodeCommand(), reason: "Run command." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.match(allowed.results[0].result.stdout, /COMMAND_FACT/);
  assert.equal(allowed.events.some((event) => event.type === "tool_success" && event.tool === "execute_command"), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "commands.jsonl")), true);
});

test("execute_command supports pipes redirection and background processes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-shell-"));
  const piped = process.platform === "win32"
    ? { shell: "cmd", command: "echo PIPE_FACT | findstr PIPE > piped.txt" }
    : { shell: "sh", command: "printf PIPE_FACT | cat > piped.txt" };

  const pipeResult = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", shell: piped.shell, command: piped.command, reason: "Use shell pipeline." }
    ]
  });
  const backgroundResult = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command: nodeCommand("setTimeout(()=>{}, 500)"), shell: shellForNodeCommand(), background: true, reason: "Start background process." }
    ]
  });

  assert.equal(pipeResult.results[0].status, "completed");
  assert.match(fs.readFileSync(path.join(tmp, "piped.txt"), "utf8"), /PIPE_FACT/);
  assert.equal(backgroundResult.results[0].status, "completed");
  assert.equal(backgroundResult.results[0].result.background, true);
  assert.ok(backgroundResult.results[0].result.pid > 0);
});

test("execute_command keeps cwd inside workspace and reports timeouts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-guard-"));
  const escaped = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command: nodeCommand("console.log('OUTSIDE')"), shell: shellForNodeCommand(), cwd: "..", reason: "Try outside cwd." }
    ]
  });
  const timedOut = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command: nodeCommand("setTimeout(()=>{}, 2000)"), shell: shellForNodeCommand(), timeoutMs: 50, reason: "Timeout command." }
    ]
  });

  assert.equal(escaped.accepted.length, 1);
  assert.equal(escaped.results[0].status, "failed");
  assert.equal(escaped.results[0].code, "path_escape_denied");
  assert.equal(timedOut.results[0].status, "failed");
  assert.equal(timedOut.results[0].code, "command_timeout");
  assert.equal(timedOut.results[0].result.timedOut, true);
});

test("run_code executes real snippets for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-run-code-"));
  const source = "const value = 20 + 22;\nconsole.log('RUN_CODE_FACT:' + value);";
  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "run_code", language: "javascript", code: source, reason: "Run snippet." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "run_code", language: "javascript", code: source, reason: "Run snippet." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.accepted[0].code.bytes, Buffer.byteLength(source, "utf8"));
  assert.equal(String(allowed.accepted[0].code.preview).includes("RUN_CODE_FACT"), true);
  assert.equal(String(allowed.accepted[0].code).includes("const value"), false);
  assert.equal(allowed.results[0].status, "completed");
  assert.equal(allowed.results[0].result.language, "javascript");
  assert.match(allowed.results[0].result.stdout, /RUN_CODE_FACT:42/);
  assert.equal(fs.existsSync(path.join(tmp, allowed.results[0].result.codePath)), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "code-runs.jsonl")), true);
});

test("run_code reports timeout and unsupported languages honestly", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-run-code-fail-"));
  const timedOut = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "run_code", language: "javascript", code: "setTimeout(()=>{}, 2000);", timeoutMs: 50, reason: "Timeout snippet." }
    ]
  });
  const unsupported = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "run_code", language: "brainfuck", code: "++++", reason: "Unsupported language." }
    ]
  });

  assert.equal(timedOut.results[0].status, "failed");
  assert.equal(timedOut.results[0].code, "command_timeout");
  assert.equal(timedOut.results[0].result.timedOut, true);
  assert.equal(unsupported.results[0].status, "failed");
  assert.equal(unsupported.results[0].code, "unsupported_language");
});

test("install_package installs a real local npm package into managed workspace environment", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-install-package-"));
  const pkg = path.join(tmp, "local-package");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
    name: "local-install-fact",
    version: "1.0.0",
    main: "index.js"
  }), "utf8");
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = 'LOCAL_INSTALL_FACT';\n", "utf8");

  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "install_package", manager: "npm", packageName: pkg, reason: "Install local package." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "install_package", manager: "npm", packageName: pkg, reason: "Install local package." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.equal(allowed.results[0].result.manager, "npm");
  assert.equal(allowed.results[0].result.environmentPath, "shared/environments/npm");
  assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "npm", "node_modules", "local-install-fact", "index.js")), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "packages.jsonl")), true);
});

test("install_package reports unsupported package managers honestly", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-install-package-fail-"));
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "install_package", manager: "brew", packageName: "wget", reason: "Unsupported manager." }
    ]
  });

  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].code, "unsupported_package_manager");
});

test("run_tests executes real test commands for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-run-tests-"));
  const command = nodeCommand("console.log('TEST_RUN_FACT'); process.exit(0)");
  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "run_tests", runner: "custom", command, reason: "Run test command." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "run_tests", runner: "custom", command, reason: "Run test command." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.equal(allowed.results[0].result.runner, "custom");
  assert.equal(allowed.results[0].result.passed, true);
  assert.match(allowed.results[0].result.stdout, /TEST_RUN_FACT/);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "tests.jsonl")), true);
});

test("run_tests reports failing custom commands honestly", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-run-tests-fail-"));
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "run_tests", runner: "custom", command: nodeCommand("console.error('TEST_FAIL_FACT'); process.exit(7)"), reason: "Run failing test." }
    ]
  });

  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].code, "command_exit_nonzero");
  assert.equal(result.results[0].result.passed, false);
  assert.equal(result.results[0].result.exitCode, 7);
  assert.match(result.results[0].result.stderr, /TEST_FAIL_FACT/);
});

test("controlled file tools reject path escape and secret files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-guard-"));
  fs.writeFileSync(path.join(tmp, "safe.md"), "safe", "utf8");
  fs.writeFileSync(path.join(tmp, ".env"), "API_KEY=secret", "utf8");

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "read_file", path: "../outside.txt", reason: "Try escape" },
      { tool: "read_file", path: ".env", reason: "Try secret" }
    ]
  });

  assert.equal(result.accepted.length, 2);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].code, "path_escape_denied");
  assert.equal(result.results[1].status, "failed");
  assert.equal(result.results[1].code, "forbidden_secret_file");
  assert.equal(result.events.filter((event) => event.type === "tool_failure").length, 2);
});

test("controlled file tools hide internal workspace data", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-internal-"));
  fs.mkdirSync(path.join(tmp, "members", "A", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "group.json"), JSON.stringify({ apiKey: "group-secret" }), "utf8");
  fs.writeFileSync(path.join(tmp, "members", "A", "inbox", "private-chat.jsonl"), "PRIVATE_CHAT_FACT", "utf8");
  fs.writeFileSync(path.join(tmp, "public.md"), "public", "utf8");

  const list = executeFileTool(
    { tool: "list_directory", path: ".", reason: "List public workspace" },
    { groupPath: tmp }
  );
  const readGroup = executeFileToolResult({
    tool: "read_file",
    path: "group.json",
    reason: "Read config"
  }, tmp);
  const readPrivate = executeFileToolResult({
    tool: "read_file",
    path: "members/A/inbox/private-chat.jsonl",
    reason: "Read private chat"
  }, tmp);

  assert.deepEqual(list.entries.map((entry) => entry.name), ["public.md"]);
  assert.equal(readGroup.code, "forbidden_internal_file");
  assert.equal(readPrivate.code, "forbidden_internal_path");
});

test("file tools can read explicitly imported project roots", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-workspace-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-tools-project-"));
  fs.writeFileSync(path.join(project, "README.md"), "IMPORTED_PROJECT_FACT", "utf8");
  const roots = extractImportedProjectRoots([
    {
      name: "project-directory-tree.txt",
      content: `Project import from: ${project}\nText files imported: 1`
    }
  ]);

  const result = executeFileTool(
    { tool: "read_file", path: "README.md", root: "project", reason: "Read imported project" },
    { groupPath: workspace, importedProjectRoots: roots }
  );

  assert.equal(result.path, "README.md");
  assert.equal(result.content.includes("IMPORTED_PROJECT_FACT"), true);
});

function executeFileToolResult(request, groupPath) {
  try {
    return executeFileTool(request, { groupPath });
  } catch (error) {
    return { code: error.code, error: error.message };
  }
}

function shellForNodeCommand() {
  return process.platform === "win32" ? "cmd" : "sh";
}

function nodeCommand(script) {
  const escapedScript = String(script).replace(/"/g, '\\"');
  return `"${process.execPath}" -e "${escapedScript}"`;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, eocd]);
}
