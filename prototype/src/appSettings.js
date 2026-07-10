import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeCapabilityAccess } from "./capabilityPolicy.js";

export function readAppSettings(baseDir, defaults = {}) {
  const filePath = appSettingsPath(baseDir);
  if (!fs.existsSync(filePath)) return normalizeSettings(defaults);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeSettings({ ...defaults, ...parsed });
}

export function updateAppSettings(baseDir, patch, defaults = {}) {
  const current = readAppSettings(baseDir, defaults);
  const next = normalizeSettings({
    ...current,
    ...patch,
    capabilities: mergeCapabilities(current.capabilities, patch.capabilities),
    appearance: {
      ...(current.appearance || {}),
      ...(patch.appearance || {})
    },
    modelServices: mergeModelServices(current.modelServices, patch.modelServices)
  });
  const filePath = appSettingsPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function appSettingsPath(baseDir) {
  return path.join(userDataDir(baseDir), "app-settings.json");
}

export function userDataDir(baseDir) {
  return process.env.AI_COUNCIL_DATA_DIR
    ? path.resolve(process.env.AI_COUNCIL_DATA_DIR)
    : path.join(baseDir, "user-data");
}

export function redactAppSettingsForClient(settings, options = {}) {
  const normalized = normalizeSettings(settings);
  const storedKeyConfigured = Boolean(normalized.capabilities.webSearch.apiKey);
  const envKeyConfigured = Boolean(
    String(options.env?.AI_COUNCIL_BRAVE_SEARCH_API_KEY || options.env?.BRAVE_SEARCH_API_KEY || "").trim()
  );
  return {
    version: normalized.version,
    groupsRoot: normalized.groupsRoot,
    firstRunComplete: normalized.firstRunComplete,
    appearance: normalized.appearance,
    modelServices: normalized.modelServices,
    capabilities: {
      webSearch: {
        provider: storedKeyConfigured || envKeyConfigured ? normalized.capabilities.webSearch.provider : "Bing Web",
        configured: true,
        storedKeyConfigured,
        envKeyConfigured,
        source: storedKeyConfigured ? "configured_local" : envKeyConfigured ? "configured_env" : "built_in_html"
      },
      toolAccess: normalized.capabilities.toolAccess
    }
  };
}

function normalizeSettings(value = {}) {
  return {
    version: 1,
    groupsRoot: String(value.groupsRoot || "").trim(),
    firstRunComplete: Boolean(value.firstRunComplete),
    appearance: normalizeAppearance(value.appearance),
    modelServices: normalizeModelServices(value.modelServices),
    capabilities: normalizeCapabilities(value.capabilities)
  };
}

export function upsertCustomModelService(baseDir, input = {}, defaults = {}) {
  const current = readAppSettings(baseDir, defaults);
  const requestedId = String(input.id || "").trim();
  const id = requestedId.startsWith("user-provider-")
    ? requestedId
    : `user-provider-${randomUUID()}`;
  const service = normalizeCustomModelService({ ...input, id }, true);
  const custom = current.modelServices.custom.filter((item) => item.id !== service.id);
  const settings = updateAppSettings(baseDir, {
    modelServices: { custom: [...custom, service] }
  }, defaults);
  return settings.modelServices.custom.find((item) => item.id === service.id);
}

export function removeCustomModelService(baseDir, id, defaults = {}) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId.startsWith("user-provider-")) throw settingsError("invalid_model_service_id", "只能删除用户添加的模型服务。");
  const current = readAppSettings(baseDir, defaults);
  const custom = current.modelServices.custom.filter((item) => item.id !== normalizedId);
  if (custom.length === current.modelServices.custom.length) throw settingsError("model_service_not_found", "模型服务不存在。", 404);
  updateAppSettings(baseDir, { modelServices: { custom } }, defaults);
  return { ok: true, id: normalizedId };
}

function normalizeAppearance(value = {}) {
  return {
    theme: value.theme === "dark" ? "dark" : "light"
  };
}

function normalizeModelServices(value = {}) {
  const source = Array.isArray(value.custom) ? value.custom : [];
  const custom = [];
  const seen = new Set();
  for (const item of source.slice(0, 100)) {
    const normalized = normalizeCustomModelService(item, false);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    custom.push(normalized);
  }
  return { custom };
}

function normalizeCustomModelService(value = {}, strict = false) {
  const id = String(value.id || "").trim().slice(0, 100);
  const label = String(value.label || value.name || "").trim().slice(0, 80);
  const officialBaseUrl = String(value.officialBaseUrl || value.baseUrl || "").trim().slice(0, 2048).replace(/\/$/, "");
  const defaultModel = String(value.defaultModel || "").trim().slice(0, 200);
  const modelsEndpoint = normalizeModelsEndpoint(value.modelsEndpoint);
  const invalid = !id.startsWith("user-provider-") || !label || !validHttpUrl(officialBaseUrl);
  if (invalid) {
    if (strict) throw settingsError("invalid_model_service", "请填写名称和有效的 http/https 接口地址。");
    return null;
  }
  return {
    id,
    label,
    transport: "openai-compatible",
    officialBaseUrl,
    defaultModel,
    modelsEndpoint
  };
}

function normalizeModelsEndpoint(value) {
  const text = String(value || "/models").trim().slice(0, 200);
  if (!text) return "/models";
  return text.startsWith("/") ? text : `/${text}`;
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeCapabilities(value = {}) {
  return {
    webSearch: {
      provider: "Brave Search",
      apiKey: String(value.webSearch?.apiKey || "").trim()
    },
    toolAccess: normalizeCapabilityAccess(value.toolAccess)
  };
}

function mergeCapabilities(current = {}, patch = undefined) {
  if (!patch || typeof patch !== "object") return current;
  return {
    ...current,
    ...patch,
    webSearch: {
      ...(current.webSearch || {}),
      ...(patch.webSearch || {})
    },
    toolAccess: {
      ...(current.toolAccess || {}),
      ...(patch.toolAccess || {})
    }
  };
}

function mergeModelServices(current = {}, patch = undefined) {
  if (!patch || typeof patch !== "object") return current;
  return {
    ...current,
    ...patch,
    custom: Object.hasOwn(patch, "custom") ? patch.custom : current.custom
  };
}

function settingsError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
