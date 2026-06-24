import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { extractFileOperations, parseFileOperationProposals } from "../src/fileOperations.js";

test("file operation parser accepts sandboxed direct proposals", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, "src"), { recursive: true });

  const result = parseFileOperationProposals({
    groupRoot,
    proposedBy: { seatId: "seat_01", name: "Executor", role: "coder" },
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/output.txt",
          content: "hello",
          reason: "Create the requested output.",
          expected_effect: "A new output file exists."
        }
      ]
    }
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 1);
  assert.match(result.accepted[0].id, /^fop_/);
  assert.equal(result.accepted[0].op, "write");
  assert.equal(result.accepted[0].path, "src/output.txt");
  assert.equal(result.accepted[0].content, "hello");
  assert.equal(result.accepted[0].proposedBy.seatId, "seat_01");
  assert.equal(fs.existsSync(path.join(groupRoot, "src", "output.txt")), false);
});

test("file operation parser extracts proposals from file operation artifacts", () => {
  const operations = extractFileOperations({
    artifacts: [
      {
        type: "file_operations",
        content: JSON.stringify({
          file_operations: [
            {
              op: "read",
              path: "README.md",
              reason: "Inspect current docs.",
              expected_effect: "Context is available."
            }
          ]
        })
      }
    ]
  });

  assert.equal(operations.length, 1);
  assert.equal(operations[0].op, "read");
});

test("file operation parser rejects missing fields and invalid ops", () => {
  const groupRoot = makeGroupRoot();
  const result = parseFileOperationProposals({
    groupRoot,
    source: {
      file_operations: [
        null,
        { op: "run", path: "src/a.js", reason: "Bad op.", expected_effect: "No effect." },
        { op: "read", reason: "Missing path.", expected_effect: "No effect." },
        { op: "read", path: "src/a.js", expected_effect: "Missing reason." },
        { op: "read", path: "src/a.js", reason: "Missing expected effect." },
        { op: "write", path: "src/a.js", reason: "Missing content.", expected_effect: "No file." }
      ]
    }
  });

  assert.deepEqual(result.rejected.map((item) => item.code), [
    "invalid_operation",
    "invalid_op",
    "missing_path",
    "missing_reason",
    "missing_expected_effect",
    "missing_content"
  ]);
  assert.equal(result.accepted.length, 0);
});

test("file operation parser rejects sandbox escape and forbidden secret paths", () => {
  const groupRoot = makeGroupRoot();
  const result = parseFileOperationProposals({
    groupRoot,
    source: {
      file_operations: [
        {
          op: "read",
          path: "../outside.txt",
          reason: "Try escaping.",
          expected_effect: "Should fail."
        },
        {
          op: "read",
          path: ".env",
          reason: "Try reading a secret.",
          expected_effect: "Should fail."
        }
      ]
    }
  });

  assert.deepEqual(result.rejected.map((item) => item.code), ["path_escape_denied", "forbidden_secret_file"]);
  assert.equal(result.accepted.length, 0);
});

test("file operation parser accepts list and delete proposals without content", () => {
  const groupRoot = makeGroupRoot();
  fs.mkdirSync(path.join(groupRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(groupRoot, "src", "old.txt"), "old", "utf8");

  const result = parseFileOperationProposals({
    groupRoot,
    source: {
      file_operations: [
        {
          op: "list",
          path: "src",
          reason: "See files.",
          expected_effect: "Directory entries can be reviewed."
        },
        {
          op: "delete",
          path: "src/old.txt",
          reason: "Remove obsolete file after approval.",
          expected_effect: "The old file is removed."
        }
      ]
    }
  });

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.accepted.map((item) => item.op), ["list", "delete"]);
  assert.equal(result.accepted[0].content, undefined);
  assert.equal(fs.existsSync(path.join(groupRoot, "src", "old.txt")), true);
});


test("file operation parser preserves write content exactly", () => {
  const groupRoot = makeGroupRoot();
  const content = "  export const ok = true;\n";
  const result = parseFileOperationProposals({
    groupRoot,
    source: {
      file_operations: [
        {
          op: "write",
          path: "src/exact.js",
          content,
          reason: "Preserve exact code content.",
          expected_effect: "Exact content is available for execution."
        }
      ]
    }
  });

  assert.equal(result.accepted[0].content, content);
});

test("file operation parser accepts common op aliases from real providers", () => {
  const groupRoot = makeGroupRoot();
  const result = parseFileOperationProposals({
    groupRoot,
    source: {
      file_operations: [
        {
          operation: "write",
          path: "src/live-file-op-smoke.txt",
          content: "Live file operation smoke reached the model.",
          reason: "Create the requested smoke file.",
          expected_effect: "The smoke file exists for review."
        },
        {
          action: "read",
          path: "README.md",
          reason: "Inspect project docs.",
          expected_effect: "Docs are available for context."
        }
      ]
    }
  });

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.accepted.map((item) => item.op), ["write", "read"]);
});
function makeGroupRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-file-ops-"));
}
