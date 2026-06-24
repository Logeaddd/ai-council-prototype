import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runCouncil } from "./discussionEngine.js";
import { callAgent } from "./modelClient.js";
import { estimateMessagesTokens, estimateTokens } from "./tokenLimits.js";
import { nowIso } from "./types.js";

export const EVAL_MODES = [
  "council-current",
  "naive-chain",
  "single-once",
  "single-budget-matched"
];

const MODE_LABELS = {
  "council-current": "A 实验组：当前议会",
  "naive-chain": "B 对照：朴素多 AI 串行",
  "single-once": "C 对照：单 AI 一次",
  "single-budget-matched": "D 对照：单 AI 等调用次数"
};

export async function runEvalHarness(options = {}) {
  const tasks = loadEvalTasks(options.tasksPath);
  const modes = options.modes?.length ? options.modes : EVAL_MODES;
  const outputDir = options.outputDir || defaultReportDir(options.baseDir || process.cwd());
  fs.mkdirSync(outputDir, { recursive: true });

  const records = [];
  for (const task of tasks) {
    let councilCallsForTask;
    for (const mode of modes) {
      const started = performance.now();
      const record = await runEvalMode(mode, task, {
        ...options,
        matchedCalls: mode === "single-budget-matched"
          ? (councilCallsForTask ?? options.matchedCalls)
          : options.matchedCalls
      });
      if (mode === "council-current") councilCallsForTask = record.calls;
      records.push({
        task_id: task.id,
        task_complexity: task.complexity || "unknown",
        mode,
        ...record,
        elapsed_ms: Math.round(performance.now() - started)
      });
    }
  }

  const report = {
    created_at: nowIso(),
    modes,
    notes: [
      "Token totals include every recorded model call input and output.",
      "token_accounting marks whether counts came from provider usage, local estimation, or a mix.",
      "quality_score is a keyword-coverage placeholder, not a blind human or third-party model grade."
    ],
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      complexity: task.complexity,
      reviewIntensity: task.reviewIntensity,
      maxRounds: task.maxRounds,
      prompt: task.prompt,
      expectedKeywords: task.expectedKeywords || []
    })),
    records
  };
  writeEvalReport(outputDir, report);
  return { outputDir, report };
}

export function loadEvalTasks(tasksPath) {
  const filePath = tasksPath || new URL("../eval/tasks.json", import.meta.url);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("Eval tasks file must contain tasks");
  return tasks;
}

export async function runEvalMode(mode, task, options = {}) {
  if (!EVAL_MODES.includes(mode)) throw new Error(`Unknown eval mode: ${mode}`);
  if (mode === "council-current") return runCouncilCurrent(task, options);
  if (mode === "naive-chain") return runNaiveChain(task, options);
  if (mode === "single-once") return runSingleMode(task, { ...options, calls: 1, mode });
  return runSingleMode(task, { ...options, calls: matchedCallBudget(options), mode });
}

export function writeEvalReport(outputDir, report) {
  fs.writeFileSync(path.join(outputDir, "raw.json"), JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(path.join(outputDir, "summary.csv"), toCsv(report.records), "utf8");
  fs.writeFileSync(path.join(outputDir, "clean.html"), toCleanHtml(report), "utf8");
}

export function compareEvalReports({ baselinePath, candidatePath, mode } = {}) {
  if (!baselinePath || !candidatePath) throw new Error("compareEvalReports requires baselinePath and candidatePath");
  if (mode && !EVAL_MODES.includes(mode)) throw new Error(`Unknown eval compare mode: ${mode}`);
  const baseline = readEvalReport(baselinePath);
  const candidate = readEvalReport(candidatePath);
  const baselineComparableRecords = filterComparableRecords(baseline.records || [], { mode });
  const candidateComparableRecords = filterComparableRecords(candidate.records || [], { mode });
  const baselineRecords = new Map(baselineComparableRecords.map((record) => [recordKey(record), record]));
  const candidateRecords = new Map(candidateComparableRecords.map((record) => [recordKey(record), record]));
  const keys = [...new Set([...baselineRecords.keys(), ...candidateRecords.keys()])].sort();
  const rows = keys.map((key) => compareRecordPair(key, baselineRecords.get(key), candidateRecords.get(key)));
  const byMode = compareAggregates("mode", baselineComparableRecords, candidateComparableRecords);
  const byTask = compareAggregates("task_id", baselineComparableRecords, candidateComparableRecords);
  return {
    baseline: normalizeReportPath(baselinePath),
    candidate: normalizeReportPath(candidatePath),
    filter_mode: mode || "",
    created_at: nowIso(),
    totals: compareTotals(sumRecords(baselineComparableRecords), sumRecords(candidateComparableRecords)),
    by_mode: byMode,
    by_task: byTask,
    rows
  };
}

async function runCouncilCurrent(task, options) {
  const group = options.groupFactory ? options.groupFactory(task) : mockCouncilGroup(task);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-eval-"));
  const modelCallRecords = [];
  const result = await runCouncil(task.prompt, group, baseDir, {
    globalRequirement: task.globalRequirement || "",
    onModelCall(record) {
      modelCallRecords.push(record);
      options.onModelCall?.({
        mode: "council-current",
        task,
        record
      });
    }
  });
  const callAccounting = accountRecordedCalls(modelCallRecords);
  const normalizedCallRecords = normalizeCouncilCallRecords(modelCallRecords);
  return {
    calls: modelCallRecords.length,
    planned_calls: modelCallRecords.length,
    rounds: uniqueRounds(result.session.messages),
    final_state: result.session.finalDecision.final_state,
    unresolved_blockers: result.session.finalDecision.blocking_issues?.length || 0,
    answer: result.session.finalDecision.answer,
    quality_score: scoreTaskResult(task, result.session.finalDecision.answer),
    input_tokens: callAccounting.inputTokens,
    output_tokens: callAccounting.outputTokens,
    total_tokens: callAccounting.totalTokens,
    token_accounting: callAccounting.source,
    model_call_records: normalizedCallRecords,
    call_diagnostics: summarizeCallDiagnostics(normalizedCallRecords)
  };
}

function readEvalReport(value) {
  const filePath = fs.statSync(value).isDirectory() ? path.join(value, "raw.json") : value;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeReportPath(value) {
  return fs.statSync(value).isDirectory() ? path.join(value, "raw.json") : value;
}

function filterComparableRecords(records, { mode } = {}) {
  return mode ? records.filter((record) => record.mode === mode) : records;
}

function recordKey(record = {}) {
  return `${record.task_id || ""}\t${record.mode || ""}`;
}

function compareRecordPair(key, baseline, candidate) {
  const [taskId, mode] = key.split("\t");
  return {
    task_id: taskId,
    mode,
    baseline: summarizeComparableRecord(baseline),
    candidate: summarizeComparableRecord(candidate),
    delta: compareTotals(summarizeComparableRecord(baseline), summarizeComparableRecord(candidate)),
    final_state_changed: Boolean(baseline && candidate && baseline.final_state !== candidate.final_state),
    missing: baseline ? (candidate ? "" : "candidate") : "baseline"
  };
}

function summarizeComparableRecord(record) {
  if (!record) return undefined;
  return {
    calls: Number(record.calls || 0),
    input_tokens: Number(record.input_tokens || 0),
    output_tokens: Number(record.output_tokens || 0),
    total_tokens: Number(record.total_tokens || 0),
    elapsed_ms: Number(record.elapsed_ms || 0),
    final_state: record.final_state || "",
    quality_score: typeof record.quality_score === "number" ? record.quality_score : undefined
  };
}

function compareAggregates(field, baselineRecords, candidateRecords) {
  const baselineGroups = groupRecords(field, baselineRecords);
  const candidateGroups = groupRecords(field, candidateRecords);
  const keys = [...new Set([...Object.keys(baselineGroups), ...Object.keys(candidateGroups)])].sort();
  return Object.fromEntries(keys.map((key) => [
    key,
    compareTotals(sumRecords(baselineGroups[key] || []), sumRecords(candidateGroups[key] || []))
  ]));
}

function groupRecords(field, records = []) {
  return records.reduce((groups, record) => {
    const key = record[field] || "";
    groups[key] ||= [];
    groups[key].push(record);
    return groups;
  }, {});
}

function sumRecords(records = []) {
  return {
    calls: records.reduce((sum, record) => sum + Number(record.calls || 0), 0),
    input_tokens: records.reduce((sum, record) => sum + Number(record.input_tokens || 0), 0),
    output_tokens: records.reduce((sum, record) => sum + Number(record.output_tokens || 0), 0),
    total_tokens: records.reduce((sum, record) => sum + Number(record.total_tokens || 0), 0),
    elapsed_ms: records.reduce((sum, record) => sum + Number(record.elapsed_ms || 0), 0)
  };
}

function compareTotals(baseline = {}, candidate = {}) {
  const fields = ["calls", "input_tokens", "output_tokens", "total_tokens", "elapsed_ms"];
  return Object.fromEntries(fields.map((field) => [
    field,
    deltaNumber(Number(baseline?.[field] || 0), Number(candidate?.[field] || 0))
  ]));
}

function deltaNumber(baseline, candidate) {
  const delta = candidate - baseline;
  return {
    baseline,
    candidate,
    delta,
    percent: baseline ? Number(((delta / baseline) * 100).toFixed(1)) : undefined
  };
}

async function runNaiveChain(task, options) {
  const agents = options.naiveAgents || ["Agent A", "Agent B", "Agent C"];
  const transcript = [];
  const callRecords = [];
  for (const agent of agents) {
    const messages = buildNaiveChainMessages(task, transcript);
    const call = await callEvalModel({
      mode: "naive-chain",
      task,
      agentName: agent,
      callIndex: transcript.length + 1,
      totalCalls: agents.length,
      messages,
      options
    });
    callRecords.push(call);
    if (isSkipText(call.outputText) && transcript.length) break;
    transcript.push({ agent, output: call.outputText });
  }
  const answer = transcript.map((item) => item.output).join("\n");
  const callAccounting = accountRecordedCalls(callRecords);
  const callDiagnostics = summarizeCallDiagnostics(callRecords);
  return {
    calls: callRecords.length,
    planned_calls: agents.length,
    rounds: 1,
    final_state: answer ? "ready_to_execute" : "failed_to_converge",
    unresolved_blockers: 0,
    answer,
    input_tokens: callAccounting.inputTokens,
    output_tokens: callAccounting.outputTokens,
    total_tokens: callAccounting.totalTokens,
    token_accounting: callAccounting.source,
    quality_score: scoreTaskResult(task, answer),
    model_call_records: callRecords,
    call_diagnostics: callDiagnostics
  };
}

async function runSingleMode(task, options = {}) {
  const calls = Math.max(1, Number(options.calls || 1));
  const callRecords = [];
  let answer = "";
  for (let index = 0; index < calls; index += 1) {
    const messages = buildSingleMessages(task, answer, index, calls);
    const call = await callEvalModel({
      mode: options.mode || "single",
      task,
      agentName: "Single AI",
      callIndex: index + 1,
      totalCalls: calls,
      messages,
      options
    });
    callRecords.push(call);
    if (options.mode !== "single-budget-matched" && isSkipText(call.outputText) && answer) break;
    answer = call.outputText;
  }
  const callAccounting = accountRecordedCalls(callRecords);
  const callDiagnostics = summarizeCallDiagnostics(callRecords);
  return {
    calls: callRecords.length,
    planned_calls: calls,
    rounds: callRecords.length,
    final_state: "ready_to_execute",
    unresolved_blockers: 0,
    answer,
    input_tokens: callAccounting.inputTokens,
    output_tokens: callAccounting.outputTokens,
    total_tokens: callAccounting.totalTokens,
    token_accounting: callAccounting.source,
    quality_score: scoreTaskResult(task, answer),
    model_call_records: callRecords,
    call_diagnostics: callDiagnostics
  };
}

async function callEvalModel({ mode, task, agentName, callIndex, totalCalls, messages, options = {} }) {
  const started = performance.now();
  let text;
  let usage;
  if (typeof options.modelCaller === "function") {
    const value = await options.modelCaller({ mode, task, agentName, callIndex, totalCalls, messages });
    if (typeof value === "string") {
      text = value;
    } else {
      text = value?.text ?? value?.rawText ?? "";
      usage = value?.usage;
    }
  } else if (options.baselineAgent || options.baselineAgentFactory) {
    const agent = options.baselineAgentFactory
      ? options.baselineAgentFactory({ mode, task, agentName, callIndex, totalCalls })
      : options.baselineAgent;
    text = await callAgent(agent, messages, { timeoutMs: options.timeoutMs || 60000 });
  } else {
    text = mockEvalAnswer({ mode, task, callIndex, totalCalls });
  }
  const elapsedMs = Math.round(performance.now() - started);
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? estimateMessagesTokens(messages);
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? estimateTokens(text);
  return {
    phase: "baseline",
    mode,
    agentName,
    callIndex,
    totalCalls,
    inputMessages: messages,
    rawText: text,
    outputText: text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    token_accounting: usage ? "provider_usage" : "estimated",
    elapsed_ms: elapsedMs
  };
}

function buildNaiveChainMessages(task, transcript) {
  return [
    {
      role: "system",
      content: "You are a plain AI assistant. Do not use role specialization, artifacts, file-operation protocols, or indexed handoff. If the previous answer fully solves the task, return exactly: skip"
    },
    {
      role: "user",
      content: [
        `User task:\n${task.prompt}`,
        transcript.length
          ? `Prior plain chain transcript:\n${transcript.map((item) => `${item.agent}: ${item.output}`).join("\n\n")}`
          : "",
        "Answer the task directly. If no change is needed, return exactly: skip"
      ].filter(Boolean).join("\n\n")
    }
  ];
}

function buildSingleMessages(task, priorAnswer, index, calls) {
  return [
    {
      role: "system",
      content: "You are a single AI assistant solving the task directly. Do not simulate multiple named roles. If the prior draft is already complete, return exactly: skip"
    },
    {
      role: "user",
      content: [
        `User task:\n${task.prompt}`,
        priorAnswer
          ? `Prior draft from your earlier pass:\n${priorAnswer}\n\nPass ${index + 1} of ${calls}: improve the draft if needed.`
          : `Pass ${index + 1} of ${calls}: produce the best answer you can.`,
        priorAnswer ? "If it is already complete, return exactly: skip" : ""
      ].filter(Boolean).join("\n\n")
    }
  ];
}

function mockCouncilGroup(task) {
  return {
    id: `eval-${task.id}`,
    name: `Eval ${task.id}`,
    settings: {
      maxRounds: task.maxRounds || 2,
      minConsensusWeight: 0.75,
      stopWhenAllSkip: true,
      agentTimeoutMs: 1000
    },
    agents: [
      { id: "architect", name: "Architect", role: "Architect", provider: "mock", apiBaseUrl: "mock://local", model: "mock-builder", weight: 1, enabled: true },
      { id: "red", name: "Red Team", role: "Red Team", provider: "mock", apiBaseUrl: "mock://local", model: "mock-critic", weight: 1, enabled: true, mandatoryRedTeam: true, reviewIntensity: task.reviewIntensity || 2 },
      { id: "judge", name: "Judge", role: "Judge", provider: "mock", apiBaseUrl: "mock://local", model: "mock-judge", weight: 1, enabled: true, judge: true }
    ]
  };
}

function accountRecordedCalls(records = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let hasProviderUsage = false;
  let hasEstimated = false;
  for (const record of records || []) {
    if (record.input_tokens !== undefined || record.output_tokens !== undefined) {
      inputTokens += Number(record.input_tokens || 0);
      outputTokens += Number(record.output_tokens || 0);
      if (record.token_accounting === "provider_usage") hasProviderUsage = true;
      else hasEstimated = true;
      continue;
    }
    hasEstimated = true;
    inputTokens += estimateMessagesTokens(record.inputMessages || []);
    outputTokens += estimateTokens(record.rawText || record.outputText || "");
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: tokenAccountingSource({ hasProviderUsage, hasEstimated })
  };
}

function tokenAccountingSource({ hasProviderUsage, hasEstimated }) {
  if (hasProviderUsage && hasEstimated) return "mixed_provider_usage_and_estimated";
  if (hasProviderUsage) return "provider_usage";
  return "estimated";
}

function summarizeCallDiagnostics(records = []) {
  const totalsByAgent = {};
  const totalsByPhase = {};
  for (const record of records || []) {
    const agentKey = record.agentName || record.agentId || record.agent || "unknown";
    const phaseKey = record.phase || record.mode || "unknown";
    addDiagnosticTotals(totalsByAgent, agentKey, record);
    addDiagnosticTotals(totalsByPhase, phaseKey, record);
  }
  const topCalls = [...(records || [])]
    .sort((a, b) => Number(b.total_tokens || 0) - Number(a.total_tokens || 0))
    .slice(0, 3)
    .map((record) => ({
      callIndex: record.callIndex,
      phase: record.phase || record.mode || "",
      agentId: record.agentId || "",
      agentName: record.agentName || "",
      input_tokens: Number(record.input_tokens || 0),
      output_tokens: Number(record.output_tokens || 0),
      total_tokens: Number(record.total_tokens || 0),
      input_chars: messageChars(record.inputMessages || []),
      output_chars: String(record.rawText || record.outputText || record.error || "").length
    }));
  return {
    top_calls: topCalls,
    by_agent: objectFromSortedTotals(totalsByAgent),
    by_phase: objectFromSortedTotals(totalsByPhase)
  };
}

function addDiagnosticTotals(target, key, record = {}) {
  target[key] ||= {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_chars: 0,
    output_chars: 0
  };
  target[key].calls += 1;
  target[key].input_tokens += Number(record.input_tokens || 0);
  target[key].output_tokens += Number(record.output_tokens || 0);
  target[key].total_tokens += Number(record.total_tokens || 0);
  target[key].input_chars += messageChars(record.inputMessages || []);
  target[key].output_chars += String(record.rawText || record.outputText || record.error || "").length;
}

function objectFromSortedTotals(value = {}) {
  return Object.fromEntries(
    Object.entries(value).sort((a, b) => Number(b[1].total_tokens || 0) - Number(a[1].total_tokens || 0))
  );
}

function messageChars(messages = []) {
  return (messages || []).reduce((sum, message) => {
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "");
    return sum + content.length;
  }, 0);
}

function normalizeCouncilCallRecords(records = []) {
  return records.map((record, index) => {
    const inputTokens = estimateMessagesTokens(record.inputMessages || []);
    const outputTokens = estimateTokens(record.rawText || "");
    return {
      phase: record.phase,
      round: record.round,
      agentId: record.agentId,
      agentName: record.agentName,
      callIndex: index + 1,
      inputMessages: record.inputMessages || [],
      rawText: record.rawText || "",
      error: record.error,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      token_accounting: "estimated"
    };
  });
}

function matchedCallBudget(options = {}) {
  return Math.max(1, Number(options.matchedCalls || 6));
}

function uniqueRounds(messages = []) {
  return new Set(messages.map((message) => message.round)).size;
}

function mockEvalAnswer({ mode, task, callIndex, totalCalls }) {
  const keywords = task.expectedKeywords || [];
  if ((mode === "naive-chain" || mode === "single-budget-matched") && callIndex > 1 && keywords.length <= 1) {
    return "skip";
  }
  const used = keywords.slice(0, Math.max(1, Math.ceil((keywords.length * callIndex) / totalCalls)));
  return `Answer for ${task.id}: ${used.join(", ") || "complete"}.`;
}

function isSkipText(value) {
  return String(value || "").trim().toLowerCase() === "skip";
}

function scoreTaskResult(task, answer) {
  const keywords = task.expectedKeywords || [];
  if (!keywords.length) return undefined;
  const text = String(answer || "").toLowerCase();
  const hits = keywords.filter((keyword) => text.includes(String(keyword).toLowerCase())).length;
  return Number((hits / keywords.length).toFixed(3));
}

function toCsv(records) {
  const headers = [
    "task_id",
    "task_complexity",
    "mode",
    "calls",
    "planned_calls",
    "rounds",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "token_accounting",
    "top_call",
    "top_call_total_tokens",
    "top_call_input_tokens",
    "elapsed_ms",
    "final_state",
    "unresolved_blockers",
    "quality_score",
    "answer_chars"
  ];
  return [
    headers.join(","),
    ...records.map((record) => headers.map((header) => {
      if (header === "answer_chars") return csvCell(String(record.answer || "").length);
      if (header === "top_call") return csvCell(topCallLabel(record.call_diagnostics?.top_calls?.[0]));
      if (header === "top_call_total_tokens") return csvCell(record.call_diagnostics?.top_calls?.[0]?.total_tokens ?? "");
      if (header === "top_call_input_tokens") return csvCell(record.call_diagnostics?.top_calls?.[0]?.input_tokens ?? "");
      return csvCell(record[header]);
    }).join(","))
  ].join("\n");
}

function toCleanHtml(report) {
  const aggregateRows = aggregateByMode(report.records, report.modes).map((row) => `
    <tr>
      <td>${escapeHtml(modeLabel(row.mode))}</td>
      <td>${escapeHtml(row.tasks)}</td>
      <td>${escapeHtml(row.calls)}</td>
      <td>${escapeHtml(row.input_tokens)}</td>
      <td>${escapeHtml(row.output_tokens)}</td>
      <td>${escapeHtml(row.total_tokens)}</td>
      <td>${escapeHtml(row.elapsed_ms)}</td>
      <td>${escapeHtml(row.avg_quality_score ?? "")}</td>
    </tr>`).join("");

  const taskSections = (report.tasks || []).map((task) => {
    const records = report.records.filter((record) => record.task_id === task.id);
    const council = records.find((record) => record.mode === "council-current");
    const rows = records.map((record) => `
      <tr>
        <td>${escapeHtml(modeLabel(record.mode))}</td>
        <td>${escapeHtml(record.calls)} / ${escapeHtml(record.planned_calls ?? record.calls)}</td>
        <td>${escapeHtml(record.rounds)}</td>
        <td>${escapeHtml(record.input_tokens)}</td>
        <td>${escapeHtml(record.output_tokens)}</td>
        <td>${escapeHtml(record.total_tokens)}</td>
        <td>${escapeHtml(deltaText(record.total_tokens, council?.total_tokens))}</td>
        <td>${escapeHtml(record.elapsed_ms)}</td>
        <td>${escapeHtml(record.token_accounting)}</td>
        <td>${escapeHtml(record.final_state)}</td>
        <td>${escapeHtml(record.unresolved_blockers)}</td>
        <td>${escapeHtml(record.quality_score ?? "")}</td>
        <td>${escapeHtml(topCallLabel(record.call_diagnostics?.top_calls?.[0]))}</td>
      </tr>`).join("");
    const answers = records.map((record) => answerDetails(record)).join("");
    return `
      <section class="task">
        <h2>${escapeHtml(task.title || task.id)}</h2>
        <dl class="meta">
          <div><dt>ID</dt><dd>${escapeHtml(task.id)}</dd></div>
          <div><dt>Complexity</dt><dd>${escapeHtml(task.complexity || "unknown")}</dd></div>
          <div><dt>Review intensity</dt><dd>${escapeHtml(task.reviewIntensity ?? "")}</dd></div>
          <div><dt>Max rounds</dt><dd>${escapeHtml(task.maxRounds ?? "")}</dd></div>
        </dl>
        <details class="prompt" open>
          <summary>题目</summary>
          <pre>${escapeHtml(task.prompt || "")}</pre>
        </details>
        <table>
          <thead>
            <tr>
              <th>组别</th><th>调用</th><th>轮次</th><th>输入 token</th><th>输出 token</th>
              <th>总 token</th><th>相对 A</th><th>耗时 ms</th><th>统计来源</th>
              <th>终态</th><th>阻塞项</th><th>质量占位</th>
              <th>Top call</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="answers">${answers}</div>
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>AI Council Eval Report</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; margin: 24px; color: #15171a; line-height: 1.5; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 28px 0 10px; font-size: 20px; }
    .notice { background: #fff8df; border: 1px solid #ead28b; border-radius: 6px; padding: 12px 14px; margin: 16px 0; }
    .notice p { margin: 4px 0; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0 18px; font-size: 14px; }
    th, td { border: 1px solid #d9dde3; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f1f2f4; position: sticky; top: 0; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f7f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 10px; max-height: 420px; overflow: auto; }
    details { margin: 10px 0; }
    summary { cursor: pointer; font-weight: 600; }
    .task { border-top: 2px solid #20242a; padding-top: 4px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 8px 0 12px; }
    .meta div { background: #f7f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 8px; }
    .meta dt { font-size: 12px; color: #5d6673; }
    .meta dd { margin: 2px 0 0; font-weight: 600; }
    .answer { border: 1px solid #d9dde3; border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
    .call { margin-left: 14px; }
    .muted { color: #5d6673; }
  </style>
</head>
<body>
  <h1>AI Council Eval Report</h1>
  <p>Created: ${escapeHtml(report.created_at)}</p>
  <div class="notice">
    ${(report.notes || []).map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
  </div>
  <h2>整体汇总</h2>
  <table>
    <thead><tr><th>组别</th><th>任务数</th><th>调用数</th><th>输入 token</th><th>输出 token</th><th>总 token</th><th>耗时 ms</th><th>平均质量占位</th></tr></thead>
    <tbody>${aggregateRows}</tbody>
  </table>
  ${taskSections}
</body>
</html>`;
}

function aggregateByMode(records, modes = EVAL_MODES) {
  return modes.map((mode) => {
    const rows = records.filter((record) => record.mode === mode);
    const qualityRows = rows.filter((record) => typeof record.quality_score === "number");
    const quality = qualityRows.length
      ? Number((qualityRows.reduce((sum, record) => sum + record.quality_score, 0) / qualityRows.length).toFixed(3))
      : undefined;
    return {
      mode,
      tasks: rows.length,
      calls: rows.reduce((sum, record) => sum + Number(record.calls || 0), 0),
      input_tokens: rows.reduce((sum, record) => sum + Number(record.input_tokens || 0), 0),
      output_tokens: rows.reduce((sum, record) => sum + Number(record.output_tokens || 0), 0),
      total_tokens: rows.reduce((sum, record) => sum + Number(record.total_tokens || 0), 0),
      elapsed_ms: rows.reduce((sum, record) => sum + Number(record.elapsed_ms || 0), 0),
      avg_quality_score: quality
    };
  });
}

function answerDetails(record) {
  const calls = (record.model_call_records || []).map((call) => `
    <details class="call">
      <summary>调用 ${escapeHtml(call.callIndex ?? "")}: ${escapeHtml(call.agentName || call.agentId || call.phase || "model")} · ${escapeHtml(call.total_tokens ?? "")} tokens · ${escapeHtml(call.token_accounting || "")}</summary>
      <details>
        <summary>输入 messages</summary>
        <pre>${escapeHtml(formatMessages(call.inputMessages || []))}</pre>
      </details>
      <details>
        <summary>输出 rawText</summary>
        <pre>${escapeHtml(call.rawText || call.outputText || call.error || "")}</pre>
      </details>
    </details>`).join("");
  return `
    <details class="answer">
      <summary>${escapeHtml(modeLabel(record.mode))} · final_state=${escapeHtml(record.final_state)} · total=${escapeHtml(record.total_tokens)} tokens</summary>
      <p class="muted">input=${escapeHtml(record.input_tokens)} / output=${escapeHtml(record.output_tokens)} / accounting=${escapeHtml(record.token_accounting)} / calls=${escapeHtml(record.calls)}</p>
      ${callDiagnosticsDetails(record.call_diagnostics)}
      <details open>
        <summary>最终回答</summary>
        <pre>${escapeHtml(record.answer || "")}</pre>
      </details>
      <details>
        <summary>调用明细</summary>
        ${calls || "<p class=\"muted\">No model calls recorded.</p>"}
      </details>
    </details>`;
}

function callDiagnosticsDetails(diagnostics) {
  if (!diagnostics) return "";
  const topRows = (diagnostics.top_calls || []).map((call) => `
    <tr>
      <td>${escapeHtml(topCallLabel(call))}</td>
      <td>${escapeHtml(call.input_tokens)}</td>
      <td>${escapeHtml(call.output_tokens)}</td>
      <td>${escapeHtml(call.total_tokens)}</td>
      <td>${escapeHtml(call.input_chars)}</td>
      <td>${escapeHtml(call.output_chars)}</td>
    </tr>`).join("");
  const byAgent = diagnosticTotalsList(diagnostics.by_agent);
  const byPhase = diagnosticTotalsList(diagnostics.by_phase);
  return `
    <details>
      <summary>Token hotspots</summary>
      <table>
        <thead><tr><th>Call</th><th>Input</th><th>Output</th><th>Total</th><th>Input chars</th><th>Output chars</th></tr></thead>
        <tbody>${topRows || `<tr><td colspan="6">No calls</td></tr>`}</tbody>
      </table>
      <p class="muted">By agent: ${escapeHtml(byAgent || "none")}</p>
      <p class="muted">By phase: ${escapeHtml(byPhase || "none")}</p>
    </details>`;
}

function diagnosticTotalsList(value = {}) {
  return Object.entries(value)
    .map(([key, totals]) => `${key} ${totals.total_tokens}t (${totals.calls} calls, in ${totals.input_tokens}, out ${totals.output_tokens})`)
    .join("; ");
}

function topCallLabel(call) {
  if (!call) return "";
  const name = call.agentName || call.agentId || call.phase || "model";
  const phase = call.phase ? `${call.phase}:` : "";
  return `#${call.callIndex || "?"} ${phase}${name}`;
}

function formatMessages(messages) {
  return (messages || []).map((message, index) => {
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content, null, 2);
    return `#${index + 1} ${message.role || "unknown"}\n${content}`;
  }).join("\n\n---\n\n");
}

function modeLabel(mode) {
  return MODE_LABELS[mode] || mode;
}

function deltaText(value, baseline) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(baseline)) || Number(baseline) <= 0) return "";
  const diff = Number(value) - Number(baseline);
  if (diff === 0) return "baseline";
  const percent = Math.round((diff / Number(baseline)) * 100);
  return `${diff > 0 ? "+" : ""}${diff} (${percent > 0 ? "+" : ""}${percent}%)`;
}

function defaultReportDir(baseDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(baseDir, "eval", "reports", stamp);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
