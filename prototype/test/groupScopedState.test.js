import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("loaded groups do not fall back to legacy global browser state", () => {
  assert.match(appJs, /function loadScopedJson/);
  assert.match(appJs, /function loadScopedValue/);
  assert.match(appJs, /return group \? fallback : loadJson\(legacyStorageKey\(name\), fallback\)/);
  assert.match(appJs, /\?\? \(group \? null : localStorage\.getItem\(legacyStorageKey\(name\)\)\)/);
});

test("group-specific API keys only live under scoped seat storage", () => {
  assert.match(appJs, /clearCurrentGroupApiKeys/);
  assert.match(appJs, /saveScopedJson\("custom-seats", state\.customSeats\)/);
  assert.match(appJs, /saveScopedJson\("seat-overrides", state\.seatOverrides\)/);
  assert.doesNotMatch(appJs, /saveJson\("ai-council-custom-seats"/);
  assert.doesNotMatch(appJs, /saveJson\("ai-council-seat-overrides"/);
  assert.doesNotMatch(appJs, /localStorage\.setItem\("ai-council-autonomous-rounds"/);
  assert.doesNotMatch(appJs, /localStorage\.setItem\("ai-council-conversation-mode"/);
});
