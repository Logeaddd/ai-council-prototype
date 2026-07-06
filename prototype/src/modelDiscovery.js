import { findProviderPreset, resolveProviderBaseUrl } from "./providerRegistry.js";

import { assertSafeApiBaseUrl } from "./apiBaseUrlGuard.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function discoverProviderModels(options = {}) {
  const providerId = options.providerId || "custom";
  const preset = findProviderPreset(providerId);
  let apiBaseUrl = resolveProviderBaseUrl(providerId, options.apiBaseUrl);
  const timeoutMs = normalizeTimeout(options.timeoutMs || 8000);

  if (!apiBaseUrl) {
    return {
      ok: false,
      source: "error",
      providerId,
      apiBaseUrl,
      models: [],
      error: "Missing API base URL."
    };
  }

  try {
    apiBaseUrl = await assertSafeApiBaseUrl(apiBaseUrl, {
      allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork)
    });
  } catch (error) {
    return {
      ok: false,
      source: "error",
      providerId,
      apiBaseUrl,
      models: [],
      error: error.message
    };
  }

  const cacheKey = JSON.stringify({ providerId, apiBaseUrl, endpoint: preset.modelsEndpoint || "/models" });
  const cached = readCache(cacheKey);
  if (cached && options.useCache !== false) return { ...cached, source: "cache" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(modelsUrl(apiBaseUrl, preset.modelsEndpoint), {
      method: "GET",
      signal: controller.signal,
      headers: authHeaders(options.apiKey, preset)
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        source: "real_response",
        providerId,
        apiBaseUrl,
        models: [],
        status: response.status,
        error: modelDiscoveryError(response.status, text)
      };
    }
    if (looksLikeHtml(text)) {
      return {
        ok: false,
        source: "real_response",
        providerId,
        apiBaseUrl,
        models: [],
        status: response.status,
        error: modelDiscoveryError(response.status, text)
      };
    }
    const parsed = text ? JSON.parse(text) : {};
    const models = parseModelList(parsed);
    const result = {
      ok: true,
      source: "real_response",
      providerId,
      apiBaseUrl,
      models,
      status: response.status,
      defaultModel: preset.defaultModel || models[0]?.id || ""
    };
    writeCache(cacheKey, result);
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        ok: false,
        source: "timeout_inference",
        providerId,
        apiBaseUrl,
        models: [],
        error: `Timed out after ${timeoutMs}ms.`
      };
    }
    return {
      ok: false,
      source: "error",
      providerId,
      apiBaseUrl,
      models: [],
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkProviderHealth(options = {}) {
  const result = await discoverProviderModels(options);
  return {
    ok: result.ok,
    source: result.source,
    providerId: result.providerId,
    apiBaseUrl: result.apiBaseUrl,
    status: result.status,
    modelCount: result.models.length,
    defaultModel: result.defaultModel || "",
    error: result.error || ""
  };
}

export function clearModelDiscoveryCache() {
  cache.clear();
}

function modelsUrl(apiBaseUrl, endpoint = "/models") {
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${suffix}`;
}

function authHeaders(apiKey, preset = {}) {
  const headers = { Accept: "application/json" };
  const key = String(apiKey || "").trim();
  if (key && preset.transport === "anthropic-messages") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = preset.anthropicVersion || "2023-06-01";
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function parseModelList(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw
    .map((item) => typeof item === "string" ? { id: item } : { id: item.id || item.name || "", owned_by: item.owned_by || item.owner || "" })
    .filter((item) => item.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function modelDiscoveryError(status, text = "") {
  if (status === 401 || status === 403) {
    return "密钥无效、权限不足，或该接口不允许拉取模型列表。";
  }
  const trimmed = String(text || "").trim();
  if (looksLikeHtml(trimmed)) {
    return "接口返回了网页，不是模型 API。中转地址通常需要填到 /v1。";
  }
  return trimmed.slice(0, 500);
}

function looksLikeHtml(text = "") {
  const trimmed = String(text || "").trim();
  return /^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed);
}

function readCache(key) {
  const item = cache.get(key);
  if (!item) return undefined;
  if (Date.now() - item.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return item.value;
}

function writeCache(key, value) {
  cache.set(key, { cachedAt: Date.now(), value });
}

function normalizeTimeout(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return 8000;
  return Math.max(100, Math.min(30000, Math.floor(ms)));
}
