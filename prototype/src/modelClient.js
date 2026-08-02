import { scheduleProviderCall } from "./rateLimiter.js";
import { assertSafeApiBaseUrl } from "./apiBaseUrlGuard.js";
import { anthropicToolDefinitions, openAiToolDefinitions } from "./nativeToolProtocol.js";
import { recordCredentialPoolOutcome, resolveCredentialCandidates } from "./credentialVault.js";

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
  const credentials = resolveAgentCredentials(agent);
  const apiBaseUrl = await assertSafeApiBaseUrl(resolveMaybeEnv(agent.apiBaseUrl), {
    allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork || agent.allowUnsafePrivateNetwork)
  });
  const model = resolveMaybeEnv(agent.model);
  const maxRetries = normalizeRetryCount(agent.retry?.maxRetries ?? agent.rateLimit?.maxRetries ?? options.maxRetries ?? 3);
  const backoffMs = normalizeBackoffMs(agent.retry?.backoffMs ?? agent.rateLimit?.backoffMs ?? options.backoffMs ?? 1000);

  return await scheduleProviderCall(agent, messages, () => callWithCredentialCandidates({
    agent,
    credentials,
    options,
    call: (apiKey, callOptions) => callOpenAiCompatibleOnce({ agent, apiBaseUrl, apiKey, model, messages, options: callOptions }),
    maxRetries,
    backoffMs
  }), options);
}

async function callAnthropicMessages(agent, messages, options) {
  const credentials = resolveAgentCredentials(agent);
  const apiBaseUrl = await assertSafeApiBaseUrl(resolveMaybeEnv(agent.apiBaseUrl), {
    allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork || agent.allowUnsafePrivateNetwork)
  });
  const model = resolveMaybeEnv(agent.model);
  if (!model) throw new Error(`Missing model for agent: ${agent.id}`);
  const maxRetries = normalizeRetryCount(agent.retry?.maxRetries ?? agent.rateLimit?.maxRetries ?? options.maxRetries ?? 3);
  const backoffMs = normalizeBackoffMs(agent.retry?.backoffMs ?? agent.rateLimit?.backoffMs ?? options.backoffMs ?? 1000);

  return await scheduleProviderCall(agent, messages, () => callWithCredentialCandidates({
    agent,
    credentials,
    options,
    call: (apiKey, callOptions) => callAnthropicMessagesOnce({ agent, apiBaseUrl, apiKey, model, messages, options: callOptions }),
    maxRetries,
    backoffMs
  }), options);
}

async function callWithCredentialCandidates({ agent, credentials, options, call, maxRetries, backoffMs }) {
  let lastFailoverError;
  for (const credential of credentials) {
    try {
      const result = await callWithRetries({ credential, options, call, maxRetries, backoffMs });
      recordCredentialOutcome(credential, { status: "success" }, options);
      return {
        ...result,
        credential: publicCredentialEvent(credential, "success")
      };
    } catch (error) {
      const category = credentialFailureCategory(error);
      if (!credential.poolId || !category) throw error;
      recordCredentialOutcome(credential, { status: "failed", category }, options);
      lastFailoverError = error;
    }
  }
  const error = new Error(`All credential-pool keys are temporarily unavailable for agent: ${agent.id || "unknown"}.`);
  error.code = "credential_pool_exhausted";
  error.cause = lastFailoverError;
  throw error;
}

async function callWithRetries({ credential, options, call, maxRetries, backoffMs }) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await call(credential.apiKey, options);
    } catch (error) {
      if (options.nativeTools?.length && isNativeToolUnsupported(error)) {
        return await call(credential.apiKey, { ...options, nativeTools: [] });
      }
      if (error.name === "AbortError" || attempt >= maxRetries || !isRetryableError(error)) throw error;
      await sleep(backoffMs * (2 ** attempt), options.signal);
    }
  }
  throw new Error("Provider retry loop ended unexpectedly.");
}

function resolveAgentCredentials(agent = {}) {
  const poolId = String(agent.credentialPoolId || agent.credentialPool || "").trim();
  if (poolId) return resolveCredentialCandidates(poolId).candidates;
  const apiKey = agent.apiKey || (agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : "");
  if (!apiKey) throw new Error(`Missing API key for agent: ${agent.id}`);
  return [{ apiKey, fingerprint: "inline", source: "agent", poolId: "" }];
}

function recordCredentialOutcome(credential, outcome, options = {}) {
  if (!credential.poolId) return;
  try {
    recordCredentialPoolOutcome(credential.poolId, credential.fingerprint, outcome);
  } catch {
    // The provider call succeeded or already failed independently. Vault audit
    // persistence must not convert that fact into a false task failure.
  }
  try {
    options.onCredentialEvent?.(publicCredentialEvent(credential, outcome.status, outcome.category));
  } catch {
    // Observability callbacks are intentionally best-effort.
  }
}

function publicCredentialEvent(credential = {}, status = "", category = "") {
  return {
    source: credential.source || "",
    poolId: credential.poolId || "",
    fingerprint: credential.fingerprint || "",
    status,
    category: category || ""
  };
}

function credentialFailureCategory(error) {
  const status = Number(error?.status);
  const message = String(error?.message || "").toLowerCase();
  if ([401, 403].includes(status)) return "authentication";
  if (status === 402 || /insufficient[_ ]?(balance|quota)|quota[_ ]?exceeded|billing/.test(message)) return "quota";
  if (status === 429) return "rate_limit";
  if ([500, 502, 503, 504].includes(status) || error?.code === "stream_idle_timeout" || error?.name === "TypeError") return "transient";
  return "";
}

async function callAnthropicMessagesOnce({ agent, apiBaseUrl, apiKey, model, messages, options }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  const payload = buildAnthropicMessagesPayload(agent, {
    model,
    messages,
    nativeTools: options.nativeTools,
    nativeToolChoice: options.nativeToolChoice,
    nativeToolConversation: options.nativeToolConversation
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
    const nativeToolCalls = normalizeNativeToolCallIds(readAnthropicToolCalls(parsed));
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
  const idleTimeoutMs = resolveStreamIdleTimeoutMs(agent, options);
  let idleTimeout;
  let idleTimedOut = false;
  const resetIdleTimeout = () => {
    if (!idleTimeoutMs) return;
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const payload = buildOpenAiCompatiblePayload(agent, {
    model,
    messages,
    nativeTools: options.nativeTools,
    nativeToolChoice: options.nativeToolChoice,
    nativeToolConversation: options.nativeToolConversation
  });
  try {
    resetIdleTimeout();
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
    resetIdleTimeout();
    return await readOpenAiStream(response, options.onDelta, resetIdleTimeout);
  } catch (error) {
    if (idleTimedOut) throw streamIdleTimeoutError(idleTimeoutMs);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
    clearTimeout(idleTimeout);
  }
}

export function buildOpenAiCompatiblePayload(agent, { model, messages, nativeTools, nativeToolChoice, nativeToolConversation }) {
  const maxTokens = requestedMaxTokens(agent);
  return {
    model,
    messages: applyProviderPromptCache(agent, appendOpenAiNativeToolTurns(messages, nativeToolConversation)),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    temperature: 0.2,
    stream: true,
    ...(nativeTools?.length ? { tools: openAiToolDefinitions(nativeTools), tool_choice: nativeToolChoice === "required" ? "required" : "auto" } : {}),
    ...openAiReasoningPayload(agent, model)
  };
}

export function buildAnthropicMessagesPayload(agent, { model, messages, nativeTools, nativeToolChoice, nativeToolConversation }) {
  const providerMessages = appendAnthropicNativeToolTurns(messages, nativeToolConversation);
  const system = providerMessages
    .filter((message) => message.role === "system")
    .map((message) => stringifyMessageContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const anthropicMessages = providerMessages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: isAnthropicContentBlocks(message.content)
        ? message.content
        : stringifyMessageContent(message.content)
    }))
    .filter((message) => message.content);

  const maxTokens = requestedMaxTokens(agent)
    || normalizeMaxTokens(agent.providerLimits?.maxOutputTokens)
    || normalizeMaxTokens(agent.tokenLimits?.maxOutputTokensPerCall)
    || 64000;
  return {
    model,
    ...(system ? { system } : {}),
    messages: anthropicMessages.length ? anthropicMessages : [{ role: "user", content: "" }],
    max_tokens: maxTokens,
    temperature: 0.2,
    ...(nativeTools?.length ? {
      tools: anthropicToolDefinitions(nativeTools),
      ...(nativeToolChoice === "required" ? { tool_choice: { type: "any" } } : {})
    } : {}),
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
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return Math.max(1, Math.floor(count));
}

function requestedMaxTokens(agent = {}) {
  return normalizeMaxTokens(agent.maxTokens ?? agent.max_tokens);
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

async function readOpenAiStream(response, onDelta, onActivity = undefined) {
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
    onActivity?.();
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

  return { text: content, nativeToolCalls: normalizeNativeToolCallIds([...toolCalls.values()]), usage };
}

function appendOpenAiNativeToolTurns(messages = [], conversation = undefined) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  if (!turns.length) return messages;
  const splitAt = nativeConversationSplit(messages, conversation);
  const base = messages.slice(0, splitAt);
  const tail = messages.slice(splitAt);
  return [...base, ...turns.flatMap(openAiNativeToolTurnMessages), ...tail];
}

function openAiNativeToolTurnMessages(turn = {}) {
  const calls = normalizeNativeToolCallIds(turn.toolCalls);
  if (!calls.length) return [];
  const assistant = {
    role: "assistant",
    content: String(turn.text || "") || null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.input || {})
      }
    }))
  };
  const results = calls.map((call) => ({
    role: "tool",
    tool_call_id: call.id,
    content: serializeNativeToolResult(nativeResultForCall(turn, call))
  }));
  return [assistant, ...results];
}

function appendAnthropicNativeToolTurns(messages = [], conversation = undefined) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  if (!turns.length) return messages;
  const splitAt = nativeConversationSplit(messages, conversation);
  const base = messages.slice(0, splitAt);
  const tail = messages.slice(splitAt);
  const nativeMessages = turns.flatMap((turn) => {
    const calls = normalizeNativeToolCallIds(turn.toolCalls);
    if (!calls.length) return [];
    const content = [];
    if (turn.text) content.push({ type: "text", text: String(turn.text) });
    content.push(...calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseNativeToolArguments(call)
    })));
    return [{
      role: "assistant",
      content
    }, {
      role: "user",
      content: calls.map((call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: serializeNativeToolResult(nativeResultForCall(turn, call))
      }))
    }];
  });
  return [...base, ...nativeMessages, ...tail];
}

function nativeConversationSplit(messages = [], conversation = {}) {
  const requested = Number(conversation.baseMessageCount);
  if (!Number.isFinite(requested)) return messages.length;
  return Math.max(0, Math.min(messages.length, Math.floor(requested)));
}

function nativeResultForCall(turn = {}, call = {}) {
  const candidates = Array.isArray(turn.toolResults) ? turn.toolResults : [];
  return candidates.find((item) => String(item?.id || "") === String(call.id || "")) || {
    id: call.id,
    tool: call.name,
    status: "failed",
    code: "missing_tool_result",
    error: "The tool call finished without a result record."
  };
}

function serializeNativeToolResult(record = {}) {
  const payload = {
    id: record.id || "",
    tool: record.tool || "",
    status: record.status || "failed",
    code: record.code || "",
    error: record.error || "",
    result: record.result
  };
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = JSON.stringify({ ...payload, result: "[unserializable tool result]" });
  }
  const maxChars = 60000;
  if (serialized.length <= maxChars) return serialized;
  return JSON.stringify({
    id: payload.id,
    tool: payload.tool,
    status: payload.status,
    code: payload.code,
    error: payload.error,
    truncated: true,
    resultPreview: serialized.slice(0, maxChars - 500)
  });
}

function parseNativeToolArguments(call = {}) {
  if (call.input && typeof call.input === "object" && !Array.isArray(call.input)) return call.input;
  if (typeof call.arguments !== "string" || !call.arguments.trim()) return {};
  try {
    const parsed = JSON.parse(call.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isAnthropicContentBlocks(content) {
  return Array.isArray(content) && content.every((block) => block && typeof block === "object" && typeof block.type === "string");
}

function normalizeNativeToolCallIds(calls = []) {
  const used = new Set();
  return (Array.isArray(calls) ? calls : []).map((call, index) => {
    const base = String(call?.id || "").trim() || `native_tool_${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}_${suffix++}`;
    used.add(id);
    return { ...call, id };
  });
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
  if (error?.retryable === true || error?.code === "stream_idle_timeout") return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status))) return true;
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code]
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);
  if (codes.some((code) => /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_INVALID_URL/.test(code))) return false;
  const transientCodes = new Set([
    "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "EAI_AGAIN", "ENETDOWN", "ENETRESET", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET", "UND_ERR_ABORTED"
  ]);
  if (codes.some((code) => transientCodes.has(code))) return true;
  return error instanceof TypeError && /^fetch failed$/i.test(String(error.message || "").trim());
}

function resolveStreamIdleTimeoutMs(agent = {}, options = {}) {
  const configured = options.streamIdleTimeoutMs
    ?? agent.streamIdleTimeoutMs
    ?? agent.providerLimits?.streamIdleTimeoutMs;
  if (configured === 0 || configured === "0") return 0;
  const value = Number(configured);
  if (!Number.isFinite(value)) return 120000;
  return Math.max(1000, Math.min(15 * 60 * 1000, Math.floor(value)));
}

function streamIdleTimeoutError(timeoutMs) {
  const error = new Error(`stream_idle_timeout:${timeoutMs}ms`);
  error.code = "stream_idle_timeout";
  error.retryable = true;
  return error;
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
      ...mockTaskContractForRound(agent, round),
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
      ...mockTaskContractForRound(agent, round),
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
    ...mockTaskContractForRound(agent, round),
    confidence: 0.84,
    memory_candidates: ["P0 should stay CLI-first until the core loop works."]
  }), options);
}

function mockTaskContractForRound(agent, round) {
  if (round !== 1) return {};
  if (agent.mockTaskContract) return { task_contract: agent.mockTaskContract };
  // The deterministic mock is a protocol fixture, so it must comply with the
  // same intake contract as a real Provider. Its default task is discussion;
  // delivery-specific tests declare mockTaskContract explicitly.
  return {
    task_contract: {
      mode: "discussion",
      objective: "Discuss the user's request without carrying out workspace work.",
      requires_workspace: false,
      requires_verification: false,
      deliverables: [],
      completion_criteria: ["Provide a substantive answer grounded in the available context."],
      next_action: "Contribute the current analysis to the group discussion."
    }
  };
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
