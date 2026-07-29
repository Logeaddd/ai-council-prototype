import fs from "node:fs";
import path from "node:path";

export function loadJson(filePath) {
  const absolute = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export function loadQuestion(args) {
  const question = getArg(args, "--question");
  if (question) return question;

  const questionFile = getArg(args, "--question-file");
  if (questionFile) return fs.readFileSync(path.resolve(questionFile), "utf8").trim();

  throw new Error("Missing --question or --question-file");
}

export function getArg(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

export function validateGroupConfig(group) {
  if (!group || typeof group !== "object") throw new Error("Group config must be an object");
  if (!group.id || !group.name) throw new Error("Group config needs id and name");
  if (!Array.isArray(group.agents) || group.agents.length === 0) throw new Error("Group needs agents");

  const enabled = group.agents.filter((agent) => agent.enabled);
  if (!enabled.length) throw new Error("Group needs at least one enabled agent");
  for (const agent of enabled) {
    const requiredKeys = agent.provider === "unconfigured"
      ? ["id", "name", "role", "provider"]
      : ["id", "name", "role", "provider", "apiBaseUrl", "model"];
    for (const key of requiredKeys) {
      if (!agent[key]) throw new Error(`Agent ${agent.id ?? "(unknown)"} missing ${key}`);
    }
    if (typeof agent.weight !== "number" || agent.weight <= 0) {
      throw new Error(`Agent ${agent.id} needs positive numeric weight`);
    }
  }

  group.settings = {
    // Zero means no arbitrary round ceiling. The session still ends on a real
    // completion condition, explicit stop, failure, or a user-set limit.
    maxRounds: 0,
    minRounds: 1,
    minConsensusWeight: 0.75,
    stopWhenAllSkip: true,
    agentTimeoutMs: 900000,
    // Zero delegates to each tool family's safe default. Build/package/test
    // tools have longer defaults than a small file or network observation.
    toolTimeoutMs: 0,
    maxToolIterations: 0,
    maxModelCalls: 0,
    noProgressModelCalls: 0,
    contextSearchLimit: 5,
    contextArchiveInjectionLimit: 5,
    contextArchiveInjectionTokens: 900,
    recentMessageLimit: 6,
    maxWorkspaceSnapshotEntries: 20000,
    maxWorkspaceChanges: 1000,
    allowSoloCouncil: false,
    ...(group.settings ?? {})
  };
  group.settings.maxRounds = normalizeOptionalLimit(group.settings.maxRounds);
  // A configured ceiling may constrain the minimum. With no ceiling, retain
  // the requested minimum rather than silently reintroducing a round limit.
  const requestedMinRounds = Math.max(1, Number.parseInt(String(group.settings.minRounds), 10) || 1);
  group.settings.minRounds = group.settings.maxRounds > 0
    ? Math.min(requestedMinRounds, group.settings.maxRounds)
    : requestedMinRounds;
  group.settings.contextSearchLimit = clampInteger(group.settings.contextSearchLimit, 1, 20, 5);
  group.settings.contextArchiveInjectionLimit = clampInteger(group.settings.contextArchiveInjectionLimit, 1, 12, 5);
  group.settings.contextArchiveInjectionTokens = clampInteger(group.settings.contextArchiveInjectionTokens, 120, 4000, 900);
  group.settings.recentMessageLimit = clampInteger(group.settings.recentMessageLimit, 0, 30, 6);
  group.settings.maxToolIterations = normalizeOptionalLimit(group.settings.maxToolIterations);
  group.settings.maxModelCalls = normalizeOptionalLimit(group.settings.maxModelCalls);
  group.settings.noProgressModelCalls = normalizeOptionalLimit(group.settings.noProgressModelCalls);
  group.settings.maxWorkspaceSnapshotEntries = clampInteger(group.settings.maxWorkspaceSnapshotEntries, 100, 100000, 20000);
  group.settings.maxWorkspaceChanges = clampInteger(group.settings.maxWorkspaceChanges, 10, 5000, 1000);

  return group;
}

export function validateRuntimeEnv(group) {
  const missing = new Set();
  const unconfigured = [];
  for (const agent of group.agents.filter((item) => item.enabled)) {
    if (agent.provider === "unconfigured") {
      unconfigured.push(agent.id || agent.name || "unknown");
      continue;
    }
    if (!["openai-compatible", "anthropic-messages"].includes(agent.provider)) continue;
    const credentialPoolId = String(agent.credentialPoolId || agent.credentialPool || "").trim();
    if (!agent.apiKey && agent.apiKeyEnv && !process.env[agent.apiKeyEnv]) missing.add(agent.apiKeyEnv);
    if (!agent.apiKey && !agent.apiKeyEnv && !credentialPoolId) missing.add(`${agent.id}.apiKey`);
    collectEnvReference(agent.apiBaseUrl, missing);
    collectEnvReference(agent.model, missing);
  }

  if (unconfigured.length) {
    throw new Error(`Missing model provider configuration for: ${[...new Set(unconfigured)].sort().join(", ")}. Configure an endpoint, model, and API key before starting the council.`);
  }
  if (missing.size) {
    throw new Error(`Missing required environment variables: ${[...missing].sort().join(", ")}`);
  }
}

function collectEnvReference(value, missing) {
  if (typeof value !== "string" || !value.startsWith("env:")) return;
  const envName = value.slice(4);
  if (!process.env[envName]) missing.add(envName);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeOptionalLimit(value) {
  const number = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number;
}
