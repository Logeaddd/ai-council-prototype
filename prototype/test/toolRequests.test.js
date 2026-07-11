import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { executeFileTool, extractImportedProjectRoots } from "../src/fileTools.js";
import { executeToolRequests } from "../src/toolRequests.js";
import { writeContextArchive, writeGroupSession } from "../src/storage.js";

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

test("controlled file tools can read common build configuration files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-build-files-"));
  fs.writeFileSync(path.join(tmp, "build.gradle"), "plugins { id 'fabric-loom' }\n", "utf8");
  fs.writeFileSync(path.join(tmp, "settings.gradle.kts"), "pluginManagement { repositories { gradlePluginPortal() } }\n", "utf8");

  const result = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [
      { tool: "read_file", path: "build.gradle", reason: "Read Gradle build file" },
      { tool: "read_file", path: "settings.gradle.kts", reason: "Read Kotlin Gradle settings" }
    ]
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.results.every((item) => item.status === "completed"), true);
  assert.match(result.results[0].result.content, /fabric-loom/);
  assert.match(result.results[1].result.content, /pluginManagement/);
});

test("workspace path aliases work across local agent tools", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-alias-"));
  fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "docs", "notes.md"), "WORKSPACE_ALIAS_FACT\n", "utf8");
  fs.writeFileSync(path.join(tmp, "sample.zip"), makeZip([
    { name: "unzipped.txt", content: "ALIAS_ZIP_FACT" }
  ]));
  initGitRepo(tmp);

  const localPackage = path.join(tmp, "local-package");
  fs.mkdirSync(localPackage, { recursive: true });
  fs.writeFileSync(path.join(localPackage, "package.json"), JSON.stringify({
    name: "workspace-alias-local-package",
    version: "1.0.0"
  }), "utf8");
  fs.writeFileSync(path.join(localPackage, "index.js"), "module.exports = true;\n", "utf8");

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "list_directory", path: "/workspace", reason: "List workspace root." },
      { tool: "read_file", path: "/workspace/docs/notes.md", reason: "Read aliased file." },
      { tool: "execute_command", cwd: "/workspace", command: nodeCommand("console.log('ALIAS_COMMAND_FACT')"), shell: shellForNodeCommand(), reason: "Run command in aliased cwd." },
      { tool: "execute_command", cwd: "/root/workspace", command: nodeCommand("console.log('ROOT_WORKSPACE_ALIAS_FACT')"), shell: shellForNodeCommand(), reason: "Run command in common agent workspace alias." },
      { tool: "run_tests", cwd: "workspace", runner: "custom", command: nodeCommand("console.log('ALIAS_TEST_FACT')"), reason: "Run tests in aliased cwd." },
      { tool: "extract_archive", path: "/workspace/sample.zip", destination: "/workspace/out", reason: "Extract aliased archive." },
      { tool: "database_query", path: "/workspace/data/app.sqlite", create: true, mode: "execute", sql: "CREATE TABLE facts(body TEXT); INSERT INTO facts(body) VALUES ('ALIAS_DB_FACT');", reason: "Create aliased database." },
      { tool: "install_package", manager: "npm", packageName: "/workspace/local-package", reason: "Install aliased local package." },
      { tool: "git_operation", cwd: "/workspace", action: "status", reason: "Check git status from aliased cwd." }
    ]
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.results.every((item) => item.status === "completed"), true);
  assert.equal(result.results[0].result.path, ".");
  assert.match(result.results[1].result.content, /WORKSPACE_ALIAS_FACT/);
  assert.match(result.results[2].result.stdout, /ALIAS_COMMAND_FACT/);
  assert.match(result.results[3].result.stdout, /ROOT_WORKSPACE_ALIAS_FACT/);
  assert.match(result.results[4].result.stdout, /ALIAS_TEST_FACT/);
  assert.equal(fs.readFileSync(path.join(tmp, "out", "unzipped.txt"), "utf8"), "ALIAS_ZIP_FACT");
  assert.equal(fs.existsSync(path.join(tmp, "data", "app.sqlite")), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "npm", "node_modules", "workspace-alias-local-package", "package.json")), true);
  assert.equal(result.results[8].result.cwd, ".");
});

test("workspace path aliases cannot escape the workspace", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-alias-guard-"));
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "list_directory", path: "/workspace/../outside", reason: "Try file escape." },
      { tool: "execute_command", cwd: "/workspace/../outside", command: nodeCommand("console.log('OUTSIDE')"), shell: shellForNodeCommand(), reason: "Try command escape." },
      { tool: "database_query", path: "/workspace/../outside.sqlite", create: true, mode: "execute", sql: "CREATE TABLE x(v TEXT);", reason: "Try db escape." },
      { tool: "extract_archive", path: "/workspace/../outside.zip", destination: "/workspace/out", reason: "Try archive escape." }
    ]
  });

  assert.equal(result.accepted.length, 4);
  assert.deepEqual(result.results.map((item) => item.status), ["failed", "failed", "failed", "failed"]);
  assert.equal(result.results.every((item) => item.code === "path_escape_denied"), true);
});

test("existing relative workspace directories are not mistaken for workspace aliases", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-literal-"));
  const projectDir = path.join(tmp, "workspace", "random-surface-mod");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "notes.md"), "LITERAL_WORKSPACE_DIR_FACT\n", "utf8");

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "read_file", path: "workspace/random-surface-mod/notes.md", reason: "Read real nested workspace directory." },
      { tool: "execute_command", cwd: "workspace/random-surface-mod", command: nodeCommand("require('fs').writeFileSync('cwd-fact.txt','REAL_CWD_FACT')"), shell: shellForNodeCommand(), reason: "Run in real nested workspace directory." }
    ]
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.results.every((item) => item.status === "completed"), true);
  assert.match(result.results[0].result.content, /LITERAL_WORKSPACE_DIR_FACT/);
  assert.equal(fs.readFileSync(path.join(projectDir, "cwd-fact.txt"), "utf8"), "REAL_CWD_FACT");
  assert.equal(result.results[1].result.cwd, "workspace/random-surface-mod");
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

test("context tools search and load earlier rounds from the active session", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-live-context-tool-"));
  const currentSession = {
    id: "session_live_context_tool_1",
    question: "Current council task.",
    status: "running",
    messages: [{ round: 1, agentId: "builder", agentName: "Builder", response: { status: "speak", argument: "LIVE_CONTEXT_TOOL_FACT from an earlier round." } }],
    toolExecutionResults: [],
    fileOperationExecutionResults: [],
    fileOperationProposals: []
  };

  const searched = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    currentSession,
    transcriptVisibility: "full",
    agent: { id: "reader", name: "Reader" },
    round: 3,
    requests: [{ tool: "search_context", query: "live context", reason: "Find an earlier current-session round." }]
  });
  const loaded = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    currentSession,
    transcriptVisibility: "full",
    agent: { id: "reader", name: "Reader" },
    round: 3,
    requests: [{ tool: "load_context", sessionId: currentSession.id, round: 1, reason: "Load the earlier current-session round." }]
  });

  assert.match(JSON.stringify(searched.results[0].result), /LIVE_CONTEXT_TOOL_FACT/);
  assert.equal(loaded.results[0].result.source, "live_session_context");
  assert.match(JSON.stringify(loaded.results[0].result), /LIVE_CONTEXT_TOOL_FACT/);
});

test("text-only members can retrieve public group history but still cannot read workspace files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-text-history-tool-"));
  fs.writeFileSync(path.join(tmp, "private.txt"), "FILE_MUST_STAY_DENIED", "utf8");
  writeGroupSession({
    id: "session_text_history_1",
    question: "Prior public task",
    status: "running",
    createdAt: "2026-07-11T12:00:00.000Z",
    messages: [{ round: 1, agentId: "builder", agentName: "Builder", response: { status: "speak", argument: "TEXT_MEMBER_HISTORY_FACT" } }],
    toolExecutionResults: [],
    fileOperationExecutionResults: [],
    fileOperationProposals: []
  }, tmp);

  const result = await executeToolRequests({
    permissionTier: "text",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 2,
    requests: [
      { tool: "search_context", query: "TEXT_MEMBER_HISTORY_FACT", reason: "Find prior public discussion." },
      { tool: "load_context", sessionId: "session_text_history_1", round: 1, reason: "Load the exact public round." },
      { tool: "read_file", path: "private.txt", reason: "This must remain denied." }
    ]
  });

  assert.deepEqual(result.accepted.map((item) => item.tool), ["search_context", "load_context"]);
  assert.equal(result.results.length, 2);
  assert.match(JSON.stringify(result.results), /TEXT_MEMBER_HISTORY_FACT/);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].tool, "read_file");
  assert.equal(result.rejected[0].code, "permission_denied");
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
  assert.equal(pipeResult.results[0].result.workspaceChanges.created.some((item) => item.path === "piped.txt"), true);
  assert.equal(pipeResult.results[0].result.workspaceChanges.complete, true);
  assert.equal(backgroundResult.results[0].status, "completed");
  assert.equal(backgroundResult.results[0].result.background, true);
  assert.match(backgroundResult.results[0].result.processId, /^proc_/);
  assert.ok(backgroundResult.results[0].result.pid > 0);
  assert.equal(backgroundResult.results[0].result.workspaceChanges.status, "not_observed_background");
  assert.equal(backgroundResult.results[0].result.workspaceChanges.complete, false);
});

test("background process output status list and stop remain available across tool calls", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-control-"));
  const secretSuffix = ["background", "secret", "value"].join("-");
  const secret = `sk-${secretSuffix}`;
  const script = [
    `console.log(${JSON.stringify(`FIRST ${secret}`)})`,
    `console.error(${JSON.stringify("ERR_FACT")})`,
    `setTimeout(()=>console.log(${JSON.stringify("SECOND_FACT")}), 180)`,
    "setInterval(()=>{},1000)"
  ].join(";");
  const started = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{
      tool: "execute_command",
      command: nodeCommand(script),
      shell: shellForNodeCommand(),
      background: true,
      maxOutputBytes: 8192,
      reason: "Start a managed background process."
    }]
  });
  const processId = started.results[0].result.processId;
  assert.match(processId, /^proc_/);

  await waitFor(async () => {
    const output = await processTool(tmp, { action: "output", processId, stream: "stdout", maxBytes: 4096 });
    return output.results[0]?.result?.output?.includes("SECOND_FACT");
  }, 5000);

  const listed = await processTool(tmp, { action: "list", count: 10 });
  const status = await processTool(tmp, { action: "status", processId });
  const stdout = await processTool(tmp, { action: "output", processId, stream: "stdout", offset: 0, maxBytes: 4096 });
  const stderr = await processTool(tmp, { action: "output", processId, stream: "stderr", offset: 0, maxBytes: 4096 });

  assert.equal(listed.results[0].result.processes.some((item) => item.processId === processId), true);
  assert.equal(status.results[0].result.process.status, "running");
  assert.match(stdout.results[0].result.output, /FIRST sk-\[redacted\]/);
  assert.equal(stdout.results[0].result.output.includes(secretSuffix), false);
  assert.match(stdout.results[0].result.output, /SECOND_FACT/);
  assert.equal(stdout.results[0].result.nextOffset, stdout.results[0].result.totalBytes);
  assert.match(stderr.results[0].result.output, /ERR_FACT/);
  const rawStdout = fs.readFileSync(path.join(tmp, "shared", "logs", "processes", processId, "stdout.log"), "utf8");
  assert.match(rawStdout, /sk-\[redacted\]/);
  assert.equal(rawStdout.includes(secretSuffix), false);

  const stopped = await processTool(tmp, { action: "stop", processId, timeoutMs: 10000 });
  assert.equal(stopped.results[0].status, "completed");
  assert.equal(stopped.results[0].result.process.status, "stopped");

  const persisted = await processTool(tmp, { action: "status", processId });
  assert.equal(persisted.results[0].result.process.status, "stopped");
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "processes.jsonl")), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "processes", processId, "state.json")), true);
});

test("process control requires full permission and rejects unknown ids", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-permission-"));
  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [{ tool: "process_control", action: "list", reason: "List processes." }]
  });
  const missing = await processTool(tmp, { action: "status", processId: "proc_missing" });

  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(missing.results[0].status, "failed");
  assert.equal(missing.results[0].code, "process_not_found");
});

test("background process records natural exit and bounded paged output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-exit-"));
  const script = [
    "console.log('A'.repeat(3000))",
    "setTimeout(()=>{console.log('EXIT_FACT');process.exit(0)},120)"
  ].join(";");
  const started = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{
      tool: "execute_command",
      command: nodeCommand(script),
      shell: shellForNodeCommand(),
      background: true,
      maxOutputBytes: 2048,
      reason: "Run a bounded background command."
    }]
  });
  const processId = started.results[0].result.processId;

  const finalStatus = await waitForResult(async () => {
    const result = await processTool(tmp, { action: "status", processId });
    return result.results[0]?.result?.process?.status === "exited" ? result : undefined;
  }, 5000);
  const firstPage = await processTool(tmp, { action: "output", processId, stream: "stdout", offset: 0, maxBytes: 1024 });
  const secondPage = await processTool(tmp, {
    action: "output",
    processId,
    stream: "stdout",
    offset: firstPage.results[0].result.nextOffset,
    maxBytes: 1024
  });

  assert.equal(finalStatus.results[0].result.process.exitCode, 0);
  assert.equal(finalStatus.results[0].result.process.stdoutTruncated, true);
  assert.equal(firstPage.results[0].result.bytesRead, 1024);
  assert.equal(firstPage.results[0].result.truncated, true);
  assert.equal(secondPage.results[0].result.nextOffset, 2048);
  assert.equal(secondPage.results[0].result.eof, true);
  assert.equal(secondPage.results[0].result.logTruncated, true);
  assert.equal(firstPage.results[0].result.output.length + secondPage.results[0].result.output.length, 2048);
});

test("stale persisted process state becomes unknown instead of pretending to run", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-stale-"));
  const processId = "proc_stale_state";
  const processDir = path.join(tmp, "shared", "logs", "processes", processId);
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "state.json"), JSON.stringify({
    processId,
    source: "managed_background_process",
    status: "running",
    command: "old-command",
    supervisorPid: 2147483647,
    pid: 2147483646,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString()
  }), "utf8");

  const result = await processTool(tmp, { action: "status", processId });

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].result.process.status, "unknown");
  assert.equal(result.results[0].result.process.code, "process_state_unknown");
});

test("process logs are internal and unavailable through ordinary file tools", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-private-log-"));
  const processId = "proc_private_log";
  const processDir = path.join(tmp, "shared", "logs", "processes", processId);
  fs.mkdirSync(processDir, { recursive: true });
  fs.writeFileSync(path.join(processDir, "state.json"), "{}", "utf8");
  fs.writeFileSync(path.join(processDir, "stdout.log"), "PRIVATE_PROCESS_FACT", "utf8");

  const result = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "reader", name: "Reader" },
    round: 1,
    requests: [{ tool: "read_file", path: `shared/logs/processes/${processId}/stdout.log`, reason: "Try direct log read." }]
  });

  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].code, "forbidden_internal_path");
});

test("long background output without newlines becomes observable before exit", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-streaming-"));
  const script = "process.stdout.write('STREAM_FACT'+'.'.repeat(900));setInterval(()=>{},1000)";
  const started = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "execute_command", command: nodeCommand(script), shell: shellForNodeCommand(), background: true, reason: "Stream output without newlines." }]
  });
  const processId = started.results[0].result.processId;

  try {
    const output = await waitForResult(async () => {
      const result = await processTool(tmp, { action: "output", processId, stream: "stdout", maxBytes: 4096 });
      return result.results[0]?.result?.output?.includes("STREAM_FACT") ? result : undefined;
    }, 5000);
    assert.match(output.results[0].result.output, /STREAM_FACT/);
    assert.ok(output.results[0].result.bytesRead > 300);
  } finally {
    await processTool(tmp, { action: "stop", processId, timeoutMs: 10000 });
  }
});

test("background process records nonzero exit as failed", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-process-failed-"));
  const started = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{
      tool: "execute_command",
      command: nodeCommand("console.error('FAILED_FACT');process.exit(7)"),
      shell: shellForNodeCommand(),
      background: true,
      reason: "Run a failing background command."
    }]
  });
  const processId = started.results[0].result.processId;
  const finalStatus = await waitForResult(async () => {
    const result = await processTool(tmp, { action: "status", processId });
    return result.results[0]?.result?.process?.status === "failed" ? result : undefined;
  }, 5000);
  const stderr = await processTool(tmp, { action: "output", processId, stream: "stderr", maxBytes: 4096 });

  assert.equal(finalStatus.results[0].result.process.exitCode, 7);
  assert.equal(finalStatus.results[0].result.process.code, "command_exit_nonzero");
  assert.match(stderr.results[0].result.output, /FAILED_FACT/);
  assert.equal(stderr.results[0].result.eof, true);
});

test("execute_command reports real net file changes without runtime or secret noise", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-changes-"));
  fs.writeFileSync(path.join(tmp, "modify.txt"), "OLD", "utf8");
  fs.writeFileSync(path.join(tmp, "delete.txt"), "DELETE", "utf8");
  const script = [
    "const fs=require('fs')",
    "fs.writeFileSync('modify.txt','NEW-LONGER')",
    "fs.rmSync('delete.txt')",
    "fs.mkdirSync('dist',{recursive:true})",
    "fs.writeFileSync('dist/app.zip','ARTIFACT')",
    "fs.writeFileSync('.env.local','SECRET')",
    "fs.mkdirSync('shared/logs',{recursive:true})",
    "fs.writeFileSync('shared/logs/runtime.jsonl','LOG')"
  ].join(";");
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "execute_command", command: nodeCommand(script), shell: shellForNodeCommand(), reason: "Change real files." }]
  });
  const changes = result.results[0].result.workspaceChanges;
  const allPaths = [...changes.created, ...changes.modified, ...changes.deleted].map((item) => item.path);

  assert.equal(result.results[0].status, "completed");
  assert.equal(changes.created.some((item) => item.path === "dist/app.zip"), true);
  assert.equal(changes.modified.some((item) => item.path === "modify.txt"), true);
  assert.equal(changes.deleted.some((item) => item.path === "delete.txt"), true);
  assert.equal(allPaths.includes(".env.local"), false);
  assert.equal(allPaths.includes("shared/logs/runtime.jsonl"), false);
});

test("execute_command default shell supports common shell operators", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-default-shell-"));
  const command = process.platform === "win32"
    ? "no_such_command_abc123 > missing.txt 2>&1 || echo FALLBACK_FACT > fallback.txt"
    : "no_such_command_abc123 > missing.txt 2>&1 || printf FALLBACK_FACT > fallback.txt";

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command, reason: "Use default shell operators." }
    ]
  });

  assert.equal(result.results[0].status, "completed");
  assert.match(fs.readFileSync(path.join(tmp, "fallback.txt"), "utf8"), /FALLBACK_FACT/);
});

test("execute_command explains bash shell failures on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-specific shell guidance");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-bash-hint-"));
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "execute_command", command: "exit 7", shell: "bash", reason: "Show shell guidance." }
    ]
  });

  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /Windows host/);
  assert.match(result.results[0].result.environmentHint, /shell=cmd/);
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

test("execute_command rejects an identical command after it already failed in the same loop", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-repeat-"));
  const marker = path.join(tmp, "should-not-run.txt");
  const command = nodeCommand(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'RAN'); process.exit(7)`);
  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    previousResults: [{
      tool: "execute_command",
      command,
      status: "failed",
      result: { command, exitCode: 7 }
    }],
    requests: [
      { tool: "execute_command", command, shell: shellForNodeCommand(), reason: "Repeat failed command." }
    ]
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, "repeated_failed_command");
  assert.equal(fs.existsSync(marker), false);
});

test("tool loop limits repeated download failures without limiting build retries", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-budget-"));
  const previousDownloads = ["one", "two", "three"].map((name) => ({
    tool: "execute_command",
    command: `curl https://example.invalid/${name}.zip`,
    status: "failed",
    result: { exitCode: 1 }
  }));
  const blocked = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    previousResults: previousDownloads,
    requests: [{ tool: "execute_command", command: "curl https://mirror.invalid/four.zip", reason: "Try another mirror." }]
  });
  const buildRetry = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    previousResults: ["one", "two", "three"].map((name) => ({
      tool: "execute_command",
      command: `build-tool ${name}`,
      status: "failed",
      result: { exitCode: 1 }
    })),
    requests: [{ tool: "execute_command", command: nodeCommand("console.log('BUILD_RETRY_ALLOWED')"), shell: shellForNodeCommand(), reason: "Retry after changing code." }]
  });

  assert.equal(blocked.accepted.length, 0);
  assert.equal(blocked.rejected[0].code, "failed_strategy_budget_exhausted");
  assert.equal(buildRetry.results[0].status, "completed");
  assert.match(buildRetry.results[0].result.stdout, /BUILD_RETRY_ALLOWED/);
});

test("execute_command can invoke a managed tool by name", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-managed-command-"));
  const group = path.join(root, "group");
  const toolBin = path.join(root, "tools", "managed", "bin");
  fs.mkdirSync(group, { recursive: true });
  fs.mkdirSync(toolBin, { recursive: true });
  const toolName = process.platform === "win32" ? "managed-hello.cmd" : "managed-hello";
  const toolPath = path.join(toolBin, toolName);
  fs.writeFileSync(toolPath, process.platform === "win32" ? "@echo MANAGED_TOOL_FACT\r\n" : "#!/bin/sh\necho MANAGED_TOOL_FACT\n", "utf8");
  if (process.platform !== "win32") fs.chmodSync(toolPath, 0o755);

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: group,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "execute_command", command: "managed-hello", reason: "Use an existing managed tool." }]
  });

  assert.equal(result.results[0].status, "completed");
  assert.match(result.results[0].result.stdout, /MANAGED_TOOL_FACT/);
  assert.equal(result.results[0].result.environment.pathAdditions.some((item) => item.includes("tools")), true);
});

test("file tools can inspect generated output directories without recursively scanning them", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-output-files-"));
  fs.mkdirSync(path.join(tmp, "build", "libs"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "node_modules", "hidden-package"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "build", "libs", "artifact.txt"), "OUTPUT_FACT", "utf8");

  const listed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "list_directory", path: "build/libs", reason: "Inspect generated artifacts." }]
  });
  const searched = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "search_files", path: ".", query: "artifact.txt", reason: "Search source tree." }]
  });
  const hidden = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [{ tool: "list_directory", path: "node_modules", reason: "Try dependency internals." }]
  });

  assert.equal(listed.results[0].status, "completed");
  assert.deepEqual(listed.results[0].result.entries.map((entry) => entry.name), ["artifact.txt"]);
  assert.deepEqual(searched.results[0].result.results, []);
  assert.equal(hidden.results[0].code, "forbidden_path");
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

  const reused = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 2,
    requests: [
      { tool: "run_code", language: "javascript", code: "process.stdout.write(require('local-install-fact'));", reason: "Use the installed package." }
    ]
  });

  assert.equal(reused.results[0].status, "completed");
  assert.equal(reused.results[0].result.stdout, "LOCAL_INSTALL_FACT");
});

test("install_package supports cargo go and gem managers in managed workspace environments", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-install-package-managers-"));
  const bin = path.join(tmp, "fake-bin");
  makeFakeExecutable(bin, "cargo");
  makeFakeExecutable(bin, "go");
  makeFakeExecutable(bin, "gem");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ""}`;

  try {
    const result = await executeToolRequests({
      permissionTier: "full",
      groupPath: tmp,
      agent: { id: "full", name: "Full" },
      round: 1,
      requests: [
        { tool: "install_package", manager: "cargo", packageName: "serde", reason: "Install Rust crate." },
        { tool: "install_package", manager: "go", packageName: "example.com/mod", reason: "Install Go module." },
        { tool: "install_package", manager: "gem", packageName: "rake", reason: "Install Ruby gem." }
      ]
    });

    assert.equal(result.results.length, 3);
    assert.deepEqual(result.results.map((item) => item.status), ["completed", "completed", "completed"]);
    assert.deepEqual(result.results.map((item) => item.result.manager), ["cargo", "go", "gem"]);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "cargo", "Cargo.toml")), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "cargo", "cargo-ran.txt")), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "go", "go.mod")), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "go", "go-ran.txt")), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "gem", "gems")), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "environments", "gem", "gem-ran.txt")), true);
  } finally {
    process.env.PATH = oldPath;
  }
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

test("api_request performs real HTTP calls and redacts sensitive headers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-api-request-"));
  let received = {};
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      method: req.method,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8")
    };
    res.writeHead(201, { "Content-Type": "application/json", "X-Test": "ok" });
    res.end(JSON.stringify({ ok: true, saw: JSON.parse(received.body).name }));
  });
  await listen(server);
  const address = server.address();
  try {
    const result = await executeToolRequests({
      permissionTier: "tool",
      groupPath: tmp,
      agent: { id: "tool", name: "Tool" },
      round: 1,
      allowUnsafePrivateNetwork: true,
      allowHttp: true,
      requests: [
        {
          tool: "api_request",
          method: "POST",
          url: `http://127.0.0.1:${address.port}/api/check`,
          headers: { Authorization: "Bearer secret-token", "X-Plain": "visible" },
          json: { name: "API_FACT" },
          reason: "Call local test API."
        }
      ]
    });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.results[0].status, "completed");
    assert.equal(result.results[0].result.status, 201);
    assert.match(result.results[0].result.text, /API_FACT/);
    assert.equal(result.results[0].result.requestHeaders.Authorization, "[redacted]");
    assert.equal(result.results[0].result.requestHeaders["X-Plain"], "visible");
    assert.equal(received.method, "POST");
    assert.equal(received.authorization, "Bearer secret-token");
    assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "api-requests.jsonl")), true);
  } finally {
    await close(server);
  }
});

test("api_request blocks localhost by default", async () => {
  const result = await executeToolRequests({
    permissionTier: "tool",
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "api_request", method: "GET", url: "http://127.0.0.1:1/", reason: "Blocked local API." }
    ]
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /Blocked unsafe URL|only https/i);
});

test("git_operation runs real git status for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-status-"));
  initGitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "notes.txt"), "GIT_STATUS_FACT\n", "utf8");

  const denied = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "status", reason: "Check status." }
    ]
  });
  const allowed = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "status", reason: "Check status." }
    ]
  });

  assert.equal(denied.accepted.length, 0);
  assert.equal(denied.rejected[0].code, "permission_denied");
  assert.equal(allowed.accepted.length, 1);
  assert.equal(allowed.results[0].status, "completed");
  assert.equal(allowed.results[0].result.action, "status");
  assert.equal(allowed.results[0].result.dirty.some((item) => item.path === "notes.txt"), true);
  assert.equal(allowed.events.some((event) => event.type === "tool_success" && event.tool === "git_operation"), true);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "git.jsonl")), true);
});

test("git_operation commits staged workspace changes and creates branches", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-commit-"));
  initGitRepo(tmp);
  fs.writeFileSync(path.join(tmp, "notes.txt"), "GIT_COMMIT_FACT\n", "utf8");

  const commit = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "commit", message: "test: add notes", paths: ["notes.txt"], reason: "Commit notes." }
    ]
  });
  const branch = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "create_branch", branch: "feature/git-tool", reason: "Create branch." }
    ]
  });

  assert.equal(commit.results[0].status, "completed");
  assert.match(commit.results[0].result.commitHash, /^[a-f0-9]+$/);
  assert.match(execFileSync("git", ["show", "--name-only", "--format="], { cwd: tmp, encoding: "utf8" }), /notes\.txt/);
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "git.jsonl")), true);
  assert.equal(branch.results[0].status, "completed");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim(), "feature/git-tool");
});

test("git_operation clones repositories into workspace destinations", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-clone-"));
  const source = path.join(tmp, "source-repo");
  fs.mkdirSync(source, { recursive: true });
  initGitRepo(source);
  fs.writeFileSync(path.join(source, "README.md"), "GIT_CLONE_FACT\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: source, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "seed clone fixture"], { cwd: source, stdio: "pipe" });

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "clone", url: source, destination: "workspace/cloned-repo", reason: "Clone local fixture." }
    ]
  });

  assert.equal(result.results[0].status, "completed");
  assert.equal(result.results[0].result.action, "clone");
  assert.deepEqual(result.results[0].result.paths, ["workspace/cloned-repo"]);
  assert.match(fs.readFileSync(path.join(tmp, "workspace", "cloned-repo", "README.md"), "utf8"), /GIT_CLONE_FACT/);
});

test("git_operation rejects unsupported destructive actions", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-reject-"));
  initGitRepo(tmp);

  const result = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      { tool: "git_operation", action: "reset_hard", reason: "Try destructive git action." }
    ]
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].code, "unsupported_git_operation");
});

test("browser_control drives a real browser page for full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-browser-tool-"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>Browser Tool Fact</title></head>
        <body>
          <input id="name" />
          <button id="go" onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#name').value">Go</button>
          <div id="out"></div>
        </body>
      </html>`);
  });
  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const denied = await executeToolRequests({
      permissionTier: "tool",
      groupPath: tmp,
      agent: { id: "tool", name: "Tool" },
      round: 1,
      requests: [
        { tool: "browser_control", url, reason: "Open page." }
      ]
    });
    const allowed = await executeToolRequests({
      permissionTier: "full",
      groupPath: tmp,
      agent: { id: "full", name: "Full" },
      round: 1,
      requests: [
        {
          tool: "browser_control",
          url,
          reason: "Drive local page.",
          steps: [
            { action: "wait_for_selector", selector: "#name" },
            { action: "type", selector: "#name", text: "Alice" },
            { action: "click", selector: "#go" },
            { action: "wait", waitMs: 200 },
            { action: "evaluate", expression: "document.querySelector('#out').textContent" },
            { action: "screenshot" }
          ]
        }
      ]
    });

    assert.equal(denied.accepted.length, 0);
    assert.equal(denied.rejected[0].code, "permission_denied");
    assert.equal(allowed.accepted.length, 1);
    assert.equal(allowed.results[0].status, "completed");
    assert.equal(allowed.results[0].result.title, "Browser Tool Fact");
    assert.match(allowed.results[0].result.text, /Hello Alice/);
    assert.equal(allowed.results[0].result.steps[4].value, "Hello Alice");
    assert.equal(allowed.results[0].result.screenshots.length, 1);
    assert.equal(fs.existsSync(path.join(tmp, allowed.results[0].result.screenshots[0].path)), true);
    assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "browser.jsonl")), true);
  } finally {
    await close(server);
  }
});

test("database_query reads SQLite with tool permission and writes with full permission only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-database-tool-"));
  const setup = await executeToolRequests({
    permissionTier: "full",
    groupPath: tmp,
    agent: { id: "full", name: "Full" },
    round: 1,
    requests: [
      {
        tool: "database_query",
        path: "data/app.sqlite",
        create: true,
        mode: "execute",
        sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('DB_FACT');",
        reason: "Create database fixture."
      }
    ]
  });
  const read = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      {
        tool: "database_query",
        path: "data/app.sqlite",
        sql: "SELECT body FROM notes WHERE body = ?",
        params: ["DB_FACT"],
        reason: "Read database fact."
      }
    ]
  });
  const deniedWrite = await executeToolRequests({
    permissionTier: "tool",
    groupPath: tmp,
    agent: { id: "tool", name: "Tool" },
    round: 1,
    requests: [
      {
        tool: "database_query",
        path: "data/app.sqlite",
        mode: "execute",
        sql: "INSERT INTO notes(body) VALUES ('SHOULD_NOT_WRITE')",
        reason: "Try write without full permission."
      }
    ]
  });

  assert.equal(setup.results[0].status, "completed");
  assert.equal(read.accepted.length, 1);
  assert.equal(read.results[0].status, "completed");
  assert.deepEqual(read.results[0].result.rows, [{ body: "DB_FACT" }]);
  assert.equal(read.results[0].result.readOnly, true);
  assert.equal(deniedWrite.results[0].status, "failed");
  assert.equal(deniedWrite.results[0].code, "permission_denied");
  assert.equal(fs.existsSync(path.join(tmp, "shared", "logs", "database.jsonl")), true);
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
  fs.mkdirSync(path.join(tmp, "shared", "file-ops", "recovery", "fop_1"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "shared", "file-ops", "recovery", "fop_1", "content.bin"), "RECOVERY_SECRET", "utf8");
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
  const readRecovery = executeFileToolResult({
    tool: "read_file",
    path: "shared/file-ops/recovery/fop_1/content.bin",
    reason: "Read internal recovery data"
  }, tmp);
  const listShared = executeFileTool(
    { tool: "list_directory", path: "shared", reason: "List shared workspace data" },
    { groupPath: tmp }
  );
  const searchRecovery = executeFileTool(
    { tool: "search_files", query: "content.bin", reason: "Search internal recovery data" },
    { groupPath: tmp }
  );
  const grepRecovery = executeFileTool(
    { tool: "grep_content", query: "RECOVERY_SECRET", reason: "Search internal recovery content" },
    { groupPath: tmp }
  );

  assert.deepEqual(list.entries.map((entry) => entry.name), ["shared", "public.md"]);
  assert.deepEqual(listShared.entries, []);
  assert.equal(readGroup.code, "forbidden_internal_file");
  assert.equal(readPrivate.code, "forbidden_internal_path");
  assert.equal(readRecovery.code, "forbidden_internal_path");
  assert.equal(searchRecovery.results.length, 0);
  assert.equal(grepRecovery.results.length, 0);
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

function processTool(groupPath, request) {
  return executeToolRequests({
    permissionTier: "full",
    groupPath,
    agent: { id: "full", name: "Full" },
    round: 2,
    requests: [{ tool: "process_control", reason: "Manage a background process.", ...request }]
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function waitForResult(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Result was not available within ${timeoutMs}ms.`);
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "AI Council Test"], { cwd: dir, stdio: "pipe" });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function makeFakeExecutable(binDir, name) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), [
      "@echo off",
      `echo %* > ${name}-args.txt`,
      `echo ${name} ran > ${name}-ran.txt`,
      ""
    ].join("\r\n"), "utf8");
    return;
  }
  const filePath = path.join(binDir, name);
  fs.writeFileSync(filePath, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" > "${name}-args.txt"`,
    `printf '${name} ran\\n' > "${name}-ran.txt"`,
    ""
  ].join("\n"), "utf8");
  fs.chmodSync(filePath, 0o755);
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
