import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { evaluateProductHarness, testSuiteConcurrency, testSuiteTimeoutMs } from "../src/productHarness.js";

test("product harness has no default full-suite timeout but accepts an explicit test guard", () => {
  assert.equal(testSuiteTimeoutMs(undefined), undefined);
  assert.equal(testSuiteTimeoutMs(0), undefined);
  assert.equal(testSuiteTimeoutMs(300000), 300000);
  assert.equal(testSuiteConcurrency(undefined), 1);
  assert.equal(testSuiteConcurrency(2), 2);
});

test("product harness cannot complete a real benchmark gate without a passed evidence report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-harness-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "feature.js"), "export const realFeature = true;", "utf8");
  const manifest = {
    tasks: [{
      id: "T",
      gates: [
        { id: "source", type: "file_contains", path: "src/feature.js", patterns: ["realFeature"] },
        { id: "tests", type: "test_suite" },
        { id: "paid", type: "real_benchmark", taskId: "real-task", reportsRoot: "eval/real-provider", requireTaskChecks: true, requireArtifactVerified: true, requireWorkspaceMutations: true, requireModelCalls: true }
      ]
    }]
  };
  const missing = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed", exitCode: 0 } });
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.tasks[0].gates.find((gate) => gate.id === "paid").status, "failed");

  const reportDir = path.join(root, "eval", "real-provider", "run-1");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify({
    task: { id: "real-task" },
    status: "passed",
    taskChecks: { passed: true },
    execution: { artifactVerification: { status: "verified" }, workspaceMutations: 3 },
    accounting: { modelCalls: 2 }
  }), "utf8");
  const passed = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed", exitCode: 0 } });
  assert.equal(passed.status, "complete");
  assert.equal(passed.tasks[0].gates.every((gate) => gate.status === "passed"), true);
});

test("product harness treats tests not run and missing source patterns as failed gates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-harness-missing-"));
  fs.writeFileSync(path.join(root, "feature.js"), "partial", "utf8");
  const report = evaluateProductHarness({
    root,
    manifest: { tasks: [{ id: "T", gates: [
      { id: "source", type: "file_contains", path: "feature.js", patterns: ["required"] },
      { id: "tests", type: "test_suite" }
    ] }] },
    testEvidence: { status: "not_run" }
  });
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.tasks[0].gates.map((gate) => gate.status), ["failed", "failed"]);
});

test("product harness can require completion source to be tracked by Git", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-harness-git-"));
  fs.writeFileSync(path.join(root, "feature.js"), "required", "utf8");
  const report = evaluateProductHarness({
    root,
    manifest: { tasks: [{ id: "T", gates: [{ id: "source", type: "file_contains", path: "feature.js", patterns: ["required"], requireTracked: true }] }] },
    testEvidence: { status: "passed" }
  });
  assert.equal(report.status, "incomplete");
  assert.equal(report.tasks[0].gates[0].evidence.tracked, false);
});

test("product harness rejects fake campaign reports and accepts retained real-provider survival evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-campaign-"));
  const manifest = { tasks: [{ id: "T117", gates: [{ id: "campaign", type: "real_user_campaign", reportsRoot: "eval/campaign" }] }] };
  const reportDir = path.join(root, "eval", "campaign", "run-1");
  fs.mkdirSync(reportDir, { recursive: true });
  const report = {
    schema: "ai-council.real-user-campaign-run.v1",
    status: "passed",
    providerAcceptance: { realProvider: false, observedModelCalls: 12 },
    autonomousExecution: { passed: true, resumedAfterInterruption: true },
    minimumUsableDelivery: { passed: true }
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");
  report.providerAcceptance.realProvider = true;
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "complete");
});

test("repository product harness uses the universal real-user campaign instead of a Forge-only release gate", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = path.join(root, "config", "product-harness.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const configured = manifest.tasks.find((task) => task.id === "T105");
  assert.equal(configured.gates.some((gate) => gate.id === "real_forge_provider_pass"), false);
  assert.equal(configured.gates.some((gate) => gate.id === "universal_real_provider_survival_pass" && gate.type === "real_user_campaign"), true);
  const report = evaluateProductHarness({
    root,
    manifestPath,
    manifest,
    testEvidence: { status: "passed", exitCode: 0 }
  });
  const t105 = report.tasks.find((task) => task.id === "T105");
  assert.equal(t105.status, "complete");
  assert.equal(t105.gates.find((gate) => gate.id === "universal_real_provider_survival_pass").status, "passed");
});
