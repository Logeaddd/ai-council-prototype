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
    for (const key of ["id", "name", "role", "provider", "apiBaseUrl", "model"]) {
      if (!agent[key]) throw new Error(`Agent ${agent.id ?? "(unknown)"} missing ${key}`);
    }
    if (typeof agent.weight !== "number" || agent.weight <= 0) {
      throw new Error(`Agent ${agent.id} needs positive numeric weight`);
    }
  }

  group.settings = {
    maxRounds: 3,
    minRounds: 1,
    minConsensusWeight: 0.75,
    stopWhenAllSkip: true,
    agentTimeoutMs: 900000,
    toolTimeoutMs: 12000,
    maxToolIterations: 12,
    contextSearchLimit: 5,
    contextArchiveInjectionLimit: 5,
    contextArchiveInjectionTokens: 900,
    recentMessageLimit: 6,
    allowSoloCouncil: false,
    ...(group.settings ?? {})
  };
  // Keep minRounds reachable so maxRounds remains the hard stop.
  group.settings.minRounds = Math.max(1, Math.min(Number(group.settings.minRounds) || 1, Number(group.settings.maxRounds) || 1));
  group.settings.contextSearchLimit = clampInteger(group.settings.contextSearchLimit, 1, 20, 5);
  group.settings.contextArchiveInjectionLimit = clampInteger(group.settings.contextArchiveInjectionLimit, 1, 12, 5);
  group.settings.contextArchiveInjectionTokens = clampInteger(group.settings.contextArchiveInjectionTokens, 120, 4000, 900);
  group.settings.recentMessageLimit = clampInteger(group.settings.recentMessageLimit, 0, 30, 6);
  group.settings.maxToolIterations = clampInteger(group.settings.maxToolIterations, 0, 24, 12);

  return group;
}

export function validateRuntimeEnv(group) {
  const missing = new Set();
  for (const agent of group.agents.filter((item) => item.enabled)) {
    if (!["openai-compatible", "anthropic-messages"].includes(agent.provider)) continue;
    if (!agent.apiKey && agent.apiKeyEnv && !process.env[agent.apiKeyEnv]) missing.add(agent.apiKeyEnv);
    if (!agent.apiKey && !agent.apiKeyEnv) missing.add(`${agent.id}.apiKey`);
    collectEnvReference(agent.apiBaseUrl, missing);
    collectEnvReference(agent.model, missing);
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
