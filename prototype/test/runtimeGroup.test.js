import test from "node:test";
import assert from "node:assert/strict";
import { workspaceGroupToRuntimeGroup } from "../renderer/lib/runtime-group.mjs";
import { validateGroupConfig, validateRuntimeEnv } from "../src/config.js";

test("an unconfigured workspace seat never becomes a fabricated mock provider", () => {
  const runtime = workspaceGroupToRuntimeGroup({
    id: "unconfigured-group",
    name: "Unconfigured group",
    seats: [{
      seatId: "builder",
      displayName: "Builder",
      role: "builder",
      enabled: true,
      apiBaseUrl: "",
      currentModel: "",
      providerPreset: "",
    }],
  }, 0);

  assert.equal(runtime.agents[0].provider, "unconfigured");
  assert.equal(runtime.agents[0].apiBaseUrl, "");
  assert.equal(runtime.agents[0].model, "");
  const validated = validateGroupConfig(runtime);
  assert.throws(
    () => validateRuntimeEnv(validated),
    /Missing model provider configuration for: builder/,
  );
});

test("a remote endpoint without a key remains unconfigured while an explicit mock stays test-only", () => {
  const runtime = workspaceGroupToRuntimeGroup({
    id: "provider-state-group",
    name: "Provider state group",
    seats: [
      {
        seatId: "remote-without-key",
        displayName: "Remote without key",
        role: "builder",
        enabled: true,
        providerPreset: "deepseek",
        apiBaseUrl: "https://api.deepseek.example/v1",
        currentModel: "deepseek-chat",
      },
      {
        seatId: "explicit-mock",
        displayName: "Explicit mock",
        role: "tester",
        enabled: true,
        providerPreset: "mock",
        apiBaseUrl: "mock://local",
        currentModel: "mock-fixture",
      },
    ],
  }, 0);

  assert.equal(runtime.agents[0].provider, "unconfigured");
  assert.equal(runtime.agents[1].provider, "mock");
});
