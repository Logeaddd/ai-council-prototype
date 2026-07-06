import { scheduleProviderCall } from "./rateLimiter.js";
import { assertSafeApiBaseUrl } from "./apiBaseUrlGuard.js";

export async function callAgent(agent, messages, options = {}) {
  if (agent.provider === "mock") return callMockAgent(agent, messages, options);
  if (agent.provider === "openai-compatible") return callOpenAiCompatible(agent, messages, options);
  if (agent.provider === "anthropic-messages") return callAnthropicMessages(agent, messages, options);
  throw new Error(`Unsupported provider: ${agent.provider}`);
}

async function callOpenAiCompatible(agent, messages, options) {
  const apiKey = agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : "");
  if (!apiKey) throw new Error(`Missing API key for agent: ${agent.id}`);
  const apiBaseUrl = await assertSafeApiBaseUrl(resolveMaybeEnv(agent.apiBaseUrl), {
    allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork || agent.allowUnsafePrivateNetwork)
  });
  const model = resolveMaybeEnv(agent.model);
  const maxRetries = normalizeRetryCount(agent.retry?.maxRetries ?? agent.rateLimit?.maxRetries ?? options.maxRetries ?? 1);
  const backoffMs = normalizeBackoffMs(agent.retry?.backoffMs ?? agent.rateLimit?.backoffMs ?? options.backoffMs ?? 250);

  return await scheduleProviderCall(agent, messages, async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await callOpenAiCompatibleOnce({
          agent,
          apiBaseUrl,
          apiKey,
          model,
          messages,
          options
        });
      } catch (error) {
        if (error.name === "AbortError" || attempt >= maxRetries || !isRetryableError(error)) {
          throw error;
        }
        await sleep(backoffMs * (2 ** attempt), options.signal);
      }
    }
  }, options);
}

async function callAnthropicMessages(agent, messages, options) {
  const apiKey = agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : "");
  if (!apiKey) throw new Error(`Missing API key for agent: ${agent.id}`);
  const apiBaseUrl = await assertSafeApiBaseUrl(resolveMaybeEnv(agent.apiBaseUrl), {
    allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork || agent.allowUnsafePrivateNetwork)
  });
  const model = resolveMaybeEnv(agent.model);
  if (!model) throw new Error(`Missing model for agent: ${agent.id}`);
  const maxRetries = normalizeRetryCount(agent.retry?.maxRetries ?? agent.rateLimit?.maxRetries ?? options.maxRetries ?? 1);
  const backoffMs = normalizeBackoffMs(agent.retry?.backoffMs ?? agent.rateLimit?.backoffMs ?? options.backoffMs ?? 250);

  return await scheduleProviderCall(agent, messages, async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await callAnthropicMessagesOnce({
          agent,
          apiBaseUrl,
          apiKey,
          model,
          messages,
          options
        });
      } catch (error) {
        if (error.name === "AbortError" || attempt >= maxRetries || !isRetryableError(error)) {
          throw error;
        }
        await sleep(backoffMs * (2 ** attempt), options.signal);
      }
    }
  }, options);
}

async function callAnthropicMessagesOnce({ agent, apiBaseUrl, apiKey, model, messages, options }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  const payload = buildAnthropicMessagesPayload(agent, {
    model,
    messages
  });
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": agent.anthropicVersion || "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw await httpError(response);
    const parsed = await response.json();
    const text = readAnthropicText(parsed);
    if (text) options.onDelta?.(text);
    return text;
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

async function callOpenAiCompatibleOnce({ agent, apiBaseUrl, apiKey, model, messages, options }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  const payload = buildOpenAiCompatiblePayload(agent, {
    model,
    messages
  });
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw await httpError(response);
    return await readOpenAiStream(response, options.onDelta);
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

export function buildOpenAiCompatiblePayload(agent, { model, messages }) {
  return {
    model,
    messages: applyProviderPromptCache(agent, messages),
    max_tokens: normalizeMaxTokens(agent.maxTokens ?? agent.max_tokens ?? 4096),
    temperature: 0.2,
    stream: true
  };
}

export function buildAnthropicMessagesPayload(agent, { model, messages }) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => stringifyMessageContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: stringifyMessageContent(message.content)
    }))
    .filter((message) => message.content);

  return {
    model,
    ...(system ? { system } : {}),
    messages: anthropicMessages.length ? anthropicMessages : [{ role: "user", content: "" }],
    max_tokens: normalizeMaxTokens(agent.maxTokens ?? agent.max_tokens ?? 4096),
    temperature: 0.2
  };
}

function readAnthropicText(payload) {
  if (typeof payload?.content === "string") return payload.content;
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .map((block) => block?.type === "text" ? block.text || "" : "")
    .join("");
}

function stringifyMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content
    .map((part) => typeof part === "string" ? part : part?.text || "")
    .join("");
}

function normalizeMaxTokens(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 4096;
  return Math.max(1, Math.min(64000, Math.floor(count)));
}

function applyProviderPromptCache(agent = {}, messages = []) {
  const config = agent.providerPromptCache || agent.promptCache || {};
  if (!config.enabled) return messages;
  if (!["content-block-cache-control", "anthropic-cache-control"].includes(config.mode)) return messages;

  const type = config.type || "ephemeral";
  return messages.map((message, index) => {
    if (index !== findQuestionMessageIndex(messages) || typeof message.content !== "string") return message;
    const split = splitAfterOriginalQuestion(message.content);
    if (!split) return message;
    return {
      ...message,
      content: [
        {
          type: "text",
          text: split.stablePrefix,
          cache_control: { type }
        },
        {
          type: "text",
          text: split.volatileSuffix
        }
      ]
    };
  });
}

function findQuestionMessageIndex(messages) {
  return messages.findIndex((message) => typeof message.content === "string" && message.content.startsWith("Question: "));
}

function splitAfterOriginalQuestion(content) {
  const marker = "\n\nRound:";
  const index = content.indexOf(marker);
  if (index < 0) return undefined;
  return {
    stablePrefix: content.slice(0, index),
    volatileSuffix: content.slice(index + 2)
  };
}

async function httpError(response) {
  const body = await response.text();
  const error = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  error.status = response.status;
  return error;
}

async function readOpenAiStream(response, onDelta) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const delta = parseOpenAiStreamFrame(frame);
      if (!delta) continue;
      content += delta;
      onDelta?.(delta);
    }
  }

  if (buffer.trim()) {
    const delta = parseOpenAiStreamFrame(buffer);
    if (delta) {
      content += delta;
      onDelta?.(delta);
    }
  }

  return content;
}

function parseOpenAiStreamFrame(frame) {
  const dataLines = String(frame)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  let text = "";
  for (const data of dataLines) {
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      text += parsed?.choices?.[0]?.delta?.content || "";
    } catch {
      // Ignore malformed stream frames; final parsing will handle incomplete JSON.
    }
  }
  return text;
}

function resolveMaybeEnv(value) {
  if (typeof value === "string" && value.startsWith("env:")) {
    const envName = value.slice(4);
    const resolved = process.env[envName];
    if (!resolved) throw new Error(`Missing env var: ${envName}`);
    return resolved;
  }
  return value;
}

function isRetryableError(error) {
  return [429, 500, 502, 503, 504].includes(Number(error.status));
}

function normalizeRetryCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 1;
  return Math.max(0, Math.min(3, Math.floor(count)));
}

function normalizeBackoffMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return 250;
  return Math.max(0, Math.min(5000, Math.floor(ms)));
}

async function callMockAgent(agent, messages, options) {
  await sleep(Math.min(50, options.timeoutMs ?? 50), options.signal);
  const prompt = messages.at(-1)?.content ?? "";
  const round = Number(prompt.match(/Round:\s*(\d+)/)?.[1] ?? 1);
  const isFinalPrompt = messages[0]?.content?.includes("FinalDecision JSON object");

  if (isFinalPrompt) {
    return emitMockText(JSON.stringify({
      answer: "Proceed with a CLI-first prototype, because it validates the core council loop before UI work.",
      consensus_score: 1,
      supporting_agents: ["Builder", "Judge"],
      dissenting_agents: ["Critic / Red Team"],
      minority_report: "The main dissent is that multi-agent debate can create false confidence unless Red Team objections are preserved.",
      risks: ["False convergence", "Slow or failing provider endpoints", "Memory pollution without user approval"],
      next_actions: ["Keep default weights equal", "Implement Red Team first-round speak rule", "Write sessions and pending memory locally"],
      memory_candidates: ["The user wants a Codex/Claude shared harness for the AI council project."]
    }), options);
  }

  if (agent.judge) {
    if (round > 1) {
      return emitMockText(JSON.stringify({
        status: "skip",
        reason: "No new objection after Red Team dissent is preserved for final synthesis."
      }), options);
    }
    return emitMockText(JSON.stringify({
      status: "speak",
      position: "support_with_caution",
      argument: "The current direction is sound as long as the final synthesis preserves Red Team dissent.",
      objections: [],
      suggested_revision: "Use a dedicated final Judge call after the discussion loop.",
      confidence: 0.82,
      memory_candidates: []
    }), options);
  }

  if (agent.mandatoryRedTeam) {
    return emitMockText(JSON.stringify({
      status: "speak",
      position: "skeptical",
      argument: "The prototype is worth building, but it must not claim debate automatically improves truth.",
      objections: round === 1 ? ["False convergence risk", "Provider timeout risk"] : ["Keep dissent visible in final output"],
      suggested_revision: "Treat Red Team dissent as preserved context rather than a blocker.",
      confidence: 0.78,
      memory_candidates: []
    }), options);
  }

  if (round > 1) {
    return emitMockText(JSON.stringify({
      status: "skip",
      reason: "No new objection after Red Team concerns are preserved."
    }), options);
  }

  return emitMockText(JSON.stringify({
    status: "speak",
    position: "support",
    argument: "A CLI-first prototype is the fastest way to validate configuration, discussion, consensus, and memory queues.",
    objections: [],
    suggested_revision: "Keep the first version local and inspectable.",
    confidence: 0.84,
    memory_candidates: ["P0 should stay CLI-first until the core loop works."]
  }), options);
}

function emitMockText(text, options = {}) {
  if (options.onDelta) {
    for (const chunk of String(text).match(/.{1,24}/gs) || []) {
      options.onDelta(chunk);
    }
  }
  return text;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
