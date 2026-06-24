import { findProviderPreset, resolveProviderBaseUrl } from "./providerRegistry.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function discoverProviderModels(options = {}) {
  const providerId = options.providerId || "custom";
  const preset = findProviderPreset(providerId);
  const apiBaseUrl = resolveProviderBaseUrl(providerId, options.apiBaseUrl);
  const timeoutMs = normalizeTimeout(options.timeoutMs || 8000);
  const cacheKey = JSON.stringify({ providerId, apiBaseUrl, endpoint: preset.modelsEndpoint || "/models" });
  const cached = readCache(cacheKey);
  if (cached && options.useCache !== false) return { ...cached, source: "cache" };

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(modelsUrl(apiBaseUrl, preset.modelsEndpoint), {
      method: "GET",
      signal: controller.signal,
      headers: authHeaders(options.apiKey)
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
        error: text.slice(0, 500)
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
  const result = await discoverProviderModels({ ...options, useCache: options.useCache });
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

function authHeaders(apiKey) {
  const headers = { Accept: "application/json" };
  const key = String(apiKey || "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function parseModelList(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw
    .map((item) => typeof item === "string" ? { id: item } : { id: item.id || item.name || "", owned_by: item.owned_by || item.owner || "" })
    .filter((item) => item.id)
    .sort((a, b) => a.id.localeCompare(b.id));
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
