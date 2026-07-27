import test from "node:test";
import assert from "node:assert/strict";
import { nativeToolDefinitions, normalizeNativeToolCalls } from "../src/nativeToolProtocol.js";

test("native tool definitions expose only tools allowed by the permission tier", () => {
  const text = nativeToolDefinitions("text").map((item) => item.name);
  const tool = nativeToolDefinitions("tool").map((item) => item.name);
  const full = nativeToolDefinitions("full").map((item) => item.name);
  assert.deepEqual(text, ["search_context", "load_context"]);
  assert.equal(tool.includes("read_file"), true);
  assert.equal(tool.includes("workspace_edit"), false);
  assert.equal(full.includes("workspace_edit"), true);
  assert.equal(full.includes("execute_command"), true);
  assert.equal(full.includes("ai_council_tool"), false);
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
