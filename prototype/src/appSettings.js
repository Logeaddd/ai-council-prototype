import fs from "node:fs";
import path from "node:path";

export function readAppSettings(baseDir, defaults = {}) {
  const filePath = appSettingsPath(baseDir);
  if (!fs.existsSync(filePath)) return normalizeSettings(defaults);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeSettings({ ...defaults, ...parsed });
}

export function updateAppSettings(baseDir, patch, defaults = {}) {
  const next = normalizeSettings({ ...readAppSettings(baseDir, defaults), ...patch });
  const filePath = appSettingsPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function appSettingsPath(baseDir) {
  return path.join(baseDir, "user-data", "app-settings.json");
}

function normalizeSettings(value = {}) {
  return {
    version: 1,
    groupsRoot: String(value.groupsRoot || "").trim(),
    firstRunComplete: Boolean(value.firstRunComplete)
  };
}