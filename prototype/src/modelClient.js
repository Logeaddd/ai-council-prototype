import { scheduleProviderCall } from "./rateLimiter.js";
import { assertSafeApiBaseUrl } from "./apiBaseUrlGuard.js";
import { anthropicToolDefinitions, openAiToolDefinitions } from "./nativeToolProtocol.js";

export async function callAgent(agent, messages, options = {}) {
  const result = await callAgentResult(agent, messages, options);
  return result.text;
}

export async function callAgentResult(agent, messages, options = {}) {
  if (agent.provider === "mock") return { text: await callMockAgent(agent, messages, options), nativeToolCalls: [] };
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
        if (options.nativeTools?.length && isNativeToolUnsupported(error)) {
          return await callOpenAiCompatibleOnce({ agent, apiBaseUrl, apiKey, model, messages, options: { ...options, nativeTools: [] } });
        }
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
        if (options.nativeTools?.length && isNativeToolUnsupported(error)) {
          return await callAnthropicMessagesOnce({ agent, apiBaseUrl, apiKey, model, messages, options: { ...options, nativeTools: [] } });
        }
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
    messages,
    nativeTools: options.nativeTools
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
    const nativeToolCalls = readAnthropicToolCalls(parsed);
    if (text) options.onDelta?.(text);
    return { text, nativeToolCalls, usage: normalizeProviderUsage(parsed.usage) };
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
    messages,
    nativeTools: options.nativeTools
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

export function buildOpenAiCompatiblePayload(agent, { model, messages, nativeTools }) {
  return {
    model,
    messages: applyProviderPromptCache(agent, messages),
    max_tokens: normalizeMaxTokens(agent.maxTokens ?? agent.max_tokens ?? 4096),
    temperature: 0.2,
    stream: true,
    ...(nativeTools?.length ? { tools: openAiToolDefinitions(nativeTools), tool_choice: "auto" } : {}),
    ...openAiReasoningPayload(agent, model)
  };
}

export function buildAnthropicMessagesPayload(agent, { model, messages, nativeTools }) {
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

  const maxTokens = normalizeMaxTokens(agent.maxTokens ?? agent.max_tokens ?? 4096);
  return {
    model,
    ...(system ? { system } : {}),
    messages: anthropicMessages.length ? anthropicMessages : [{ role: "user", content: "" }],
    max_tokens: maxTokens,
    temperature: 0.2,
    ...(nativeTools?.length ? { tools: anthropicToolDefinitions(nativeTools) } : {}),
    ...anthropicThinkingPayload(agent, model, maxTokens)
  };
}

function openAiReasoningPayload(agent = {}, model = "") {
  const effort = normalizeReasoningEffort(agent.reasoningEffort ?? agent.reasoning?.effort);
  if (!effort) return {};
  if (!supportsOpenAiReasoningEffort(agent, model)) return {};
  return { reasoning_effort: effort };
}

function anthropicThinkingPayload(agent = {}, model = "", maxTokens = 4096) {
  const effort = normalizeReasoningEffort(agent.reasoningEffort ?? agent.reasoning?.effort);
  if (!effort) return {};
  if (!supportsAnthropicThinking(agent, model)) return {};
  const budget = anthropicThinkingBudget(effort, maxTokens);
  if (!budget) return {};
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(effort)) return effort;
  return "";
}

function supportsOpenAiReasoningEffort(agent = {}, model = "") {
  const preset = String(agent.providerPreset || agent.providerId || "").toLowerCase();
  const baseUrl = String(agent.apiBaseUrl || "").toLowerCase();
  const name = String(model || agent.model || "").toLowerCase();
  const officialOpenAi = preset === "openai" || baseUrl.includes("api.openai.com");
  if (!officialOpenAi) return false;
  return /^(o1|o3|o4|gpt-5|gpt-oss)\b/.test(name);
}

function supportsAnthropicThinking(agent = {}, model = "") {
  const preset = String(agent.providerPreset || agent.providerId || "").toLowerCase();
  const baseUrl = String(agent.apiBaseUrl || "").toLowerCase();
  const name = String(model || agent.model || "").toLowerCase();
  const officialAnthropic = preset === "anthropic" || baseUrl.includes("api.anthropic.com");
  if (!officialAnthropic) return false;
  return /^claude-(3-7|4|opus-4|sonnet-4)/.test(name);
}

function anthropicThinkingBudget(effort, maxTokens) {
  const requested = effort === "low" ? 1024 : effort === "medium" ? 4096 : 8192;
  const ceiling = Math.max(0, Number(maxTokens) - 1);
  const budget = Math.min(requested, ceiling);
  return budget >= 1024 ? budget : 0;
}

function readAnthropicText(payload) {
  if (typeof payload?.content === "string") return payload.content;
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .map((block) => block?.type === "text" ? block.text || "" : "")
    .join("");
}

function readAnthropicToolCalls(payload) {
  if (!Array.isArray(payload?.content)) return [];
  return payload.content
    .filter((block) => block?.type === "tool_use" && block.name)
    .map((block) => ({ id: String(block.id || ""), name: String(block.name), input: block.input || {} }));
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
  if (!response.body) return { text: "", nativeToolCalls: [], usage: undefined };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = new Map();
  let usage;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const delta = parseOpenAiStreamFrame(frame);
      if (!delta) continue;
      if (delta.text) {
        content += delta.text;
        onDelta?.(delta.text);
      }
      mergeOpenAiToolCallDeltas(toolCalls, delta.toolCalls);
      usage = delta.usage || usage;
    }
  }

  if (buffer.trim()) {
    const delta = parseOpenAiStreamFrame(buffer);
    if (delta) {
      if (delta.text) {
        content += delta.text;
        onDelta?.(delta.text);
      }
      mergeOpenAiToolCallDeltas(toolCalls, delta.toolCalls);
      usage = delta.usage || usage;
    }
  }

  return { text: content, nativeToolCalls: [...toolCalls.values()], usage };
}

function parseOpenAiStreamFrame(frame) {
  const dataLines = String(frame)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  let text = "";
  const toolCalls = [];
  let usage;
  for (const data of dataLines) {
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta || {};
      usage = normalizeProviderUsage(parsed.usage) || usage;
      text += delta.content || "";
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        toolCalls.push({
          index: Number(call.index) || 0,
          id: String(call.id || ""),
          name: String(call.function?.name || ""),
          arguments: String(call.function?.arguments || "")
        });
      }
    } catch {
      // Ignore malformed stream frames; final parsing will handle incomplete JSON.
    }
  }
  return { text, toolCalls, usage };
}

function mergeOpenAiToolCallDeltas(target, deltas = []) {
  for (const delta of deltas || []) {
    const key = Number(delta.index) || 0;
    const current = target.get(key) || { id: "", name: "", arguments: "" };
    current.id ||= delta.id;
    current.name ||= delta.name;
    current.arguments += delta.arguments || "";
    target.set(key, current);
  }
}

function normalizeProviderUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = Number(value.prompt_tokens ?? value.input_tokens);
  const outputTokens = Number(value.completion_tokens ?? value.output_tokens);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return undefined;
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(Number(value.total_tokens))
      ? Number(value.total_tokens)
      : (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)
  };
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

function isNativeToolUnsupported(error) {
  return [400, 404, 422].includes(Number(error?.status)) && /tool|function/i.test(String(error?.message || ""));
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
