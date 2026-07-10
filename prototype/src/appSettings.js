import fs from "node:fs";
import path from "node:path";
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
    }
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
    capabilities: normalizeCapabilities(value.capabilities)
  };
}

function normalizeAppearance(value = {}) {
  return {
    theme: value.theme === "dark" ? "dark" : "light"
  };
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
