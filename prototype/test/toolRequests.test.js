import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
