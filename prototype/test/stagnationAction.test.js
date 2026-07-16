import test from "node:test";
import assert from "node:assert/strict";
import { hasMaterialExecutionRequest } from "../src/discussionEngine.js";

test("stagnation recovery accepts execution and capability actions but not more observation", () => {
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "execute_command", command: "node build.js" }] }), true);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "run_code", language: "node", code: "console.log('ok')" }] }), true);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "install_package", manager: "npm", packageName: "chosen-package" }] }), true);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "workspace_edit", action: "write", path: "out.txt", code: "done" }] }), true);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "read_file", path: "out.txt" }] }), false);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "execute_command", command: "" }] }), false);
});

test("read-only Git and database requests do not impersonate material recovery", () => {
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "git_operation", action: "status" }] }), false);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "git_operation", action: "commit" }] }), true);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "database_query", sql: "SELECT * FROM tasks" }] }), false);
  assert.equal(hasMaterialExecutionRequest({ tool_requests: [{ tool: "database_query", sql: "UPDATE tasks SET done = 1" }] }), true);
});
