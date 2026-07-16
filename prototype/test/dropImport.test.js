import test from "node:test";
import assert from "node:assert/strict";
import { readDroppedDirectory } from "../renderer/lib/drop-import.mjs";

test("dropped directory reader traverses nested files across reader batches", async () => {
  const first = fileEntry("first.txt", "one");
  const nested = directoryEntry("nested", [[fileEntry("second.md", "two")], []]);
  const root = directoryEntry("root", [[first], [nested], []]);

  const result = await readDroppedDirectory(root, 8);

  assert.deepEqual(result.files.map((file) => file.name), ["first.txt", "second.md"]);
  assert.equal(result.truncated, false);
  assert.equal(await result.files[1].text(), "two");
});

test("dropped directory reader reports when the attachment limit truncates files", async () => {
  const root = directoryEntry("root", [[
    fileEntry("one.txt", "1"),
    fileEntry("two.txt", "2"),
    fileEntry("three.txt", "3"),
  ], []]);

  const result = await readDroppedDirectory(root, 2);

  assert.deepEqual(result.files.map((file) => file.name), ["one.txt", "two.txt"]);
  assert.equal(result.truncated, true);
});

function fileEntry(name, content) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success) {
      const blob = new Blob([content], { type: "text/plain" });
      Object.defineProperty(blob, "name", { value: name });
      success(blob);
    },
  };
}

function directoryEntry(name, batches) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let index = 0;
      return {
        readEntries(success) {
          success(batches[index++] || []);
        },
      };
    },
  };
}
