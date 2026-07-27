import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { evaluateProductHarness, runProductHarnessCheckAsync, testSuiteConcurrency, testSuiteProgressIntervalMs, testSuiteTimeoutMs } from "../src/productHarness.js";

function attachCapabilityExecutionReceipt(report, reportDir, seed) {
  const relativePath = "data/workspace-ui/campaign-group/sessions/session-capability.json";
  const sessionPath = path.join(reportDir, ...relativePath.split("/"));
  const acquisitionId = `install-${seed}`;
  const workResultId = `work-${seed}`;
  const session = {
    id: "session-capability",
    toolExecutionResults: [
      { id: acquisitionId, tool: "install_package", status: "completed", result: { ok: true } },
      {
        id: workResultId,
        tool: "run_code",
        status: "completed",
        result: { ok: true },
        capabilityUsage: [{ acquisitionId, acquisitionTool: "install_package", kind: "installed_package", references: ["image-library"] }]
      }
    ]
  };
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(session), "utf8");
  fs.writeFileSync(sessionPath, bytes);
  report.capabilityAcquisition.evidence = {
    schema: "ai-council.capability-use-evidence.v1",
    uses: [{ acquisitionId, acquisitionTool: "install_package", workResultId, workTool: "run_code", kind: "installed_package", references: ["image-library"] }]
  };
  report.capabilityAcquisition.executionReceipt = {
    schema: "ai-council.capability-execution-receipt.v1",
    sessionFiles: [{
      path: relativePath,
      sessionId: session.id,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }]
  };
  return sessionPath;
}

test("product harness has no default full-suite timeout but accepts an explicit test guard", () => {
  assert.equal(testSuiteTimeoutMs(undefined), undefined);
  assert.equal(testSuiteTimeoutMs(0), undefined);
  assert.equal(testSuiteTimeoutMs(300000), 300000);
  assert.equal(testSuiteConcurrency(undefined), 1);
  assert.equal(testSuiteConcurrency(2), 2);
  assert.equal(testSuiteProgressIntervalMs(undefined), 15000);
  assert.equal(testSuiteProgressIntervalMs(25), 25);
});

test("asynchronous product harness streams actual test output and reports an alive-but-silent child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-harness-stream-"));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ tasks: [] }), "utf8");
  fs.writeFileSync(path.join(root, "test", "observable.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("observable child test", async () => {',
    '  await new Promise((resolve) => setTimeout(resolve, 180));',
    '  assert.equal(true, true);',
    '});'
  ].join("\n"), "utf8");
  const progress = [];
  const result = await runProductHarnessCheckAsync({
    root,
    manifestPath: "manifest.json",
    reportPath: "report.json",
    progressIntervalMs: 20,
    onProgress: (event) => progress.push(event)
  });
  assert.equal(result.report.testEvidence.status, "passed");
  assert.equal(progress.some((event) => event.type === "test_suite_started"), true);
  assert.equal(progress.some((event) => event.type === "test_suite_waiting" && event.processAlive), true);
  assert.equal(progress.some((event) => event.type === "test_output" && event.output.includes("observable child test")), true);
  assert.equal(progress.at(-1).type, "test_suite_finished");
  assert.equal(progress.at(-1).status, "passed");
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

test("product harness can require real-provider bounded-delegation evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-collaboration-"));
  const manifest = { tasks: [{ id: "T119", gates: [{
    id: "collaboration",
    type: "real_user_campaign",
    reportsRoot: "eval/campaign",
    requireDelegationEvidence: true,
    requiredFamilies: [{ id: "owner_research", taskIds: ["delegated-brief"] }]
  }] }] };
  const reportDir = path.join(root, "eval", "campaign", "run-1");
  fs.mkdirSync(reportDir, { recursive: true });
  const report = {
    schema: "ai-council.real-user-campaign-run.v1",
    status: "passed",
    seed: 8,
    providerAcceptance: { realProvider: true, observedModelCalls: 3, blockedBeforeSendModelCalls: 0 },
    scenario: { task: { id: "delegated-brief", deliverable: "deliverables/release-brief.json" } },
    autonomousExecution: { passed: true, resumedAfterInterruption: true },
    minimumUsableDelivery: { passed: true },
    persistence: { passed: true },
    recovery: { passed: true, checks: [{ id: "continuation_completed_visible_work", passed: true }] },
    sessions: { interrupted: [{ id: "interrupted-8" }] }
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");

  report.collaboration = { required: true, passed: true };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete", "a cached report field cannot substitute for persisted session evidence");

  const sessionPath = writeNativeResearchHandoffSession(reportDir, report.scenario.task.deliverable);
  attachCollaborationExecutionReceipt(report, reportDir);
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "complete");
  fs.appendFileSync(sessionPath, "\n");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete", "session hash drift invalidates a collaboration receipt");
});

test("a bounded collaboration gate does not count unrelated campaign failures in its reliability window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-collaboration-scope-"));
  const reportsRoot = path.join(root, "eval", "campaign");
  const manifest = { tasks: [{ id: "T119", gates: [{
    id: "collaboration",
    type: "real_user_campaign",
    reportsRoot: "eval/campaign",
    requireDelegationEvidence: true,
    evidenceWindowPerTask: 3,
    minimumPassRate: 1,
    requireLatestPerTaskPass: true,
    requiredFamilies: [{ id: "owner_research", taskIds: ["delegated-brief"] }]
  }] }] };
  const writeReport = (name, taskId, status, completedAt, collaboration = false) => {
    const dir = path.join(reportsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const report = {
      schema: "ai-council.real-user-campaign-run.v1",
      status,
      seed: 8,
      completedAt,
      providerAcceptance: { realProvider: true, observedModelCalls: 3, blockedBeforeSendModelCalls: 0 },
      scenario: { task: { id: taskId, deliverable: "deliverables/release-brief.json" } },
      autonomousExecution: { passed: status === "passed", resumedAfterInterruption: status === "passed" },
      minimumUsableDelivery: { passed: status === "passed" },
      persistence: { passed: status === "passed" },
      recovery: { passed: status === "passed", checks: status === "passed" ? [{ id: "continuation_completed_visible_work", passed: true }] : [] },
      sessions: { interrupted: status === "passed" ? [{ id: `interrupted-${taskId}` }] : [] },
      collaboration: { required: true, passed: collaboration }
    };
    if (collaboration) {
      writeNativeResearchHandoffSession(dir, "deliverables/release-brief.json");
      attachCollaborationExecutionReceipt(report, dir);
    }
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report), "utf8");
  };
  writeReport("delegated-pass", "delegated-brief", "passed", "2026-07-27T00:00:00.000Z", true);
  writeReport("unrelated-failure", "zip-archive", "failed", "2026-07-27T00:01:00.000Z");

  const result = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } });
  const gate = result.tasks[0].gates[0];
  assert.equal(result.status, "complete");
  assert.equal(gate.evidence.matchingReports, 2);
  assert.equal(gate.evidence.scopedReports, 1);
  assert.equal(gate.evidence.evaluatedReports, 1);
  assert.equal(gate.evidence.passRate, 1);
});

function writeNativeResearchHandoffSession(reportDir, targetFile) {
  const sessionDir = path.join(reportDir, "data", "workspace-ui", "campaign-group", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const delegation = {
    id: "delegation:1:1:critic",
    type: "research",
    assignedBy: "builder",
    assigneeId: "critic",
    allowWorkspaceMutation: false,
    native: true,
    createdAt: "2026-07-27T00:00:00.000Z",
    status: "completed",
    ownerAcknowledged: true,
    handoffEvidence: [{ kind: "tool", detail: "read_file#critic-read completed" }]
  };
  const sessionPath = path.join(sessionDir, "session-native-delegation.json");
  fs.writeFileSync(sessionPath, JSON.stringify({
    id: "session-native-delegation",
    createdAt: "2026-07-27T00:01:00.000Z",
    executionState: { ownership: { delegations: [delegation] } },
    toolExecutionResults: [
      { id: "critic-read", tool: "read_file", status: "completed", createdAt: "2026-07-27T00:00:01.000Z", source_agent_id: "critic", result: { ok: true } },
      { id: "owner-write", tool: "workspace_edit", status: "completed", createdAt: "2026-07-27T00:00:02.000Z", source_agent_id: "builder", path: targetFile, result: { ok: true, path: targetFile } }
    ]
  }), "utf8");
  return sessionPath;
}

function attachCollaborationExecutionReceipt(report, reportDir) {
  const sessionDir = path.join(reportDir, "data", "workspace-ui", "campaign-group", "sessions");
  const sessionFiles = fs.readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const filePath = path.join(sessionDir, entry.name);
      const bytes = fs.readFileSync(filePath);
      return {
        path: path.relative(reportDir, filePath).replaceAll("\\", "/"),
        sessionId: String(JSON.parse(bytes.toString("utf8")).id || ""),
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    });
  report.collaboration.executionReceipt = {
    schema: "ai-council.collaboration-execution-receipt.v1",
    sessionFiles
  };
}

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
  const writeReport = (name, { taskId, seed, acquisition = false, currentAcquisitionEvidence = acquisition }) => {
    const dir = path.join(reportsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const report = {
      schema: "ai-council.real-user-campaign-run.v1",
      status: "passed",
      seed,
      providerAcceptance: { realProvider: true, observedModelCalls: 2, blockedBeforeSendModelCalls: 0 },
      scenario: { task: { id: taskId } },
      autonomousExecution: { passed: true, resumedAfterInterruption: true },
      minimumUsableDelivery: { passed: true },
      capabilityAcquisition: acquisition ? {
        passed: true
      } : { passed: false },
      persistence: { passed: true },
      recovery: { passed: true, checks: [{ id: "continuation_completed_visible_work", passed: true }] },
      sessions: { interrupted: [{ id: `interrupted-${seed}` }] }
    };
    if (acquisition && currentAcquisitionEvidence) attachCapabilityExecutionReceipt(report, dir, seed);
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report), "utf8");
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
  assert.deepEqual(new Set(evidence.distinctSeeds), new Set(["1", "3", "4"]));
  assert.equal(evidence.passedReports.some((report) => report.includes("fake-acquisition")), false);
  assert.equal(evidence.requiredFamilies.every((family) => family.passed), true);
});

test("product harness refuses legacy cached acquisition booleans without a current use receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-acquisition-receipt-"));
  const reportDir = path.join(root, "eval", "campaign", "legacy");
  fs.mkdirSync(reportDir, { recursive: true });
  const manifest = { tasks: [{ id: "T", gates: [{
    id: "matrix",
    type: "real_user_campaign",
    reportsRoot: "eval/campaign",
    minimumPassedReports: 1,
    requiredFamilies: [{ id: "acquisition", taskIds: ["image-tool-acquisition"], requireAcquisitionEvidence: true }]
  }] }] };
  const report = {
    schema: "ai-council.real-user-campaign-run.v1",
    status: "passed",
    seed: 1,
    providerAcceptance: { realProvider: true, observedModelCalls: 1, blockedBeforeSendModelCalls: 0 },
    scenario: { task: { id: "image-tool-acquisition" } },
    autonomousExecution: { passed: true, resumedAfterInterruption: true },
    minimumUsableDelivery: { passed: true },
    capabilityAcquisition: { passed: true },
    persistence: { passed: true },
    recovery: { passed: true, checks: [{ id: "continuation_completed_visible_work", passed: true }] },
    sessions: { interrupted: [{ id: "interrupted" }] }
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");
  const sessionPath = attachCapabilityExecutionReceipt(report, reportDir, 1);
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report), "utf8");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "complete");
  fs.appendFileSync(sessionPath, "\n");
  assert.equal(evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } }).status, "incomplete");
});

test("product harness cannot hide recent campaign failures behind one success per family", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-product-campaign-reliability-"));
  const reportsRoot = path.join(root, "eval", "campaign");
  const manifest = { tasks: [{ id: "T", gates: [{
    id: "reliability",
    type: "real_user_campaign",
    reportsRoot: "eval/campaign",
    minimumPassedReports: 2,
    minimumDistinctTaskIds: 2,
    minimumDistinctSeeds: 2,
    evidenceWindowPerTask: 3,
    minimumPassRate: 0.75,
    requireLatestPerTaskPass: true,
    requiredFamilies: [
      { id: "coding", taskIds: ["node-cli"] },
      { id: "archive", taskIds: ["zip-archive"] }
    ]
  }] }] };
  const writeReport = (name, { taskId, seed, status, completedAt }) => {
    const dir = path.join(reportsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({
      schema: "ai-council.real-user-campaign-run.v1",
      status,
      seed,
      completedAt,
      providerAcceptance: { realProvider: true, observedModelCalls: 2, blockedBeforeSendModelCalls: 0 },
      scenario: { task: { id: taskId } },
      autonomousExecution: { passed: status === "passed", resumedAfterInterruption: status === "passed" },
      minimumUsableDelivery: { passed: status === "passed" },
      persistence: { passed: status === "passed" },
      recovery: { passed: status === "passed", checks: status === "passed" ? [{ id: "continuation_completed_visible_work", passed: true }] : [] },
      sessions: { interrupted: status === "passed" ? [{ id: `interrupted-${seed}` }] : [] }
    }), "utf8");
  };

  writeReport("node-pass", { taskId: "node-cli", seed: 1, status: "passed", completedAt: "2026-07-19T10:00:00.000Z" });
  writeReport("node-fail", { taskId: "node-cli", seed: 2, status: "failed", completedAt: "2026-07-19T11:00:00.000Z" });
  writeReport("archive-pass", { taskId: "zip-archive", seed: 3, status: "passed", completedAt: "2026-07-19T10:30:00.000Z" });
  const failed = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } });
  const failedGate = failed.tasks[0].gates[0];
  assert.equal(failed.status, "incomplete");
  assert.equal(failedGate.evidence.passRate, 2 / 3);
  assert.equal(failedGate.evidence.latestTasksPassed, false);

  writeReport("node-pass-new", { taskId: "node-cli", seed: 4, status: "passed", completedAt: "2026-07-19T12:00:00.000Z" });
  const passed = evaluateProductHarness({ root, manifest, testEvidence: { status: "passed" } });
  assert.equal(passed.status, "complete");
  assert.equal(passed.tasks[0].gates[0].evidence.passRate, 0.75);
  assert.equal(passed.tasks[0].gates[0].evidence.latestTasksPassed, true);
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
  assert.equal(matrixGate.minimumPassRate >= 0.75, true);
  assert.equal(matrixGate.requireLatestPerTaskPass, true);
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
