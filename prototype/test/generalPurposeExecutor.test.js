import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { executeToolRequests } from "../src/toolRequests.js";
import { enforceRequestedArtifactRequirements } from "../src/deliverableVerification.js";

test("general-purpose executor matrix provisions tools and verifies source data document and package outputs", async () => {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-general-matrix-"));
  const installCommand = process.platform === "win32"
    ? "$p='shared/tools/docmaker/bin'; New-Item -ItemType Directory -Force -Path $p | Out-Null; Set-Content -Path \"$p/docmaker.cmd\" -Value @('@echo off','node -e \"require(''fs'').writeFileSync(process.argv[1],''%%PDF-1.7\\nAI Council report'')\" %1')"
    : "mkdir -p shared/tools/docmaker/bin && printf '#!/bin/sh\\nprintf \"%%%%PDF-1.7\\nAI Council report\" > \"$1\"\\n' > shared/tools/docmaker/bin/docmaker && chmod +x shared/tools/docmaker/bin/docmaker";

  const provisioned = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    agent: { id: "executor", name: "Executor" },
    round: 1,
    requests: [{
      tool: "provision_tool",
      toolName: "docmaker",
      commandName: "docmaker",
      installCommand,
      shell: process.platform === "win32" ? "powershell" : "sh",
      verifyCommand: process.platform === "win32" ? "& docmaker shared/tools/docmaker/probe.pdf; if (!(Test-Path shared/tools/docmaker/probe.pdf)) { exit 1 }" : "docmaker shared/tools/docmaker/probe.pdf && test -s shared/tools/docmaker/probe.pdf",
      reason: "Acquire the missing document generator."
    }]
  });
  assert.equal(provisioned.results[0].status, "completed", JSON.stringify(provisioned.results[0]));

  const edit = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    agent: { id: "executor", name: "Executor" },
    round: 1,
    requests: [
      { tool: "workspace_edit", action: "write", path: "output/result.json", code: '{"status":"ok"}', reason: "Create data output." },
      { tool: "workspace_edit", action: "write", path: "output/tool.py", code: "print('ok')\n", reason: "Create source output." }
    ]
  });
  assert.deepEqual(edit.results.map((item) => item.status), ["completed", "completed"]);

  const command = process.platform === "win32" ? "docmaker output/report.pdf" : "docmaker output/report.pdf";
  const built = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    agent: { id: "executor", name: "Executor" },
    round: 1,
    requests: [{ tool: "execute_command", command, shell: process.platform === "win32" ? "powershell" : "sh", reason: "Generate document and package outputs." }]
  });
  assert.equal(built.results[0].status, "completed");
  const archive = await executeToolRequests({
    permissionTier: "full",
    groupPath,
    agent: { id: "executor", name: "Executor" },
    round: 1,
    requests: [{ tool: "create_archive", path: "output/package.zip", files: ["output/result.json", "output/tool.py"], reason: "Package the generated outputs." }]
  });
  assert.equal(archive.results[0].status, "completed", JSON.stringify(archive.results[0]));

  const session = {
    finalDecision: { answer: "Created requested outputs.", final_state: "ready_to_execute", blocking_issues: [], risks: [] },
    toolExecutionResults: [...edit.results, ...built.results, ...archive.results],
    fileOperationExecutionResults: []
  };
  const report = enforceRequestedArtifactRequirements({
    groupPath,
    question: "Create result.json, a Python script, a PDF report, and a ZIP package.",
    session
  });

  assert.equal(report.status, "verified", JSON.stringify(report));
  assert.deepEqual(report.requirements.map((item) => item.extension).sort(), [".json", ".pdf", ".py", ".zip"]);
});
