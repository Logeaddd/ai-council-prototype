import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "../src/workspaceChanges.js";

test("workspace snapshots report created modified and deleted paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-changes-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "modify.txt"), "BEFORE", "utf8");
  fs.writeFileSync(path.join(root, "src", "delete.txt"), "DELETE", "utf8");
  const before = captureWorkspaceSnapshot(root);

  fs.writeFileSync(path.join(root, "src", "modify.txt"), "AFTER-LONGER", "utf8");
  fs.rmSync(path.join(root, "src", "delete.txt"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "app.jar"), "ARTIFACT", "utf8");
  const after = captureWorkspaceSnapshot(root);
  const result = diffWorkspaceSnapshots(before, after);

  assert.equal(result.complete, true);
  assert.equal(result.created.some((item) => item.path === "dist/app.jar" && item.reliable), true);
  assert.equal(result.modified.some((item) => item.path === "src/modify.txt" && item.reliable), true);
  assert.equal(result.deleted.some((item) => item.path === "src/delete.txt" && item.reliable), true);
  assert.equal(result.created[0].path, "dist/app.jar");
  assert.equal(result.observedArtifacts.some((item) => item.path === "dist/app.jar"), true);
});

test("unchanged artifacts remain observable after an incremental build", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-observed-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "app.jar"), "UNCHANGED_ARTIFACT", "utf8");
  const before = captureWorkspaceSnapshot(root);
  const after = captureWorkspaceSnapshot(root);
  const result = diffWorkspaceSnapshots(before, after);

  assert.equal(result.totalChanges, 0);
  assert.equal(result.observedArtifacts.some((item) => item.path === "dist/app.jar" && item.reliable), true);
});

test("timestamp-only generator rewrites are not material workspace progress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-identical-rewrite-"));
  const filePath = path.join(root, "deliverables", "generated.png");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "SAME_BINARY_BYTES", "utf8");
  const before = captureWorkspaceSnapshot(root);

  fs.writeFileSync(filePath, "SAME_BINARY_BYTES", "utf8");
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + 1000));
  const after = captureWorkspaceSnapshot(root);
  const result = diffWorkspaceSnapshots(before, after);

  assert.equal(result.totalChanges, 0);
});

test("same-size content rewrites remain material workspace progress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-same-size-rewrite-"));
  const filePath = path.join(root, "deliverables", "artifact.txt");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "before", "utf8");
  const before = captureWorkspaceSnapshot(root);

  fs.writeFileSync(filePath, "after!", "utf8");
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + 1000));
  const result = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root));

  assert.equal(result.modified.some((item) => item.path === "deliverables/artifact.txt"), true);
});

test("workspace snapshots exclude secrets dependencies and council runtime state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-ignore-"));
  const ignored = [
    [".env.local", "SECRET"],
    ["node_modules/pkg/index.js", "DEPENDENCY"],
    ["sessions/session.json", "SESSION"],
    ["members/A/private_memory/memory.json", "MEMORY"],
    ["shared/logs/commands.jsonl", "LOG"],
    ["shared/usage/usage.jsonl", "USAGE"],
    ["shared/environments/npm/tool.js", "MANAGED"],
    ["shared/file-ops/recovery/fop_1/content.bin", "RECOVERY"],
    ["group.json", "{}"]
  ];
  const before = captureWorkspaceSnapshot(root);
  for (const [relativePath, content] of ignored) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "visible.zip"), "VISIBLE", "utf8");
  const result = diffWorkspaceSnapshots(before, captureWorkspaceSnapshot(root));
  const paths = [...result.created, ...result.modified, ...result.deleted].map((item) => item.path);

  assert.equal(paths.includes("build/visible.zip"), true);
  for (const [relativePath] of ignored) assert.equal(paths.includes(relativePath), false);
});

test("truncated snapshots disclose incomplete changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-workspace-truncated-"));
  for (let index = 0; index < 120; index += 1) {
    fs.writeFileSync(path.join(root, `file-${index}.txt`), String(index), "utf8");
  }
  const snapshot = captureWorkspaceSnapshot(root, { maxEntries: 100 });
  const result = diffWorkspaceSnapshots(snapshot, snapshot, { maxChanges: 10 });

  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.complete, false);
  assert.equal(result.complete, false);
  assert.equal(result.observedArtifacts.every((item) => item.reliable === false), true);
});
