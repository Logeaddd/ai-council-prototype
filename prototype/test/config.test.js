import test from "node:test";
import assert from "node:assert/strict";
import { validateGroupConfig, validateRuntimeEnv } from "../src/config.js";

function baseGroup(agents) {
  return {
    id: "test",
    name: "Test",
    settings: {},
    agents
  };
}

test("allows review-optional groups with one ordinary enabled agent", () => {
  const group = validateGroupConfig(baseGroup([
    {
      id: "builder",
      name: "Builder",
      role: "Build",
      provider: "mock",
      apiBaseUrl: "mock://local",
      model: "mock",
      weight: 1,
      enabled: true
    }
  ]));

  assert.equal(group.agents[0].mandatoryRedTeam, undefined);
  assert.equal(group.agents[0].judge, undefined);
  assert.equal(group.settings.maxRounds, 0);
  assert.equal(group.settings.minRounds, 1);
});

test("allows explicit reviewer-only groups without forcing a separate non-reviewer or judge", () => {
  const group = validateGroupConfig(baseGroup([
    {
      id: "reviewer",
      name: "Reviewer",
      role: "Review",
      provider: "mock",
      apiBaseUrl: "mock://local",
      model: "mock",
      weight: 1,
      enabled: true,
      reviewer: true,
      mandatoryRedTeam: true
    }
  ]));

  assert.equal(group.agents[0].reviewer, true);
  assert.equal(group.agents[0].judge, undefined);
});

test("normalizes context settings without clamping explicit execution limits", () => {
  const group = validateGroupConfig({
    ...baseGroup([
      {
        id: "builder",
        name: "Builder",
        role: "Build",
        provider: "mock",
        apiBaseUrl: "mock://local",
        model: "mock",
        weight: 1,
        enabled: true
      }
    ]),
    settings: {
      maxRounds: 3,
      contextSearchLimit: 200,
      contextArchiveInjectionLimit: 99,
      contextArchiveInjectionTokens: 999999,
      recentMessageLimit: -10,
      maxToolIterations: 99
    }
  });

  assert.equal(group.settings.contextSearchLimit, 20);
  assert.equal(group.settings.contextArchiveInjectionLimit, 12);
  assert.equal(group.settings.contextArchiveInjectionTokens, 4000);
  assert.equal(group.settings.recentMessageLimit, 0);
  assert.equal(group.settings.maxToolIterations, 99);
});

test("context budget settings get defaults when absent", () => {
  const group = validateGroupConfig(baseGroup([
    {
      id: "builder",
      name: "Builder",
      role: "Build",
      provider: "mock",
      apiBaseUrl: "mock://local",
      model: "mock",
      weight: 1,
      enabled: true
    }
  ]));

  assert.equal(group.settings.contextSearchLimit, 5);
  assert.equal(group.settings.contextArchiveInjectionLimit, 5);
  assert.equal(group.settings.contextArchiveInjectionTokens, 900);
  assert.equal(group.settings.recentMessageLimit, 6);
  assert.equal(group.settings.maxToolIterations, 0);
  assert.equal(group.settings.maxRounds, 0);
  assert.equal(group.settings.maxModelCalls, 0);
  assert.equal(group.settings.noProgressModelCalls, 0);
});

test("zero keeps an explicit round setting unbounded while a positive setting remains a user limit", () => {
  const agent = {
    id: "builder", name: "Builder", role: "Build", provider: "mock", apiBaseUrl: "mock://local", model: "mock", weight: 1, enabled: true
  };
  const unbounded = validateGroupConfig({ ...baseGroup([agent]), settings: { maxRounds: 0, minRounds: 25 } });
  const bounded = validateGroupConfig({ ...baseGroup([agent]), settings: { maxRounds: 8, minRounds: 25 } });

  assert.equal(unbounded.settings.maxRounds, 0);
  assert.equal(unbounded.settings.minRounds, 25);
  assert.equal(bounded.settings.maxRounds, 8);
  assert.equal(bounded.settings.minRounds, 8);
});

test("reports missing env vars before real API runs", () => {
  const group = validateGroupConfig(baseGroup([
    {
      id: "builder",
      name: "Builder",
      role: "Build",
      provider: "openai-compatible",
      apiBaseUrl: "env:AI_COUNCIL_TEST_BASE_URL",
      apiKeyEnv: "AI_COUNCIL_TEST_KEY",
      model: "env:AI_COUNCIL_TEST_MODEL",
      weight: 1,
      enabled: true
    },
    {
      id: "critic",
      name: "Critic",
      role: "Critique",
      provider: "openai-compatible",
      apiBaseUrl: "env:AI_COUNCIL_TEST_BASE_URL",
      apiKeyEnv: "AI_COUNCIL_TEST_KEY",
      model: "env:AI_COUNCIL_TEST_MODEL",
      weight: 1,
      enabled: true,
      mandatoryRedTeam: true
    },
    {
      id: "judge",
      name: "Judge",
      role: "Judge",
      provider: "openai-compatible",
      apiBaseUrl: "env:AI_COUNCIL_TEST_BASE_URL",
      apiKeyEnv: "AI_COUNCIL_TEST_KEY",
      model: "env:AI_COUNCIL_TEST_MODEL",
      weight: 1,
      enabled: true,
      judge: true
    }
  ]));

  delete process.env.AI_COUNCIL_TEST_BASE_URL;
  delete process.env.AI_COUNCIL_TEST_KEY;
  delete process.env.AI_COUNCIL_TEST_MODEL;
  assert.throws(() => validateRuntimeEnv(group), /AI_COUNCIL_TEST_BASE_URL/);
});

test("allows direct runtime API keys without env vars", () => {
  const group = validateGroupConfig(baseGroup([
    {
      id: "builder",
      name: "Builder",
      role: "Build",
      provider: "openai-compatible",
      apiBaseUrl: "https://example.invalid/v1",
      apiKey: "runtime-key",
      model: "runtime-model",
      weight: 1,
      enabled: true
    },
    {
      id: "critic",
      name: "Critic",
      role: "Critique",
      provider: "mock",
      apiBaseUrl: "mock://local",
      model: "mock",
      weight: 1,
      enabled: true,
      mandatoryRedTeam: true
    },
    {
      id: "judge",
      name: "Judge",
      role: "Judge",
      provider: "mock",
      apiBaseUrl: "mock://local",
      model: "mock",
      weight: 1,
      enabled: true,
      judge: true
    }
  ]));

  assert.doesNotThrow(() => validateRuntimeEnv(group));
});
