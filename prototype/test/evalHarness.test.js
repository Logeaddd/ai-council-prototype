import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { EVAL_MODES, compareEvalReports, loadEvalTasks, runEvalHarness, runEvalMode } from "../src/evalHarness.js";

test("eval tasks load pilot set", () => {
  const tasks = loadEvalTasks(path.resolve("eval", "tasks.json"));
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].reviewIntensity, 1);
  assert.match(tasks[0].prompt, /sumNumbers/);
  assert.match(tasks[1].title, /计划书/);
  assert.match(tasks[2].title, /哲学/);
});

test("eval modes return comparable accounting records", async () => {
  const task = {
    id: "unit",
    prompt: "Write hello world.",
    expectedKeywords: ["hello"],
    reviewIntensity: 1,
    maxRounds: 1
  };

  for (const mode of EVAL_MODES) {
    const record = await runEvalMode(mode, task, { matchedCalls: 3 });
    assert.equal(typeof record.calls, "number");
    assert.equal(typeof record.planned_calls, "number");
    assert.equal(typeof record.input_tokens, "number");
    assert.equal(typeof record.output_tokens, "number");
    assert.equal(record.total_tokens, record.input_tokens + record.output_tokens);
    assert.ok(record.final_state);
    assert.equal(typeof record.answer, "string");
    assert.ok(Array.isArray(record.model_call_records));
    assert.equal(record.model_call_records.length, record.calls);
    assert.ok(record.call_diagnostics);
    assert.ok(Array.isArray(record.call_diagnostics.top_calls));
    for (const call of record.model_call_records) {
      assert.ok(Array.isArray(call.inputMessages));
      assert.equal(typeof call.rawText, "string");
      assert.equal(call.total_tokens, call.input_tokens + call.output_tokens);
    }
  }
});

test("single budget matched defaults to the council call count in harness runs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-matched-"));
  const tasksPath = path.join(tmp, "tasks.json");
  fs.writeFileSync(tasksPath, JSON.stringify({
    tasks: [
      {
        id: "unit",
        prompt: "Write hello world.",
        expectedKeywords: ["hello"],
        reviewIntensity: 1,
        maxRounds: 1
      }
    ]
  }), "utf8");

  const { report } = await runEvalHarness({
    baseDir: tmp,
    tasksPath,
    outputDir: path.join(tmp, "report")
  });
  const council = report.records.find((record) => record.mode === "council-current");
  const matched = report.records.find((record) => record.mode === "single-budget-matched");
  assert.ok(council.calls > 0);
  assert.equal(matched.planned_calls, council.calls);
});

test("single budget matched spends the full matched call budget even after skip", async () => {
  const task = {
    id: "unit",
    prompt: "Write hello world.",
    expectedKeywords: ["hello"]
  };
  const seen = [];
  const record = await runEvalMode("single-budget-matched", task, {
    matchedCalls: 3,
    async modelCaller(call) {
      seen.push(call.callIndex);
      if (call.callIndex === 1) return "hello draft";
      if (call.callIndex === 2) return "skip";
      return "hello final";
    }
  });

  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(record.calls, 3);
  assert.equal(record.planned_calls, 3);
  assert.equal(record.answer, "hello final");
});

test("eval modes can use a real-call compatible modelCaller with provider usage", async () => {
  const seen = [];
  const task = {
    id: "unit",
    prompt: "Write hello world.",
    expectedKeywords: ["hello"]
  };
  const record = await runEvalMode("single-budget-matched", task, {
    matchedCalls: 2,
    async modelCaller(call) {
      seen.push(call);
      return {
        text: call.callIndex === 1 ? "hello draft" : "hello world final",
        usage: { input_tokens: 10 + call.callIndex, output_tokens: 2 }
      };
    }
  });

  assert.equal(seen.length, 2);
  assert.equal(record.input_tokens, 23);
  assert.equal(record.output_tokens, 4);
  assert.equal(record.total_tokens, 27);
  assert.equal(record.token_accounting, "provider_usage");
  assert.equal(record.call_diagnostics.by_agent["Single AI"].calls, 2);
  assert.equal(record.call_diagnostics.top_calls[0].total_tokens, 14);
  assert.match(record.model_call_records[0].inputMessages[1].content, /User task/);
});

test("eval CLI can run with a provided mock group for all comparison modes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-cli-"));
  const tasksPath = path.join(tmp, "tasks.json");
  const groupPath = path.join(tmp, "group.json");
  const outputDir = path.join(tmp, "report");
  fs.writeFileSync(tasksPath, JSON.stringify({
    tasks: [
      {
        id: "unit",
        prompt: "Write hello world.",
        expectedKeywords: ["hello"],
        reviewIntensity: 1,
        maxRounds: 1
      }
    ]
  }), "utf8");
  fs.writeFileSync(groupPath, JSON.stringify({
    id: "eval-real-shape",
    name: "Eval real shape",
    settings: { maxRounds: 1, minConsensusWeight: 0.75, stopWhenAllSkip: true },
    agents: [
      { id: "builder", name: "Builder", role: "Builder", provider: "mock", apiBaseUrl: "mock://local", model: "mock-builder", weight: 1, enabled: true },
      { id: "red", name: "Red Team", role: "Red Team", provider: "mock", apiBaseUrl: "mock://local", model: "mock-red", weight: 1, enabled: true, mandatoryRedTeam: true },
      { id: "judge", name: "Judge", role: "Judge", provider: "mock", apiBaseUrl: "mock://local", model: "mock-judge", weight: 1, enabled: true, judge: true }
    ]
  }), "utf8");

  const stdout = execFileSync(process.execPath, [
    "src/cli.js",
    "eval",
    "--tasks", tasksPath,
    "--output", outputDir,
    "--group", groupPath
  ], { cwd: path.resolve("."), encoding: "utf8" });
  const printed = JSON.parse(stdout);
  assert.equal(printed.records, EVAL_MODES.length);
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "raw.json"), "utf8"));
  const matched = report.records.find((record) => record.mode === "single-budget-matched");
  const council = report.records.find((record) => record.mode === "council-current");
  assert.equal(matched.planned_calls, council.calls);
  assert.ok(matched.model_call_records.every((call) => call.agentName === "Single AI"));
});

test("eval CLI can compare two report paths", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-cli-compare-"));
  const baselineDir = path.join(tmp, "baseline");
  const candidateDir = path.join(tmp, "candidate");
  fs.mkdirSync(baselineDir);
  fs.mkdirSync(candidateDir);
  fs.writeFileSync(path.join(baselineDir, "raw.json"), JSON.stringify({
    records: [
      { task_id: "task", mode: "council-current", calls: 1, input_tokens: 10, output_tokens: 5, total_tokens: 15, elapsed_ms: 100, final_state: "ready_to_execute" },
      { task_id: "task", mode: "single-once", calls: 1, input_tokens: 3, output_tokens: 2, total_tokens: 5, elapsed_ms: 20, final_state: "ready_to_execute" }
    ]
  }), "utf8");
  fs.writeFileSync(path.join(candidateDir, "raw.json"), JSON.stringify({
    records: [
      { task_id: "task", mode: "council-current", calls: 1, input_tokens: 8, output_tokens: 5, total_tokens: 13, elapsed_ms: 90, final_state: "ready_to_execute" },
      { task_id: "task", mode: "single-once", calls: 1, input_tokens: 30, output_tokens: 20, total_tokens: 50, elapsed_ms: 200, final_state: "ready_to_execute" }
    ]
  }), "utf8");

  const stdout = execFileSync(process.execPath, [
    "src/cli.js",
    "eval-compare",
    "--baseline", baselineDir,
    "--candidate", candidateDir,
    "--mode", "council-current"
  ], { cwd: path.resolve("."), encoding: "utf8" });
  const printed = JSON.parse(stdout);
  assert.equal(printed.filter_mode, "council-current");
  assert.equal(printed.totals.total_tokens.delta, -2);
  assert.equal(printed.by_task.task.total_tokens.candidate, 13);
  assert.equal(printed.by_mode["single-once"], undefined);
});

test("eval accounting labels mixed provider and estimated records distinctly", async () => {
  const task = {
    id: "unit",
    prompt: "Write hello world.",
    expectedKeywords: ["hello"]
  };
  const record = await runEvalMode("single-budget-matched", task, {
    matchedCalls: 2,
    async modelCaller(call) {
      if (call.callIndex === 1) {
        return { text: "hello draft", usage: { input_tokens: 7, output_tokens: 2 } };
      }
      return "hello world final";
    }
  });

  assert.equal(record.token_accounting, "mixed_provider_usage_and_estimated");
});

test("eval report comparison summarizes token and state deltas", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-compare-"));
  const baselineDir = path.join(tmp, "baseline");
  const candidateDir = path.join(tmp, "candidate");
  fs.mkdirSync(baselineDir);
  fs.mkdirSync(candidateDir);
  fs.writeFileSync(path.join(baselineDir, "raw.json"), JSON.stringify({
    records: [
      { task_id: "task-1", mode: "council-current", calls: 2, input_tokens: 100, output_tokens: 50, total_tokens: 150, elapsed_ms: 1000, final_state: "ready_to_execute", quality_score: 1 },
      { task_id: "task-1", mode: "single-once", calls: 1, input_tokens: 20, output_tokens: 10, total_tokens: 30, elapsed_ms: 300, final_state: "ready_to_execute", quality_score: 1 }
    ]
  }), "utf8");
  fs.writeFileSync(path.join(candidateDir, "raw.json"), JSON.stringify({
    records: [
      { task_id: "task-1", mode: "council-current", calls: 3, input_tokens: 90, output_tokens: 80, total_tokens: 170, elapsed_ms: 1200, final_state: "usable_with_risks", quality_score: 1 },
      { task_id: "task-1", mode: "single-once", calls: 1, input_tokens: 20, output_tokens: 8, total_tokens: 28, elapsed_ms: 250, final_state: "ready_to_execute", quality_score: 1 }
    ]
  }), "utf8");

  const comparison = compareEvalReports({ baselinePath: baselineDir, candidatePath: path.join(candidateDir, "raw.json") });
  assert.equal(comparison.totals.total_tokens.delta, 18);
  assert.equal(comparison.totals.total_tokens.percent, 10);
  assert.equal(comparison.by_mode["council-current"].input_tokens.delta, -10);
  const councilRow = comparison.rows.find((row) => row.task_id === "task-1" && row.mode === "council-current");
  assert.equal(councilRow.final_state_changed, true);
  assert.equal(councilRow.delta.calls.delta, 1);

  const filtered = compareEvalReports({ baselinePath: baselineDir, candidatePath: candidateDir, mode: "council-current" });
  assert.equal(filtered.filter_mode, "council-current");
  assert.equal(filtered.totals.total_tokens.delta, 20);
  assert.deepEqual(Object.keys(filtered.by_mode), ["council-current"]);
  assert.equal(filtered.rows.length, 1);
});

test("eval harness writes raw json, csv, and utf8 html report", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-report-"));
  const tasksPath = path.join(tmp, "tasks.json");
  fs.writeFileSync(tasksPath, JSON.stringify({
    tasks: [
      {
        id: "unit",
        prompt: "Write hello world.",
        expectedKeywords: ["hello"],
        reviewIntensity: 1,
        maxRounds: 1
      }
    ]
  }), "utf8");

  const { outputDir, report } = await runEvalHarness({
    baseDir: tmp,
    tasksPath,
    outputDir: path.join(tmp, "report"),
    matchedCalls: 2
  });

  assert.equal(report.records.length, EVAL_MODES.length);
  assert.ok(fs.existsSync(path.join(outputDir, "raw.json")));
  assert.ok(fs.existsSync(path.join(outputDir, "summary.csv")));
  const csv = fs.readFileSync(path.join(outputDir, "summary.csv"), "utf8");
  assert.match(csv.split("\n")[0], /token_accounting/);
  assert.match(csv.split("\n")[0], /top_call/);
  assert.match(csv.split("\n")[0], /top_call_total_tokens/);
  assert.match(csv.split("\n")[0], /answer_chars/);
  const html = fs.readFileSync(path.join(outputDir, "clean.html"), "utf8");
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /AI Council Eval Report/);
  assert.match(html, /Top call/);
  assert.match(html, /Token hotspots/);
  assert.match(html, /整体汇总/);
  assert.match(html, /A 实验组：当前议会/);
  assert.match(html, /统计来源/);
  assert.match(html, /调用明细/);
  assert.match(html, /相对 A/);
  assert.match(html, /quality_score is a keyword-coverage placeholder/);
  const raw = JSON.parse(fs.readFileSync(path.join(outputDir, "raw.json"), "utf8"));
  assert.ok(raw.records.every((record) => record.call_diagnostics?.top_calls?.length));
});
