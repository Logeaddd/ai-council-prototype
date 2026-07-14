import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runContextPressureBaseline } from "../src/contextPressureHarness.js";

test("context pressure baseline uses retained sessions, a rebuilt public index, hot cache, archive search, and real context receipts", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-context-pressure-"));
  try {
    const run = runContextPressureBaseline({ outputDir, seed: 20260714 });
    assert.equal(run.report.status, "passed", JSON.stringify(run.report, null, 2));
    assert.equal(run.report.scope, "deterministic_context_pipeline_only");
    assert.equal(run.report.scenarios.length, 4);
    assert.equal(run.report.scenarios.every((scenario) => scenario.status === "measured"), true);

    const buried = run.report.scenarios.find((scenario) => scenario.id === "buried_exact_source");
    assert.equal(buried.metrics.exactSourceInjected, true);
    assert.equal(buried.metrics.journalSearchHits > 0, true);
    assert.equal(buried.metrics.rebuiltIndexEvents > 100, true);

    const stale = run.report.scenarios.find((scenario) => scenario.id === "superseded_instruction_visibility");
    assert.equal(stale.metrics.currentInstructionPresent, true);
    assert.equal(stale.metrics.staleInstructionPresent, true);
    assert.equal(stale.metrics.conflictPolicyState.invalidatedSources.length, 0);

    const repeated = run.report.scenarios.find((scenario) => scenario.id === "repeated_execution_evidence");
    assert.equal(repeated.metrics.deduplicated, 95);
    assert.equal(repeated.metrics.injected, 1);
    assert.equal(repeated.metrics.latestEvidenceVisible, true);
    assert.equal(fs.existsSync(path.join(run.runDir, "report.json")), true);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
