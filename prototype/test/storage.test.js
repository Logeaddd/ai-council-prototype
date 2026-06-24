import test from "node:test";
import assert from "node:assert/strict";
import { filterDurableMemoryCandidates } from "../src/storage.js";

test("durable memory filter keeps explicit user preferences and project rules", () => {
  assert.deepEqual(filterDurableMemoryCandidates([
    "User prefers concise UI labels.",
    "Project rule: durable writes require user approval.",
    "Remember: user wants a local workspace model."
  ]), [
    "User prefers concise UI labels.",
    "Project rule: durable writes require user approval.",
    "Remember: user wants a local workspace model."
  ]);
});

test("durable memory filter rejects session conclusions and meeting notes", () => {
  assert.deepEqual(filterDurableMemoryCandidates([
    "Smoke test decision: proceed with explicit safeguards.",
    "Critic's minority report: GET requests are not inherently safe.",
    "Key risk: users may misunderstand green checks.",
    "Next action: run another test."
  ]), []);
});
