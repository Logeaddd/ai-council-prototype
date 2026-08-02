import test from "node:test";
import assert from "node:assert/strict";
import { nativeToolDefinitions, normalizeNativeToolCalls } from "../src/nativeToolProtocol.js";

test("native tool definitions expose only tools allowed by the permission tier", () => {
  const text = nativeToolDefinitions("text").map((item) => item.name);
  const tool = nativeToolDefinitions("tool").map((item) => item.name);
  const full = nativeToolDefinitions("full").map((item) => item.name);
  assert.deepEqual(text, ["record_task_contract", "search_context", "load_context", "tool_search", "tool_inspect", "tool_invoke"]);
  assert.equal(tool.includes("read_file"), true);
  assert.equal(tool.includes("workspace_edit"), false);
  assert.equal(full.includes("workspace_edit"), true);
  assert.equal(full.includes("execute_command"), true);
  assert.equal(full.includes("ai_council_tool"), false);
});

test("native deferred-tool definitions expose closed search, inspect, and invoke schemas", () => {
  const definitions = nativeToolDefinitions("full", { tools: ["tool_search", "tool_inspect", "tool_invoke"] });
  assert.deepEqual(definitions.map((item) => item.name), ["tool_search", "tool_inspect", "tool_invoke"]);
  assert.deepEqual(definitions[0].inputSchema.required, ["reason", "query"]);
  assert.deepEqual(definitions[1].inputSchema.required, ["reason", "toolName"]);
  assert.deepEqual(definitions[2].inputSchema.required, ["reason", "toolName", "arguments"]);
  assert.equal(definitions[2].inputSchema.additionalProperties, false);
});

test("native tool definitions are per-tool closed schemas and can be narrowed at runtime", () => {
  const [write, command] = nativeToolDefinitions("full", { tools: ["workspace_edit", "execute_command"] });
  assert.equal(write.name, "workspace_edit");
  assert.equal(write.inputSchema.additionalProperties, false);
  assert.deepEqual(write.inputSchema.required, ["reason", "action", "path"]);
  assert.equal("command" in write.inputSchema.properties, false);
  assert.equal(command.name, "execute_command");
  assert.equal(command.inputSchema.additionalProperties, false);
  assert.deepEqual(command.inputSchema.required, ["reason", "command"]);
});

test("native provisioning schema preserves researched source fields", () => {
  const provision = nativeToolDefinitions("full", { tools: ["provision_tool"] })[0];
  assert.equal(provision.name, "provision_tool");
  assert.equal("discoverySourceUrl" in provision.inputSchema.properties, true);
  assert.equal("discoveryQuery" in provision.inputSchema.properties, true);

  const requests = normalizeNativeToolCalls([{
    id: "call_discovery",
    name: "provision_tool",
    input: {
      toolName: "example-cli",
      commandName: "example-cli",
      manager: "winget",
      packageId: "Publisher.ExampleCli",
      discoverySourceUrl: "https://publisher.example.test/install?temporary=secret",
      discoveryQuery: "example cli official install",
      reason: "Acquire the missing CLI from its publisher listing."
    }
  }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool, "provision_tool");
  assert.equal(requests[0].discoverySourceUrl, "https://publisher.example.test/install?temporary=secret");
  assert.equal(requests[0].discoveryQuery, "example cli official install");
});

test("native delegation schema carries a bounded contributor handoff request", () => {
  const delegation = nativeToolDefinitions("full", { tools: ["delegate_task"] })[0];
  assert.equal(delegation.name, "delegate_task");
  assert.deepEqual(delegation.inputSchema.required, ["reason", "delegationType", "assigneeId", "task", "expectedEvidence"]);
  assert.equal("allowRuntimeMutation" in delegation.inputSchema.properties, true);

  const [request] = normalizeNativeToolCalls([{
    id: "call_delegate",
    name: "delegate_task",
    input: {
      delegationType: "research",
      assigneeId: "researcher",
      task: "Read the source fact only.",
      expectedEvidence: ["Source file and extracted fact"],
      allowedTools: ["read_file"],
      allowWorkspaceMutation: false,
      reason: "Ask a contributor to verify the bounded fact."
    }
  }]);
  assert.equal(request.tool, "delegate_task");
  assert.equal(request.assigneeId, "researcher");
  assert.equal(request.delegationTask, "Read the source fact only.");
  assert.deepEqual(request.expectedEvidence, ["Source file and extracted fact"]);

  const [unblocker] = normalizeNativeToolCalls([{
    id: "call_unblocker",
    name: "delegate_task",
    input: {
      delegationType: "unblocker",
      assigneeId: "runtime-helper",
      task: "Acquire one missing managed runtime.",
      expectedEvidence: ["Verified runtime command"],
      allowedTools: ["provision_tool"],
      allowWorkspaceMutation: false,
      allowRuntimeMutation: true,
      reason: "Delegate bounded runtime acquisition."
    }
  }]);
  assert.equal(unblocker.allowRuntimeMutation, true);
});

test("native task contract schema carries semantic artifact requirements", () => {
  const contract = nativeToolDefinitions("full", { tools: ["record_task_contract"] })[0];
  assert.equal(contract.name, "record_task_contract");
  assert.deepEqual(contract.inputSchema.required, ["reason", "taskContract"]);
  assert.equal(contract.inputSchema.properties.taskContract.additionalProperties, false);

  const [request] = normalizeNativeToolCalls([{
    id: "call_contract",
    name: "record_task_contract",
    input: {
      reason: "Persist the requested document before creating it.",
      taskContract: {
        mode: "delivery",
        objective: "Create the requested illustrated report.",
        requiresWorkspace: true,
        requiresVerification: true,
        deliverables: ["One illustrated PDF report"],
        artifacts: [{ path: "deliverables/report.pdf", extension: ".pdf", requiresImages: true, minimumPages: 2 }],
        completionCriteria: ["The PDF exists and is structurally valid."],
        nextAction: "Inspect the requested source material."
      }
    }
  }]);
  assert.equal(request.tool, "record_task_contract");
  assert.equal(request.taskContract.artifacts[0].extension, ".pdf");
});

test("native provider calls normalize into the existing tool request protocol", () => {
  const requests = normalizeNativeToolCalls([{
    id: "call_1",
    name: "workspace_edit",
    arguments: JSON.stringify({
      action: "write",
      path: "shared/project/app.js",
      code: "export default 1;\n",
      reason: "Create the source"
    })
  }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, "call_1");
  assert.equal(requests[0].tool, "workspace_edit");
  assert.equal(requests[0].code, "export default 1;\n");
});

test("legacy aggregate native calls remain readable for persisted sessions", () => {
  const requests = normalizeNativeToolCalls([{
    id: "call_legacy",
    name: "ai_council_tool",
    arguments: JSON.stringify({ tool: "read_file", path: "shared/project/app.js", reason: "Read the existing source" })
  }]);
  assert.equal(requests[0].tool, "read_file");
  assert.equal(requests[0].path, "shared/project/app.js");
});

test("malformed native arguments are ignored instead of becoming fake requests", () => {
  assert.deepEqual(normalizeNativeToolCalls([{ name: "ai_council_tool", arguments: "{bad" }]), []);
});
