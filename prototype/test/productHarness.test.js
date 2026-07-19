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
    providerAcceptance: { realProvider: false, observedModelCalls: 12, blockedBeforeSendModelCalls: 0 },
    autonomousExecution: { passed: true, resumedAfterInterruption: true },
    minimumUsableDelivery: { passed: true },
    persistence: { passed: true },
    recovery: { passed: true, checks: [{ id: "continuation_completed_visible_work", passed: true }] },
    sessions: { interrupted: [{ id: "interrupted-1" }] }
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");
  report.providerAcceptance.realProvider = true;
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "complete");
});

test("product harness requires a real multi-family matrix and cannot count repeated seeds or fabricated acquisition", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-campaign-matrix-"));
  const reportsRoot = path.join(root, "eval", "campaign");
  const manifest = { tasks: [{ id: "T118", gates: [{
    id: "matrix",
    type: "real_user_campaign",
    reportsRoot: "eval/campaign",
    minimumPassedReports: 3,
    minimumDistinctTaskIds: 3,
    minimumDistinctSeeds: 3,
    requiredFamilies: [
      { id: "coding", taskIds: ["node-cli"] },
      { id: "archive", taskIds: ["zip-archive"] },
      { id: "acquisition", taskIds: ["image-tool-acquisition"], requireAcquisitionEvidence: true }
    ]
  }] }] };
  const writeReport = (name, { taskId, seed, acquisition = false }) => {
    const dir = path.join(reportsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({
      schema: "ai-council.real-user-campaign-run.v1",
      status: "passed",
      seed,
      providerAcceptance: { realProvider: true, observedModelCalls: 2, blockedBeforeSendModelCalls: 0 },
      scenario: { task: { id: taskId } },
      autonomousExecution: { passed: true, resumedAfterInterruption: true },
      minimumUsableDelivery: { passed: true },
      capabilityAcquisition: { passed: acquisition },
      persistence: { passed: true },
      recovery: { passed: true, checks: [{ id: "continuation_completed_visible_work", passed: true }] },
      sessions: { interrupted: [{ id: `interrupted-${seed}` }] }
    }), "utf8");
  };

  writeReport("node-1", { taskId: "node-cli", seed: 1 });
  writeReport("node-2", { taskId: "node-cli", seed: 1 });
  writeReport("fake-acquisition", { taskId: "image-tool-acquisition", seed: 2, acquisition: false });
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");

  writeReport("archive", { taskId: "zip-archive", seed: 3 });
  writeReport("real-acquisition", { taskId: "image-tool-acquisition", seed: 4, acquisition: true });
  const passed = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } });
  assert.equal(passed.status, "complete");
  const evidence = passed.tasks[0].gates[0].evidence;
  assert.deepEqual(new Set(evidence.distinctTaskIds), new Set(["node-cli", "image-tool-acquisition", "zip-archive"]));
  assert.deepEqual(new Set(evidence.distinctSeeds), new Set(["1", "2", "3", "4"]));
  assert.equal(evidence.requiredFamilies.every((family) => family.passed), true);
});

test("repository product harness requires a multi-family real-user matrix instead of a Forge-only or single-report release gate", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = path.join(root, "config", "product-harness.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const configured = manifest.tasks.find((task) => task.id === "T105");
  assert.equal(configured.gates.some((gate) => gate.id === "real_forge_provider_pass"), false);
  const matrixGate = configured.gates.find((gate) => gate.id === "universal_real_provider_survival_pass" && gate.type === "real_user_campaign");
  assert.equal(Boolean(matrixGate), true);
  assert.equal(matrixGate.minimumPassedReports >= 5, true);
  assert.equal(matrixGate.requiredFamilies.some((family) => family.requireAcquisitionEvidence), true);
  const report = evaluateProductHarness({
    root,
    manifestPath,
    manifest,
    testEvidence: { status: "passed", exitCode: 0 }
  });
  const t105 = report.tasks.find((task) => task.id === "T105");
  const evaluatedMatrix = t105.gates.find((gate) => gate.id === "universal_real_provider_survival_pass");
  assert.equal(["passed", "failed"].includes(evaluatedMatrix.status), true);
  if (evaluatedMatrix.status === "passed") {
    assert.equal(evaluatedMatrix.evidence.passedReports.length >= matrixGate.minimumPassedReports, true);
    assert.equal(evaluatedMatrix.evidence.distinctTaskIds.length >= matrixGate.minimumDistinctTaskIds, true);
    assert.equal(evaluatedMatrix.evidence.distinctSeeds.length >= matrixGate.minimumDistinctSeeds, true);
    assert.equal(evaluatedMatrix.evidence.requiredFamilies.every((family) => family.passed), true);
  } else {
    assert.equal(t105.status, "incomplete");
  }
});
