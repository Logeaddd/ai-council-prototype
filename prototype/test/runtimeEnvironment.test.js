import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommandEnvironment, discoverRuntimeEnvironment, formatRuntimeEnvironment } from "../src/runtimeEnvironment.js";

test("runtime discovery reports project launchers and managed tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-runtime-"));
  const group = path.join(root, "group");
  const project = path.join(group, "project");
  const toolBin = path.join(root, "tools", "sample-1.0", "bin");
  const installedBin = path.join(group, "shared", "environments", "npm", "node_modules", ".bin");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(toolBin, { recursive: true });
  fs.mkdirSync(installedBin, { recursive: true });
  fs.writeFileSync(path.join(project, process.platform === "win32" ? "gradlew.bat" : "gradlew"), "", "utf8");
  const toolName = process.platform === "win32" ? "sample-tool.cmd" : "sample-tool";
  const toolPath = path.join(toolBin, toolName);
  fs.writeFileSync(toolPath, "", "utf8");
  if (process.platform !== "win32") fs.chmodSync(toolPath, 0o755);
  const installedName = process.platform === "win32" ? "installed-tool.cmd" : "installed-tool";
  const installedPath = path.join(installedBin, installedName);
  fs.writeFileSync(installedPath, "", "utf8");
  if (process.platform !== "win32") fs.chmodSync(installedPath, 0o755);

  const result = discoverRuntimeEnvironment(group, { refresh: true });
  const text = formatRuntimeEnvironment(result);

  assert.equal(result.projectLaunchers.some((item) => item.path.endsWith(process.platform === "win32" ? "project/gradlew.bat" : "project/gradlew")), true);
  assert.equal(result.managedTools.some((item) => item.path === toolPath), true);
  assert.equal(result.managedTools.some((item) => item.path === installedPath), true);
  assert.match(text, /real local discovery/);
  assert.match(text, /sample-tool/);
  assert.match(text, /installed-tool/);
  assert.match(text, /Reuse detected commands and tools/);
});

test("command environment adds managed tools and replaces an invalid JAVA_HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-command-env-"));
  const group = path.join(root, "group");
  const toolBin = path.join(root, "tools", "build-tool", "bin");
  fs.mkdirSync(group, { recursive: true });
  fs.mkdirSync(toolBin, { recursive: true });
  const toolName = process.platform === "win32" ? "managed-build.cmd" : "managed-build";
  const toolPath = path.join(toolBin, toolName);
  fs.writeFileSync(toolPath, "", "utf8");
  if (process.platform !== "win32") fs.chmodSync(toolPath, 0o755);
  const oldJavaHome = process.env.JAVA_HOME;
  process.env.JAVA_HOME = path.join(root, "missing-jdk");

  try {
    const result = buildCommandEnvironment(group);
    assert.equal(result.pathAdditions.some((item) => item === toolBin), true);
    assert.equal(result.corrections.some((item) => item === "ignored invalid JAVA_HOME"), true);
    assert.equal(result.env.JAVA_HOME ? fs.existsSync(path.join(result.env.JAVA_HOME, "bin")) : true, true);
  } finally {
    if (oldJavaHome === undefined) delete process.env.JAVA_HOME;
    else process.env.JAVA_HOME = oldJavaHome;
  }
});

test("command environment exposes managed npm modules to later Node code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-node-module-env-"));
  const group = path.join(root, "group");
  const modules = path.join(group, "shared", "environments", "npm", "node_modules");
  fs.mkdirSync(modules, { recursive: true });

  const result = buildCommandEnvironment(group);

  assert.equal(result.nodeModulePaths.includes(modules), true);
  assert.equal(String(result.env.NODE_PATH || "").split(path.delimiter).includes(modules), true);
});

test("command environment does not leak the parent Node test runner into child tests", () => {
  const group = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-test-env-"));
  const previous = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const result = buildCommandEnvironment(group);
    assert.equal(result.env.NODE_TEST_CONTEXT, undefined);
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});
