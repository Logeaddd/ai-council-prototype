import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function runProductHarnessCheck(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const manifestPath = path.resolve(root, options.manifestPath || path.join("config", "product-harness.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const testEvidence = options.runTests === false ? { status: "not_run", reason: "tests_not_requested" } : runTestSuite(root, options);
  return writeProductHarnessReport({ root, manifest, manifestPath, testEvidence, options });
}

export async function runProductHarnessCheckAsync(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const manifestPath = path.resolve(root, options.manifestPath || path.join("config", "product-harness.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const testEvidence = options.runTests === false
    ? { status: "not_run", reason: "tests_not_requested" }
    : await runTestSuiteAsync(root, options);
  return writeProductHarnessReport({ root, manifest, manifestPath, testEvidence, options });
}

function writeProductHarnessReport({ root, manifest, manifestPath, testEvidence, options }) {
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
  const evidenceReports = selectCampaignEvidenceReports(reports, gate);
  const passedReports = evidenceReports.filter(({ report }) => (
    report.status === "passed"
    && report.providerAcceptance?.realProvider === true
    && Number(report.providerAcceptance?.blockedBeforeSendModelCalls || 0) === 0
    && report.autonomousExecution?.passed === true
    && report.minimumUsableDelivery?.passed === true
    && report.autonomousExecution?.resumedAfterInterruption === true
    && report.persistence?.passed === true
    && report.recovery?.passed === true
    && hasCompleteContinuationEvidence(report)
    && Number(report.providerAcceptance?.observedModelCalls || report.sessions?.modelCalls || 0) > 0
    && (gate.requireDelegationEvidence !== true || report.collaboration?.passed === true)
  ));
  const requiredFamilies = Array.isArray(gate.requiredFamilies) ? gate.requiredFamilies : [];
  const defaultMinimumFamilyAttempts = positiveInteger(gate.minimumAttemptsPerFamily, 1);
  const defaultMinimumFamilyPasses = positiveInteger(gate.minimumPassedReportsPerFamily, 1);
  const familyEvidence = requiredFamilies.map((family) => {
    const taskIds = new Set((Array.isArray(family.taskIds) ? family.taskIds : []).map(String));
    const attempts = evidenceReports.filter(({ report }) => {
      const taskId = campaignTaskId(report);
      return taskIds.size === 0 || taskIds.has(taskId);
    });
    const matches = passedReports.filter(({ report }) => {
      const taskId = campaignTaskId(report);
      if (taskIds.size > 0 && !taskIds.has(taskId)) return false;
      if (family.requireAcquisitionEvidence && report.capabilityAcquisition?.passed !== true) return false;
      return true;
    });
    const minimumAttempts = positiveInteger(family.minimumAttempts, defaultMinimumFamilyAttempts);
    const minimumPasses = positiveInteger(family.minimumPassedReports, defaultMinimumFamilyPasses);
    return {
      id: String(family.id || ""),
      passed: attempts.length >= minimumAttempts && matches.length >= minimumPasses,
      attempts: attempts.length,
      passedReports: matches.length,
      minimumAttempts,
      minimumPassedReports: minimumPasses,
      taskIds: [...new Set(matches.map(({ report }) => campaignTaskId(report)).filter(Boolean))],
      reports: matches.map(({ filePath }) => path.relative(root, filePath).replaceAll("\\", "/"))
    };
  });
  const distinctTaskIds = new Set(passedReports.map(({ report }) => campaignTaskId(report)).filter(Boolean));
  const distinctSeeds = new Set(passedReports.map(({ report }) => String(report.seed ?? "")).filter(Boolean));
  const minimumPassedReports = positiveInteger(gate.minimumPassedReports, 1);
  const minimumDistinctTaskIds = positiveInteger(gate.minimumDistinctTaskIds, requiredFamilies.length > 0 ? requiredFamilies.length : 1);
  const minimumDistinctSeeds = positiveInteger(gate.minimumDistinctSeeds, 1);
  const minimumPassRate = campaignPassRate(gate.minimumPassRate);
  const passRate = evidenceReports.length > 0 ? passedReports.length / evidenceReports.length : 0;
  const latestTaskEvidence = latestCampaignTaskEvidence(evidenceReports, root, gate);
  const latestTasksPassed = gate.requireLatestPerTaskPass !== true || latestTaskEvidence.every((item) => item.status === "passed");
  const matrixPassed = passedReports.length >= minimumPassedReports
    && distinctTaskIds.size >= minimumDistinctTaskIds
    && distinctSeeds.size >= minimumDistinctSeeds
    && passRate >= minimumPassRate
    && latestTasksPassed
    && familyEvidence.every((family) => family.passed);
  const passed = requiredFamilies.length > 0 || minimumPassedReports > 1 || minimumDistinctTaskIds > 1 || minimumDistinctSeeds > 1 || minimumPassRate > 0 || gate.requireLatestPerTaskPass === true
    ? matrixPassed
    : passedReports.length > 0;
  return {
    ...base,
    status: passed ? "passed" : "failed",
    evidence: {
      reportsRoot: path.relative(root, reportsRoot).replaceAll("\\", "/"),
      matchingReports: reports.length,
      evaluatedReports: evidenceReports.length,
      failedReports: evidenceReports.filter(({ report }) => !campaignReportPassesGate(report, gate)).map(({ filePath }) => path.relative(root, filePath).replaceAll("\\", "/")),
      passedReports: passedReports.map(({ filePath }) => path.relative(root, filePath).replaceAll("\\", "/")),
      minimumPassedReports,
      minimumDistinctTaskIds,
      minimumDistinctSeeds,
      evidenceWindowPerTask: optionalPositiveInteger(gate.evidenceWindowPerTask),
      requireDelegationEvidence: gate.requireDelegationEvidence === true,
      passRate,
      minimumPassRate,
      requireLatestPerTaskPass: gate.requireLatestPerTaskPass === true,
      latestTasksPassed,
      latestTaskEvidence,
      distinctTaskIds: [...distinctTaskIds],
      distinctSeeds: [...distinctSeeds],
      requiredFamilies: familyEvidence,
      passedReport: passed && passedReports.length === 1 ? path.relative(root, passedReports[0].filePath).replaceAll("\\", "/") : ""
    }
  };
}

function selectCampaignEvidenceReports(reports, gate) {
  const windowSize = optionalPositiveInteger(gate.evidenceWindowPerTask);
  const sorted = [...reports].sort((left, right) => campaignReportTime(right) - campaignReportTime(left));
  if (!windowSize) return sorted;
  const counts = new Map();
  return sorted.filter(({ report }) => {
    const taskId = campaignTaskId(report) || "(unknown)";
    const count = counts.get(taskId) || 0;
    if (count >= windowSize) return false;
    counts.set(taskId, count + 1);
    return true;
  });
}

function latestCampaignTaskEvidence(reports, root, gate = {}) {
  const latest = new Map();
  for (const item of reports) {
    const taskId = campaignTaskId(item.report);
    if (!taskId || latest.has(taskId)) continue;
    latest.set(taskId, {
      taskId,
      status: campaignReportPassesGate(item.report, gate) ? "passed" : "failed",
      report: path.relative(root, item.filePath).replaceAll("\\", "/")
    });
  }
  return [...latest.values()];
}

function campaignReportPassesGate(report = {}, gate = {}) {
  return report.status === "passed"
    && (gate.requireDelegationEvidence !== true || report.collaboration?.passed === true);
}

function campaignTaskId(report) {
  return String(report?.scenario?.task?.id || "");
}

function campaignReportTime(item) {
  const parsed = Date.parse(item.report?.completedAt || item.report?.startedAt || "");
  if (Number.isFinite(parsed)) return parsed;
  try { return fs.statSync(item.filePath).mtimeMs; } catch { return 0; }
}

function campaignPassRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function hasCompleteContinuationEvidence(report) {
  const interruptionCount = Array.isArray(report.sessions?.interrupted) ? report.sessions.interrupted.length : 0;
  const continuationChecks = (Array.isArray(report.recovery?.checks) ? report.recovery.checks : [])
    .filter((item) => item?.id === "continuation_completed_visible_work" && item.passed === true);
  return interruptionCount > 0 && continuationChecks.length >= interruptionCount;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function optionalPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
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

async function runTestSuiteAsync(root, options) {
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
  const progressIntervalMs = testSuiteProgressIntervalMs(options.progressIntervalMs);
  const emitProgress = (event) => {
    if (typeof options.onProgress !== "function") return;
    options.onProgress({ ...event, elapsedMs: Date.now() - started });
  };
  let stdout = "";
  let stderr = "";
  let lastOutputAt = started;
  let timedOut = false;
  let timer = null;
  let heartbeat = null;
  const child = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...testFiles], {
    cwd: root,
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  emitProgress({
    type: "test_suite_started",
    testFiles: testFiles.map((file) => file.replaceAll("\\", "/")),
    concurrency,
    timeoutMs: timeout ?? null
  });
  const capture = (source, chunk) => {
    const output = String(chunk || "");
    lastOutputAt = Date.now();
    if (source === "stdout") stdout = appendOutputTail(stdout, output);
    else stderr = appendOutputTail(stderr, output);
    emitProgress({ type: "test_output", source, output });
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  if (timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      emitProgress({ type: "test_suite_timeout", timeoutMs: timeout });
      child.kill();
    }, timeout);
  }
  heartbeat = setInterval(() => {
    const now = Date.now();
    emitProgress({
      type: "test_suite_waiting",
      processAlive: child.exitCode === null && child.signalCode === null,
      silenceMs: now - lastOutputAt
    });
  }, progressIntervalMs);
  const completion = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ exitCode: null, signal: null, error }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal, error: null }));
  });
  if (timer) clearTimeout(timer);
  if (heartbeat) clearInterval(heartbeat);
  const error = completion.error ? String(completion.error.message || completion.error) : "";
  const status = !timedOut && !error && completion.exitCode === 0 ? "passed" : "failed";
  const evidence = {
    status,
    exitCode: completion.exitCode,
    signal: completion.signal || "",
    durationMs: Date.now() - started,
    tests: outputCount(stdout, "tests"),
    passed: outputCount(stdout, "pass"),
    failed: outputCount(stdout, "fail"),
    stdout,
    stderr,
    error: timedOut ? `test_suite_timeout_after_${timeout}ms` : error
  };
  emitProgress({
    type: "test_suite_finished",
    status: evidence.status,
    exitCode: evidence.exitCode,
    signal: evidence.signal,
    tests: evidence.tests,
    passed: evidence.passed,
    failed: evidence.failed
  });
  return evidence;
}

export function testSuiteTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

export function testSuiteConcurrency(value) {
  const concurrency = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1;
}

export function testSuiteProgressIntervalMs(value) {
  const interval = Number(value);
  return Number.isFinite(interval) && interval > 0 ? interval : 15000;
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

function appendOutputTail(previous, next, maximumLength = 12000) {
  return `${previous}${next}`.slice(-maximumLength);
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
