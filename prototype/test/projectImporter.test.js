import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { importProjectFolder } from "../src/projectImporter.js";

test("project importer reads a real folder into prompt attachments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-project-import-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# PetRabbit\nworldview notes", "utf8");
  fs.writeFileSync(path.join(root, "src", "story.json"), JSON.stringify({ secret: "PET_RABBIT_WORLDVIEW" }), "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "skip.js"), "SHOULD_NOT_APPEAR", "utf8");
  fs.writeFileSync(path.join(root, "image.png"), Buffer.from([0, 1, 2, 3]));

  const result = importProjectFolder(root);
  const merged = result.attachments.map((item) => `${item.name}\n${item.content}`).join("\n\n");

  assert.equal(result.root, root);
  assert.equal(result.importedFiles > 0, true);
  assert.match(merged, /project-directory-tree\.txt/);
  assert.match(merged, /README\.md/);
  assert.match(merged, /src\/story\.json/);
  assert.match(merged, /PET_RABBIT_WORLDVIEW/);
  assert.doesNotMatch(merged, /SHOULD_NOT_APPEAR/);
});

test("project importer limits large files and marks truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-project-import-large-"));
  fs.writeFileSync(path.join(root, "large.md"), "A".repeat(2048), "utf8");

  const result = importProjectFolder(root, { maxFileBytes: 128 });
  const imported = result.attachments.find((item) => item.name.includes("large"));

  assert.ok(imported);
  assert.equal(imported.truncated, true);
  assert.match(imported.content, /truncated to 128 bytes/);
  assert.equal(imported.content.includes("A".repeat(256)), false);
});
