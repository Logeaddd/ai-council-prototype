import test from "node:test";
import assert from "node:assert/strict";
import { nativeToolDefinitions, normalizeNativeToolCalls } from "../src/nativeToolProtocol.js";

test("native tool definitions expose only tools allowed by the permission tier", () => {
  const text = nativeToolDefinitions("text")[0].inputSchema.properties.tool.enum;
  const tool = nativeToolDefinitions("tool")[0].inputSchema.properties.tool.enum;
  const full = nativeToolDefinitions("full")[0].inputSchema.properties.tool.enum;
  assert.deepEqual(text, ["search_context", "load_context"]);
  assert.equal(tool.includes("read_file"), true);
  assert.equal(tool.includes("workspace_edit"), false);
  assert.equal(full.includes("workspace_edit"), true);
  assert.equal(full.includes("execute_command"), true);
});

test("native provider calls normalize into the existing tool request protocol", () => {
  const requests = normalizeNativeToolCalls([{
    id: "call_1",
    name: "ai_council_tool",
    arguments: JSON.stringify({
      tool: "workspace_edit",
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

test("malformed native arguments are ignored instead of becoming fake requests", () => {
  assert.deepEqual(normalizeNativeToolCalls([{ name: "ai_council_tool", arguments: "{bad" }]), []);
});
