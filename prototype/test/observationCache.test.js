import test from "node:test";
import assert from "node:assert/strict";
import { createObservationCache, observationValueForConsumer } from "../src/observationCache.js";

test("shared observations match equivalent tool and file-operation reads", () => {
  const cache = createObservationCache();
  cache.set({ tool: "read_file", path: "src/Main.java" }, {
    ok: true,
    root: "workspace",
    path: "src/Main.java",
    bytes: 12,
    truncated: false,
    content: "class Main{}"
  }, { id: "tool-read", source_agent_id: "builder", source_agent_name: "Builder" });

  const cached = cache.get({ op: "read", path: "src/Main.java" });
  assert.equal(cached.sourceId, "tool-read");
  assert.equal(cached.sourceAgentId, "builder");
  assert.deepEqual(observationValueForConsumer({ op: "read", path: "src/Main.java" }, cached.value), {
    bytes: 12,
    truncated: false,
    content: "class Main{}"
  });
});

test("shared observations adapt list results for both protocols", () => {
  const cache = createObservationCache();
  cache.set({ op: "list", path: "src" }, {
    entries: ["main/", "App.java"],
    truncated: false
  }, { proposalId: "file-list", source_agent_id: "designer" });

  const cached = cache.get({ tool: "list_directory", path: "src" });
  const value = observationValueForConsumer({ tool: "list_directory", path: "src" }, cached.value);
  assert.deepEqual(value.entries, [
    { name: "main", path: "src/main", type: "directory" },
    { name: "App.java", path: "src/App.java", type: "file" }
  ]);
});

test("workspace mutation invalidates observations and force bypasses cache", () => {
  const cache = createObservationCache();
  cache.set({ tool: "read_file", path: "README.md" }, { content: "old" }, { id: "read-1" });
  assert.equal(cache.get({ tool: "read_file", path: "README.md", force: true }), undefined);
  assert.ok(cache.get({ tool: "read_file", path: "README.md" }));
  cache.invalidate("write");
  assert.equal(cache.get({ tool: "read_file", path: "README.md" }), undefined);
  assert.equal(cache.revision(), 1);
});
