import test from "node:test";
import assert from "node:assert/strict";
import { createCouncilRunRegistry } from "../src/councilRunRegistry.js";

test("starting a group run aborts the previous backend run", () => {
  const registry = createCouncilRunRegistry();
  const first = registry.start("C:/workspace/group-a");
  const second = registry.start("C:/workspace/group-a");

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(first.controller.signal.reason?.code, "superseded_by_new_run");
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(registry.get("C:/workspace/group-a")?.id, second.id);
});

test("an old run cannot remove the replacement run from the registry", () => {
  const registry = createCouncilRunRegistry();
  const first = registry.start("C:/workspace/group-a");
  const second = registry.start("C:/workspace/group-a");

  assert.equal(registry.finish("C:/workspace/group-a", first.id), false);
  assert.equal(registry.get("C:/workspace/group-a")?.id, second.id);
  assert.equal(registry.finish("C:/workspace/group-a", second.id), true);
  assert.equal(registry.size(), 0);
});

test("explicit stop aborts the real active controller", () => {
  const registry = createCouncilRunRegistry();
  const run = registry.start("C:/workspace/group-a");

  assert.deepEqual(registry.stop("C:/workspace/group-a"), { stopped: true, runId: run.id });
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(run.controller.signal.reason?.code, "stopped_by_user");
  assert.deepEqual(registry.stop("C:/workspace/group-b"), { stopped: false, runId: "" });
});
