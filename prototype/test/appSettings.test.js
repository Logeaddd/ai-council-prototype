import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  readAppSettings,
  redactAppSettingsForClient,
  updateAppSettings
} from "../src/appSettings.js";

test("app settings store search key locally but redact it for the client", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-settings-"));
  try {
    const saved = updateAppSettings(baseDir, {
      groupsRoot: "D:/groups",
      firstRunComplete: true,
      capabilities: {
        webSearch: {
          apiKey: "brave-local-secret"
        }
      }
    });
    const loaded = readAppSettings(baseDir);
    const client = redactAppSettingsForClient(loaded, { env: {} });

    assert.equal(saved.capabilities.webSearch.apiKey, "brave-local-secret");
    assert.equal(loaded.capabilities.webSearch.apiKey, "brave-local-secret");
    assert.equal(client.capabilities.webSearch.configured, true);
    assert.equal(client.capabilities.webSearch.source, "configured_local");
    assert.equal(JSON.stringify(client).includes("brave-local-secret"), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("app settings expose built-in search as available without a key", () => {
  const client = redactAppSettingsForClient({}, { env: {} });

  assert.equal(client.capabilities.webSearch.configured, true);
  assert.equal(client.capabilities.webSearch.provider, "Bing Web");
  assert.equal(client.capabilities.webSearch.source, "built_in_html");
  assert.equal(client.capabilities.webSearch.storedKeyConfigured, false);
  assert.equal(client.capabilities.webSearch.envKeyConfigured, false);
});

test("updating app settings without capabilities preserves stored search key", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-settings-"));
  try {
    updateAppSettings(baseDir, {
      capabilities: {
        webSearch: {
          apiKey: "keep-this-key"
        }
      }
    });
    updateAppSettings(baseDir, { groupsRoot: "D:/new-root" });
    const loaded = readAppSettings(baseDir);

    assert.equal(loaded.groupsRoot, "D:/new-root");
    assert.equal(loaded.capabilities.webSearch.apiKey, "keep-this-key");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("global capability switches default on and update without changing the search key", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-settings-"));
  try {
    updateAppSettings(baseDir, {
      capabilities: { webSearch: { apiKey: "keep-this-key" } }
    });
    const saved = updateAppSettings(baseDir, {
      capabilities: { toolAccess: { web: false, files: false } }
    });
    const client = redactAppSettingsForClient(saved, { env: {} });

    assert.equal(saved.capabilities.webSearch.apiKey, "keep-this-key");
    assert.equal(saved.capabilities.toolAccess.web, false);
    assert.equal(saved.capabilities.toolAccess.files, false);
    assert.equal(saved.capabilities.toolAccess.automation, true);
    assert.equal(client.capabilities.toolAccess.web, false);
    assert.equal(JSON.stringify(client).includes("keep-this-key"), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("appearance theme defaults light and persists dark without replacing other settings", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-theme-settings-"));
  try {
    const initial = readAppSettings(baseDir);
    assert.equal(initial.appearance.theme, "light");

    updateAppSettings(baseDir, {
      groupsRoot: "D:/groups",
      capabilities: { webSearch: { apiKey: "keep-theme-key" } }
    });
    const saved = updateAppSettings(baseDir, { appearance: { theme: "dark" } });
    const client = redactAppSettingsForClient(saved, { env: {} });

    assert.equal(saved.appearance.theme, "dark");
    assert.equal(saved.groupsRoot, "D:/groups");
    assert.equal(saved.capabilities.webSearch.apiKey, "keep-theme-key");
    assert.equal(client.appearance.theme, "dark");
    assert.equal(JSON.stringify(client).includes("keep-theme-key"), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
