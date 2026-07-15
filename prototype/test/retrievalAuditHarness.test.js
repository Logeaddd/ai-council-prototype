import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runRetrievalCoverageAudit } from "../src/retrievalAuditHarness.js";

test("retrieval coverage audit drives the real JSON journal and text-only search_context path", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-retrieval-audit-"));
  try {
    const run = await runRetrievalCoverageAudit({ outputDir, seed: 20260715, largeEventCount: 400 });
    assert.equal(run.report.status, "passed", JSON.stringify(run.report, null, 2));
    assert.equal(run.report.scope, "real_json_journal_query_and_search_context_tool_paths");
    assert.equal(run.report.scenarios.length, 6);
    assert.equal(run.report.scenarios.every((scenario) => scenario.status === "measured"), true);
    assert.equal(run.report.scenarios.find((scenario) => scenario.id === "continuous_chinese_lexical_recall").metrics.exactTargetFound, true);
    assert.equal(run.report.scenarios.find((scenario) => scenario.id === "combined_structured_filters").metrics.resultCount, 1);
    assert.equal(run.report.scenarios.find((scenario) => scenario.id === "search_context_pagination").metrics.overlap.length, 0);
    assert.equal(run.report.scenarios.find((scenario) => scenario.id === "large_json_index_exact_recall_and_latency").metrics.exactTargetFound, true);
    assert.equal(run.report.scenarios.find((scenario) => scenario.id === "tombstone_survives_index_rebuild").metrics.activeResultCount, 0);
    assert.equal(fs.existsSync(path.join(run.runDir, "report.json")), true);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
