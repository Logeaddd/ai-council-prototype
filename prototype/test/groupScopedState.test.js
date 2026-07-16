import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(".");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("loaded groups use guarded backend APIs instead of legacy browser state", () => {
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");
  const source = `${app}\n${live}`;

  assert.match(source, /\/api\/groups-index/);
  assert.match(source, /\/api\/group\?groupPath=/);
  assert.match(source, /groupRecordToUiGroup/);
  assert.match(source, /WorkspaceGroup/);

  assert.doesNotMatch(source, /legacyStorageKey/);
  assert.doesNotMatch(source, /loadScopedJson/);
  assert.doesNotMatch(source, /loadScopedValue/);
  assert.doesNotMatch(source, /saveScopedJson/);
  assert.doesNotMatch(source, /ai-council-custom-seats/);
  assert.doesNotMatch(source, /ai-council-seat-overrides/);
});

test("group-specific member config and API keys go through guarded server endpoints", () => {
  const app = read("renderer/components/council/council-app.tsx");
  const live = read("renderer/lib/council-live.ts");
  const source = `${app}\n${live}`;

  assert.match(source, /addWorkspaceMember/);
  assert.match(source, /\/api\/workspace\/add-member/);
  assert.match(source, /saveSeatConfig/);
  assert.match(source, /\/api\/group\/seat/);
  assert.match(source, /apiKey: values\.apiKey/);

  assert.doesNotMatch(source, /localStorage\.setItem\([^)]*(apiKey|custom-seats|seat-overrides)/i);
  assert.doesNotMatch(source, /localStorage\.getItem\([^)]*(apiKey|custom-seats|seat-overrides)/i);
  assert.doesNotMatch(source, /localStorage\.setItem\("ai-council-autonomous-rounds"/);
  assert.doesNotMatch(source, /localStorage\.setItem\("ai-council-conversation-mode"/);
});

test("stale reviewer role text is not sent to models after reviewer flags are cleared", async () => {
  const { workspaceGroupToRuntimeGroup } = await import("../renderer/lib/runtime-group.mjs");
  const runtime = workspaceGroupToRuntimeGroup({
    groupFolderName: "bug-repro",
    seats: [
      {
        seatId: "seat_01",
        displayName: "李晓彤",
        currentModel: "deepseek-v4-pro",
        model: "deepseek-v4-pro",
        role: "reviewer",
        reviewer: false,
        mandatoryRedTeam: false,
        judge: false,
        enabled: true,
        providerPreset: "deepseek",
        apiBaseUrl: "https://api.deepseek.com/v1",
        apiKey: "set"
      }
    ]
  }, 3);

  assert.equal(runtime.agents[0].reviewer, false);
  assert.equal(runtime.agents[0].mandatoryRedTeam, false);
  assert.notEqual(runtime.agents[0].role, "reviewer");
});

test("browser localStorage is limited to UI layout preferences", () => {
  const app = read("renderer/components/council/council-app.tsx");

  assert.match(app, /const LAYOUT_KEY = "ai-council:layout-v3-template"/);
  assert.match(app, /localStorage\.getItem\(LAYOUT_KEY\)/);
  assert.match(app, /localStorage\.setItem\(\s*LAYOUT_KEY/);
});
