import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function runProductHarnessCheck(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const manifestPath = path.resolve(root, options.manifestPath || path.join("config", "product-harness.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const testEvidence = options.runTests === false ? { status: "not_run", reason: "tests_not_requested" } : runTestSuite(root, options);
  const report = evaluateProductHarness({ root, manifest, manifestPath, testEvidence });
  const reportPath = path.resolve(root, options.reportPath || defaultReportPath());
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { report, reportPath };
}

export function evaluateProductHarness(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const manifest = options.manifest || {};
  const testEvidence = options.testEvidence || { status: "not_run" };
  const tasks = (Array.isArray(manifest.tasks) ? manifest.tasks : []).map((task) => {
    const gates = (Array.isArray(task.gates) ? task.gates : []).map((gate) => evaluateGate(root, gate, testEvidence));
    return {
      id: String(task.id || ""),
      title: String(task.title || ""),
      status: gates.length > 0 && gates.every((gate) => gate.status === "passed") ? "complete" : "incomplete",
      passedGates: gates.filter((gate) => gate.status === "passed").length,
      totalGates: gates.length,
      gates
    };
  });
  return {
    schema: "ai-council.product-harness-report.v1",
    createdAt: new Date().toISOString(),
    manifestPath: options.manifestPath ? path.relative(root, options.manifestPath).replaceAll("\\", "/") : "",
    manifestSha256: sha256(JSON.stringify(manifest)),
    gitHead: gitOutput(root, ["rev-parse", "HEAD"]),
    status: tasks.length > 0 && tasks.every((task) => task.status === "complete") ? "complete" : "incomplete",
    testEvidence: summarizeTestEvidence(testEvidence),
    tasks
  };
}

function evaluateGate(root, gate, testEvidence) {
  const base = { id: String(gate.id || ""), type: String(gate.type || ""), status: "failed", evidence: {} };
  try {
    if (gate.type === "git_ancestor") {
      const result = spawnSync("git", ["merge-base", "--is-ancestor", String(gate.commit || ""), "HEAD"], { cwd: root, windowsHide: true });
      return { ...base, status: result.status === 0 ? "passed" : "failed", evidence: { commit: gate.commit, gitExitCode: result.status } };
    }
    if (gate.type === "file_contains") {
      const filePath = path.resolve(root, String(gate.path || ""));
      const inside = filePath === root || filePath.startsWith(`${root}${path.sep}`);
      const text = inside && fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath, "utf8") : "";
      const patterns = Array.isArray(gate.patterns) ? gate.patterns.map(String) : [];
      const missing = patterns.filter((pattern) => !text.includes(pattern));
      const tracked = !gate.requireTracked || isTrackedFile(root, gate.path);
      return { ...base, status: inside && text && missing.length === 0 && tracked ? "passed" : "failed", evidence: { path: gate.path, tracked, missingPatterns: missing } };
    }
    if (gate.type === "test_suite") {
      return { ...base, status: testEvidence.status === "passed" ? "passed" : "failed", evidence: summarizeTestEvidence(testEvidence) };
    }
    if (gate.type === "real_benchmark") return evaluateRealBenchmarkGate(root, gate, base);
    if (gate.type === "real_user_campaign") return evaluateRealUserCampaignGate(root, gate, base);
    return { ...base, evidence: { error: `unknown_gate_type:${gate.type}` } };
  } catch (error) {
    return { ...base, evidence: { error: String(error.message || error) } };
  }
}

function evaluateRealUserCampaignGate(root, gate, base) {
  const reportsRoot = path.resolve(root, gate.reportsRoot || path.join("eval", "real-user-campaign"));
  const reports = findReports(reportsRoot).map((filePath) => {
    try { return { filePath, report: JSON.parse(fs.readFileSync(filePath, "utf8")) }; } catch { return null; }
  }).filter(Boolean).filter(({ report }) => report?.schema === "ai-council.real-user-campaign-run.v1");
  const passed = reports.find(({ report }) => (
    report.status === "passed"
    && report.providerAcceptance?.realProvider === true
    && report.autonomousExecution?.passed === true
    && report.minimumUsableDelivery?.passed === true
    && report.autonomousExecution?.resumedAfterInterruption === true
    && Number(report.providerAcceptance?.observedModelCalls || report.sessions?.modelCalls || 0) > 0
  ));
  return {
    ...base,
    status: passed ? "passed" : "failed",
    evidence: {
      reportsRoot: path.relative(root, reportsRoot).replaceAll("\\", "/"),
      matchingReports: reports.length,
      passedReport: passed ? path.relative(root, passed.filePath).replaceAll("\\", "/") : ""
    }
  };
}

function evaluateRealBenchmarkGate(root, gate, base) {
  const reportsRoot = path.resolve(root, gate.reportsRoot || path.join("eval", "real-provider"));
  const reports = findReports(reportsRoot).map((filePath) => {
    try {
      return { filePath, report: JSON.parse(fs.readFileSync(filePath, "utf8")) };
    } catch {
      return null;
    }
  }).filter(Boolean).filter(({ report }) => report?.task?.id === gate.taskId);
  const passed = reports.find(({ report }) => (
    report.status === "passed"
    && (!gate.requireTaskChecks || report.taskChecks?.passed === true)
    && (!gate.requireArtifactVerified || report.execution?.artifactVerification?.status === "verified")
    && (!gate.requireWorkspaceMutations || Number(report.execution?.workspaceMutations || 0) > 0)
    && (!gate.requireModelCalls || Number(report.accounting?.modelCalls || 0) > 0)
  ));
  return {
    ...base,
    status: passed ? "passed" : "failed",
    evidence: {
      taskId: gate.taskId,
      reportsRoot: path.relative(root, reportsRoot).replaceAll("\\", "/"),
      matchingReports: reports.length,
      passedReport: passed ? path.relative(root, passed.filePath).replaceAll("\\", "/") : ""
    }
  };
}

function runTestSuite(root, options) {
  const started = Date.now();
  const testDir = path.join(root, "test");
  const testFiles = fs.readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("test", name));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const timeout = testSuiteTimeoutMs(options.testTimeoutMs);
  const concurrency = testSuiteConcurrency(options.testConcurrency);
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...testFiles], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...(timeout ? { timeout } : {}),
    maxBuffer: 32 * 1024 * 1024,
    env
  });
  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    tests: outputCount(result.stdout, "tests"),
    passed: outputCount(result.stdout, "pass"),
    failed: outputCount(result.stdout, "fail"),
    stdout: String(result.stdout || "").slice(-12000),
    stderr: String(result.stderr || "").slice(-12000),
    error: result.error ? String(result.error.message || result.error) : ""
  };
}

export function testSuiteTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

export function testSuiteConcurrency(value) {
  const concurrency = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 4;
}

function summarizeTestEvidence(value = {}) {
  return {
    status: String(value.status || "not_run"),
    exitCode: value.exitCode ?? null,
    durationMs: Number(value.durationMs || 0),
    tests: Number(value.tests || 0),
    passed: Number(value.passed || 0),
    failed: Number(value.failed || 0),
    error: String(value.error || value.reason || "")
  };
}

function outputCount(output, label) {
  const match = String(output || "").match(new RegExp(`(?:^|\\n)[^\\S\\r\\n]*[ℹ#]?[^\\S\\r\\n]*${label}\\s+(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function findReports(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const found = [];
  const stack = [root];
  while (stack.length && found.length < 1000) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name === "report.json") found.push(absolute);
    }
  }
  return found;
}

function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function isTrackedFile(root, relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", String(relativePath || "")], { cwd: root, windowsHide: true });
  return result.status === 0;
}

function defaultReportPath() {
  return path.join("harness", "reports", `product-harness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
