import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./types.js";

const EXECUTION_FILE = "execution-standard.md";
const VERIFICATION_FILE = "verification-standard.md";
const MANIFEST_FILE = "standards.json";

export function prepareExecutionStandards(options = {}) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const finalAnswer = requireOption(options.finalAnswer, "finalAnswer");
  const harnessDir = ensureHarnessDir(groupPath);
  const objective = String(options.objective || firstLine(finalAnswer) || "Execute approved council decision").trim();
  const recorderSeatId = String(options.recorderSeatId || "").trim();
  const reviewers = Array.isArray(options.reviewerSeatIds) ? options.reviewerSeatIds.filter(Boolean) : [];
  const createdAt = nowIso();
  const executionPath = path.join(harnessDir, EXECUTION_FILE);
  const verificationPath = path.join(harnessDir, VERIFICATION_FILE);
  const manifestPath = path.join(harnessDir, MANIFEST_FILE);
  const manifest = {
    status: "pending_user_approval",
    objective,
    recorderSeatId,
    reviewerSeatIds: reviewers,
    createdAt,
    approvedAt: "",
    approvedBy: "",
    files: {
      executionStandard: relative(groupPath, executionPath),
      verificationStandard: relative(groupPath, verificationPath)
    }
  };

  fs.writeFileSync(executionPath, executionMarkdown({ objective, finalAnswer, recorderSeatId, reviewers }), "utf8");
  fs.writeFileSync(verificationPath, verificationMarkdown({ objective, finalAnswer }), "utf8");
  writeJson(manifestPath, manifest);
  appendLog(groupPath, `Execution standards prepared; recorder=${recorderSeatId || "user"}; reviewers=${reviewers.join(",") || "none"}`);
  return readExecutionStandards(groupPath);
}

export function approveExecutionStandards(options = {}) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const manifestPath = path.join(ensureHarnessDir(groupPath), MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Execution and verification standards must exist before approval.");
  }
  const manifest = readManifest(manifestPath);
  if (!standardsExist(groupPath, manifest)) {
    throw new Error("Execution and verification standards must exist before approval.");
  }
  manifest.status = "approved";
  manifest.approvedAt = nowIso();
  manifest.approvedBy = String(options.approvedBy || "user");
  writeJson(manifestPath, manifest);
  writeJson(path.join(groupPath, "approvals", "execution-standards.user.approval.json"), {
    type: "execution_standards",
    verdict: "approved",
    approvedBy: manifest.approvedBy,
    approvedAt: manifest.approvedAt,
    files: manifest.files
  });
  appendLog(groupPath, `Execution standards approved by ${manifest.approvedBy}; no execution started`);
  return readExecutionStandards(groupPath);
}

export function readExecutionStandards(groupPath) {
  const resolvedGroupPath = path.resolve(groupPath);
  const harnessDir = ensureHarnessDir(resolvedGroupPath);
  const manifestPath = path.join(harnessDir, MANIFEST_FILE);
  const manifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : {
    status: "missing",
    files: {
      executionStandard: relative(resolvedGroupPath, path.join(harnessDir, EXECUTION_FILE)),
      verificationStandard: relative(resolvedGroupPath, path.join(harnessDir, VERIFICATION_FILE))
    }
  };
  return {
    manifest,
    executionStandard: readIfExists(path.join(resolvedGroupPath, manifest.files.executionStandard)),
    verificationStandard: readIfExists(path.join(resolvedGroupPath, manifest.files.verificationStandard))
  };
}

function executionMarkdown({ objective, finalAnswer, recorderSeatId, reviewers }) {
  return `# Execution Standard

Status: pending user approval. This file is a standard only; it does not grant tools or start execution.

## Objective

${objective}

## Source Decision

${finalAnswer}

## Recorder

${recorderSeatId || "user"}

## Reviewers

${reviewers.length ? reviewers.join(", ") : "none"}

## Scope

- Only work explicitly listed here after user approval.
- Do not modify files outside the approved group workspace.

## Allowed Files Or Folders

- To be confirmed by the user before execution.

## Forbidden Files Or Folders

- Files outside the selected group folder.
- Secrets, API keys, credentials, and unrelated user files.

## Required Inputs

- Approved execution standard.
- Approved verification standard.
- Git repository available for commit handoff.

## Expected Outputs

- A small coherent Git commit.
- A commit body describing add/change/remove/files/limits.
- A handoff hash for the next reviewer.

## Rollback Plan

- Use the Git commit as the reversible unit.
- Stop and ask the user before any destructive change.

## Stop Conditions

- Missing approval.
- Missing Git repository.
- Requested file is outside the approved scope.
- Verification standard cannot be run.
`;
}

function verificationMarkdown({ objective, finalAnswer }) {
  return `# Verification Standard

Status: pending user approval. This file defines checks only; it does not execute them automatically.

## Objective Under Test

${objective}

## Source Decision

${finalAnswer}

## Required Checks

- Run the relevant automated tests for changed code.
- Run syntax checks for touched source files.
- Run visual checks when UI changes.
- Confirm no API key or secret was written to the repo.
- Confirm paths stayed inside the approved group workspace.

## Success Criteria

- Tests/checks pass.
- User-visible behavior matches the approved decision.
- A Git commit exists and can be reviewed with git show <hash>.

## Failure Criteria

- Any check fails.
- Any unapproved file is modified.
- Any model API is given local file read/write tools without explicit approval.

## Report To User

- Commit hash.
- Changed files.
- Verification commands and results.
- Known limits.
`;
}

function standardsExist(groupPath, manifest) {
  return Boolean(
    manifest?.files?.executionStandard &&
    manifest?.files?.verificationStandard &&
    fs.existsSync(path.join(groupPath, manifest.files.executionStandard)) &&
    fs.existsSync(path.join(groupPath, manifest.files.verificationStandard))
  );
}

function ensureHarnessDir(groupPath) {
  const harnessDir = path.join(groupPath, "shared", "harness");
  fs.mkdirSync(harnessDir, { recursive: true });
  return harnessDir;
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function appendLog(groupPath, line) {
  const logPath = path.join(groupPath, "shared", "logs", "workspace.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${nowIso()} ${line}\n`, "utf8");
}

function relative(groupPath, filePath) {
  return path.relative(groupPath, filePath).replaceAll("\\", "/");
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function requireOption(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
