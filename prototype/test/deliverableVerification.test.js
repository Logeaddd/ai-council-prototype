import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDeliverableVerification,
  normalizeDeliverableClaims,
  verifyFinalDeliverables
} from "../src/deliverableVerification.js";

test("normalizes structured deliverable claims", () => {
  assert.deepEqual(normalizeDeliverableClaims([
    { path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build", "", 42] },
    { file: "reports/result.json", status: "existing", evidenceIds: "tool-read" },
    { path: "" }
  ]), [
    { path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build", "42"] },
    { path: "reports/result.json", claim: "existing", evidence_ids: ["tool-read"] }
  ]);
});

test("verifies a built file from successful current-session build evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-ok-"));
  const target = path.join(root, "dist", "app.bin");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "REAL_DELIVERABLE", "utf8");
  const completedAt = new Date(Date.now() + 1000).toISOString();
  const session = {
    finalDecision: {
      answer: "Built `dist/app.bin`.",
      final_state: "ready_to_execute",
      deliverables: [{ path: "dist/app.bin", claim: "built", evidence_ids: ["tool-build"] }]
    },
    toolExecutionResults: [{
      id: "tool-build",
      tool: "execute_command",
      status: "completed",
      command: "npm run build",
      createdAt: completedAt,
      result: { ok: true, durationMs: 3000, exitCode: 0, timedOut: false }
    }],
    fileOperationExecutionResults: []
  };

  const report = verifyFinalDeliverables({ groupPath: root, session });
  applyDeliverableVerification(session, report);

  assert.equal(report.status, "verified");
  assert.equal(report.claims[0].status, "verified_built");
  assert.equal(report.claims[0].sha256, crypto.createHash("sha256").update("REAL_DELIVERABLE").digest("hex"));
  assert.deepEqual(report.claims[0].evidence_ids, ["tool-build"]);
  assert.equal(session.finalDecision.final_state, "ready_to_execute");
  assert.match(session.finalDecision.answer, /已验证为本轮构建/);
});

test("existing file without successful current-session evidence lowers final state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-old-"));
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "old.jar"), "OLD_FILE", "utf8");
  const session = {
    finalDecision: {
      answer: "Build completed at `build/old.jar`.",
      final_state: "ready_to_execute",
      risks: [],
      blocking_issues: []
    },
    toolExecutionResults: [{
      id: "tool-build-failed",
      tool: "execute_command",
      status: "failed",
      code: "command_timeout",
      result: { ok: false, timedOut: true }
    }],
    fileOperationExecutionResults: []
  };

  const report = verifyFinalDeliverables({ groupPath: root, session });
  applyDeliverableVerification(session, report);

  assert.equal(report.claims[0].status, "exists_unverified");
  assert.equal(session.finalDecision.final_state, "needs_revision");
  assert.match(session.finalDecision.answer, /^软件核验未通过/);
  assert.match(session.finalDecision.answer, /文件存在，但本轮没有成功操作证明/);
  assert.match(session.finalDecision.risks.join("\n"), /exists but is not verified/);
});

test("a successful generic command cannot prove a built claim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-not-build-"));
  const target = path.join(root, "dist", "app.bin");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "GENERIC_COMMAND_OUTPUT", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Built `dist/app.bin`.",
        deliverables: [{ path: "dist/app.bin", claim: "created", evidence_ids: ["tool-generic"] }]
      },
      toolExecutionResults: [{
        id: "tool-generic",
        tool: "execute_command",
        command: "node write-output.js",
        status: "completed",
        createdAt: new Date(Date.now() + 1000).toISOString(),
        result: { ok: true, durationMs: 3000, exitCode: 0 }
      }],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.claims[0].claim, "built");
  assert.equal(report.claims[0].status, "exists_unverified");
});

test("exact workspace change evidence overrides timestamps and blocks unrelated commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-manifest-"));
  const target = path.join(root, "dist", "app.jar");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "MANIFEST_BOUND_ARTIFACT", "utf8");
  const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(target, oldTime, oldTime);
  const baseResult = {
    ok: true,
    durationMs: 1,
    workspaceChanges: {
      status: "completed",
      complete: true,
      created: [{ path: "dist/app.jar", change: "created", reliable: true }],
      modified: [],
      deleted: []
    }
  };
  const verified = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Built `dist/app.jar`.",
        deliverables: [{ path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build"] }]
      },
      toolExecutionResults: [{
        id: "tool-build",
        tool: "execute_command",
        command: "npm run build",
        status: "completed",
        createdAt: new Date().toISOString(),
        result: baseResult
      }],
      fileOperationExecutionResults: []
    }
  });
  const unverified = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Built `dist/app.jar`.",
        deliverables: [{ path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build"] }]
      },
      toolExecutionResults: [{
        id: "tool-build",
        tool: "execute_command",
        command: "npm run build",
        status: "completed",
        createdAt: new Date().toISOString(),
        result: {
          ...baseResult,
          workspaceChanges: { ...baseResult.workspaceChanges, created: [{ path: "dist/other.jar", change: "created", reliable: true }] }
        }
      }],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(verified.claims[0].status, "verified_built");
  assert.match(verified.claims[0].evidence_matches[0].match, /workspace_change_created/);
  assert.equal(unverified.claims[0].status, "exists_unverified");
});

test("successful incremental build can verify an unchanged artifact observed afterward", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-incremental-"));
  const target = path.join(root, "dist", "app.jar");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "UP_TO_DATE_ARTIFACT", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Built `dist/app.jar`.",
        deliverables: [{ path: "dist/app.jar", claim: "built", evidence_ids: ["tool-build"] }]
      },
      toolExecutionResults: [{
        id: "tool-build",
        tool: "execute_command",
        command: "gradle build",
        status: "completed",
        createdAt: new Date().toISOString(),
        result: {
          ok: true,
          cwd: ".",
          workspaceChanges: {
            status: "completed",
            complete: true,
            created: [],
            modified: [],
            deleted: [],
            observedArtifacts: [{ path: "dist/app.jar", reliable: true }]
          }
        }
      }],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.claims[0].status, "verified_built");
  assert.equal(report.claims[0].evidence_matches[0].match, "workspace_observed_after_successful_build");
});

test("incremental build observation cannot verify an artifact outside command cwd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-cwd-"));
  fs.mkdirSync(path.join(root, "project-b", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "project-b", "dist", "app.jar"), "OTHER_PROJECT", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Built `project-b/dist/app.jar`.",
        deliverables: [{ path: "project-b/dist/app.jar", claim: "built", evidence_ids: ["tool-build-a"] }]
      },
      toolExecutionResults: [{
        id: "tool-build-a",
        tool: "execute_command",
        command: "npm run build",
        status: "completed",
        createdAt: new Date().toISOString(),
        result: {
          ok: true,
          cwd: "project-a",
          workspaceChanges: {
            status: "completed",
            complete: true,
            created: [],
            modified: [],
            deleted: [],
            observedArtifacts: [{ path: "project-b/dist/app.jar", reliable: true }]
          }
        }
      }],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.claims[0].status, "exists_unverified");
});

test("missing and escaped deliverable claims are rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-bad-"));
  const session = {
    finalDecision: {
      answer: "Done.",
      deliverables: [
        { path: "dist/missing.zip", claim: "created", evidence_ids: [] },
        { path: "../outside.exe", claim: "created", evidence_ids: [] }
      ]
    },
    toolExecutionResults: [],
    fileOperationExecutionResults: []
  };

  const report = verifyFinalDeliverables({ groupPath: root, session });

  assert.equal(report.claims[0].status, "missing");
  assert.equal(report.claims[1].status, "invalid_path");
});

test("root artifacts are detected while secret and internal paths are rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-root-"));
  fs.writeFileSync(path.join(root, "app.exe"), "ROOT_ARTIFACT", "utf8");
  const rootReport = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: { answer: "Build completed successfully at `app.exe`." },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });
  const blockedReport = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Done.",
        deliverables: [
          { path: ".env.local", claim: "existing" },
          { path: "sessions/private.json", claim: "existing" },
          { path: "shared/logs/commands.jsonl", claim: "existing" }
        ]
      },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(rootReport.claims[0].normalized_path, "app.exe");
  assert.equal(rootReport.claims[0].status, "exists_unverified");
  assert.deepEqual(blockedReport.claims.map((item) => item.status), ["invalid_path", "invalid_path", "invalid_path"]);
});

test("a deliverable symlink cannot escape the group workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-outside-"));
  fs.writeFileSync(path.join(outside, "outside.zip"), "OUTSIDE", "utf8");
  fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: { answer: "Created `linked/outside.zip`." },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.claims[0].status, "invalid_path");
});

test("fallback extraction ignores ordinary future source-path mentions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-none-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "todo.js"), "TODO", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: { answer: "Next, edit `src/todo.js` and run tests." },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.status, "not_claimed");
  assert.deepEqual(report.claims, []);
});

test("fallback extraction handles mixed double and single markdown backticks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-backticks-"));
  fs.mkdirSync(path.join(root, "build", "libs"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "libs", "app.jar"), "OLD", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: {
        answer: "Package ``Random Surface`` was built successfully. JAR generated at `build/libs/app.jar`."
      },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.claims.length, 1);
  assert.equal(report.claims[0].normalized_path, "build/libs/app.jar");
  assert.equal(report.claims[0].status, "exists_unverified");
});

test("fallback extraction does not carry a completion claim across sentences", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-deliverable-sentence-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.js"), "SOURCE", "utf8");
  const report = verifyFinalDeliverables({
    groupPath: root,
    session: {
      finalDecision: { answer: "The build completed successfully. Next, edit `src/main.js` to change the behavior." },
      toolExecutionResults: [],
      fileOperationExecutionResults: []
    }
  });

  assert.equal(report.status, "not_claimed");
});
