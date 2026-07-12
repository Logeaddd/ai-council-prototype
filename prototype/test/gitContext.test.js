import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadGitCommitContext } from "../src/gitContext.js";
import { executeToolRequests } from "../src/toolRequests.js";
import { writeGroupSession } from "../src/storage.js";

test("commit context loads the exact Git diff and links later public verification evidence", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-context-"));
  git(groupPath, ["init"]);
  git(groupPath, ["config", "user.email", "test@example.com"]);
  git(groupPath, ["config", "user.name", "AI Council Test"]);
  fs.writeFileSync(path.join(groupPath, "app.txt"), "first line\n", "utf8");
  git(groupPath, ["add", "app.txt"]);
  git(groupPath, ["commit", "-m", "test: add app"]);
  const commit = git(groupPath, ["rev-parse", "HEAD"]).trim();

  writeGroupSession({
    id: "session_git_context_1",
    question: "Create the app",
    createdAt: "2026-07-12T10:00:00.000Z",
    completedAt: "2026-07-12T10:03:00.000Z",
    status: "completed",
    executionState: { active: true, taskQuestion: "Create the app" },
    messages: [],
    toolExecutionResults: [{
      id: "git-tool-1",
      tool: "git_operation",
      action: "commit",
      status: "completed",
      round: 1,
      source_agent_id: "builder",
      source_agent_name: "Builder",
      result: { ok: true, cwd: ".", commitHash: commit },
      createdAt: "2026-07-12T10:01:00.000Z"
    }, {
      id: "test-tool-1",
      tool: "run_tests",
      status: "completed",
      round: 1,
      source_agent_id: "builder",
      source_agent_name: "Builder",
      result: { ok: true, exitCode: 0 },
      createdAt: "2026-07-12T10:02:00.000Z"
    }],
    fileOperationProposals: [],
    fileOperationExecutionResults: [],
    rejectedToolRequests: [],
    finalDecision: { final_state: "ready_to_execute", answer: "Verified." }
  }, groupPath);

  const context = loadGitCommitContext(groupPath, { commit: commit.slice(0, 10), maxBytes: 128 * 1024 });
  assert.equal(context.commit, commit);
  assert.equal(context.truncated, false);
  assert.match(context.content, /commit [0-9a-f]{40}/);
  assert.match(context.content, /\+first line/);
  assert.equal(context.linkedEvents.some((event) => event.tool === "run_tests" && event.status === "completed"), true);
  assert.equal(context.linkedEvents.some((event) => event.type === "final_decision" && event.status === "ready_to_execute"), true);

  const throughTool = await executeToolRequests({
    requests: [{ tool: "load_context", commit: commit.slice(0, 10), reason: "Load the exact commit evidence." }],
    permissionTier: "text",
    agent: { id: "reader", name: "Reader" },
    round: 2,
    groupPath
  });
  assert.equal(throughTool.results[0].status, "completed");
  assert.equal(throughTool.results[0].result.commit, commit);
});

test("commit context rejects repositories that escaped the group workspace", () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-context-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-git-context-outside-"));
  git(outside, ["init"]);
  git(outside, ["config", "user.email", "test@example.com"]);
  git(outside, ["config", "user.name", "AI Council Test"]);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
  git(outside, ["add", "secret.txt"]);
  git(outside, ["commit", "-m", "outside"]);
  const commit = git(outside, ["rev-parse", "HEAD"]).trim();
  fs.symlinkSync(outside, path.join(groupPath, "linked-repo"), process.platform === "win32" ? "junction" : "dir");
  writeGroupSession({
    id: "session_git_escape_1",
    question: "Read outside",
    createdAt: new Date().toISOString(),
    status: "completed",
    messages: [],
    toolExecutionResults: [{ tool: "git_operation", status: "completed", result: { cwd: "linked-repo", commitHash: commit } }],
    fileOperationProposals: [],
    fileOperationExecutionResults: [],
    rejectedToolRequests: [],
    finalDecision: { final_state: "needs_revision", answer: "Blocked." }
  }, groupPath);
  assert.throws(() => loadGitCommitContext(groupPath, { commit }), /outside the group workspace/);
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
