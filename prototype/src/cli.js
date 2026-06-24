#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, loadJson, loadQuestion, validateGroupConfig, validateRuntimeEnv } from "./config.js";
import { runCouncil } from "./discussionEngine.js";
import { EVAL_MODES, compareEvalReports, runEvalHarness } from "./evalHarness.js";
import { readMemoryPending } from "./storage.js";
import { initGroupWorkspace, replaceMember } from "./workspaceManager.js";
import { addReview, createRecorderDraft, finalizeDraft, listDrafts } from "./writeFlow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(__dirname, "..");

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "run") {
    const groupPath = getArg(args, "--group", path.join(baseDir, "config", "group.example.json"));
    const question = loadQuestion(args);
    const group = validateGroupConfig(loadJson(groupPath));
    validateRuntimeEnv(group);
    const result = await runCouncil(question, group, baseDir);
    printFinal(result);
    if (args.includes("--show-transcript")) printTranscript(result);
    return;
  }

  if (command === "show-session") {
    const sessionPath = args[0];
    if (!sessionPath) throw new Error("Missing session path");
    console.log(JSON.stringify(loadJson(sessionPath), null, 2));
    return;
  }

  if (command === "list-memory-pending") {
    console.log(JSON.stringify(readMemoryPending(baseDir), null, 2));
    return;
  }

  if (command === "workspace") {
    runWorkspaceCommand(args);
    return;
  }

  if (command === "write-flow") {
    runWriteFlowCommand(args);
    return;
  }

  if (command === "eval") {
    await runEvalCommand(args);
    return;
  }

  if (command === "eval-compare") {
    runEvalCompareCommand(args);
    return;
  }

  printHelp();
}

function runEvalCompareCommand(args) {
  const comparison = compareEvalReports({
    baselinePath: getArg(args, "--baseline"),
    candidatePath: getArg(args, "--candidate"),
    mode: getArg(args, "--mode")
  });
  console.log(JSON.stringify(comparison, null, 2));
}

async function runEvalCommand(args) {
  const modesArg = getArg(args, "--modes", "");
  const modes = modesArg
    ? modesArg.split(",").map((item) => item.trim()).filter(Boolean)
    : EVAL_MODES;
  const groupPath = getArg(args, "--group");
  const group = groupPath ? validateGroupConfig(loadJson(groupPath)) : undefined;
  if (group) validateRuntimeEnv(group);
  const result = await runEvalHarness({
    baseDir,
    tasksPath: getArg(args, "--tasks"),
    outputDir: getArg(args, "--output"),
    modes,
    matchedCalls: Number(getArg(args, "--matched-calls", 6)),
    ...(group ? buildEvalGroupOptions(group) : {})
  });
  console.log(JSON.stringify({
    outputDir: result.outputDir,
    records: result.report.records.length
  }, null, 2));
}

function buildEvalGroupOptions(group) {
  return {
    groupFactory(task) {
      const cloned = JSON.parse(JSON.stringify(group));
      cloned.settings = {
        ...cloned.settings,
        maxRounds: task.maxRounds || cloned.settings?.maxRounds || 3
      };
      cloned.agents = cloned.agents.map((agent) => agent.mandatoryRedTeam && !agent.reviewIntensity
        ? { ...agent, reviewIntensity: task.reviewIntensity || 2 }
        : agent);
      return cloned;
    },
    baselineAgent: chooseEvalBaselineAgent(group)
  };
}

function chooseEvalBaselineAgent(group) {
  const enabled = group.agents.filter((agent) => agent.enabled);
  const selected = enabled.find((agent) => !agent.judge && !agent.mandatoryRedTeam)
    ?? enabled.find((agent) => !agent.judge)
    ?? enabled[0];
  if (!selected) throw new Error("Eval group needs at least one enabled agent");
  return {
    ...selected,
    id: selected.id + "-eval-baseline",
    name: "Single AI",
    role: "Single AI",
    mandatoryRedTeam: false,
    judge: false,
    consensusParticipant: true
  };
}

function runWriteFlowCommand(args) {
  const [subcommand] = args;

  if (subcommand === "create-draft") {
    const result = createRecorderDraft({
      groupPath: getArg(args, "--group-path"),
      recorderSeatId: getArg(args, "--recorder"),
      reviewerSeatIds: parseCsv(getArg(args, "--reviewers", "")),
      target: getArg(args, "--target", "approved"),
      content: getArg(args, "--content")
    });
    console.log(JSON.stringify(result.draft, null, 2));
    return;
  }

  if (subcommand === "add-review") {
    const result = addReview({
      groupPath: getArg(args, "--group-path"),
      draftId: getArg(args, "--draft-id"),
      reviewerSeatId: getArg(args, "--reviewer"),
      verdict: getArg(args, "--verdict"),
      comment: getArg(args, "--comment", "")
    });
    console.log(JSON.stringify(result.review, null, 2));
    return;
  }

  if (subcommand === "finalize") {
    const result = finalizeDraft({
      groupPath: getArg(args, "--group-path"),
      draftId: getArg(args, "--draft-id"),
      approvedBy: getArg(args, "--approved-by", "user")
    });
    console.log(JSON.stringify({ finalPath: result.finalPath, draft: result.draft }, null, 2));
    return;
  }

  if (subcommand === "list-drafts") {
    console.log(JSON.stringify(listDrafts(getArg(args, "--group-path")), null, 2));
    return;
  }

  throw new Error("Unknown write-flow command");
}

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function runWorkspaceCommand(args) {
  const [subcommand] = args;

  if (subcommand === "init-group") {
    const root = getArg(args, "--root");
    const groupFolderName = getArg(args, "--group-folder");
    const membersArg = getArg(args, "--members", "");
    const members = membersArg
      ? membersArg.split(",").map((name, index) => ({
        seatId: `seat_${String(index + 1).padStart(2, "0")}`,
        displayName: name.trim(),
        model: name.trim()
      })).filter((member) => member.displayName)
      : [];
    const group = initGroupWorkspace({ root, groupFolderName, members });
    console.log(JSON.stringify(group, null, 2));
    return;
  }

  if (subcommand === "replace-member") {
    const result = replaceMember({
      groupPath: getArg(args, "--group-path"),
      seatId: getArg(args, "--seat-id"),
      nextDisplayName: getArg(args, "--next-name"),
      nextModel: getArg(args, "--next-model"),
      newPrivateFolder: args.includes("--new-private-folder"),
      folderName: getArg(args, "--folder-name")
    });
    console.log(JSON.stringify(result.seat, null, 2));
    return;
  }

  throw new Error("Unknown workspace command");
}

function printFinal(result) {
  const final = result.session.finalDecision;
  console.log("\nAI Council Final Decision");
  console.log("=========================");
  console.log(`Session: ${result.session.id}`);
  console.log(`Session file: ${result.sessionPath}`);
  console.log(`Consensus: ${final.consensus_score.toFixed(2)}`);
  console.log(`\nAnswer:\n${final.answer}`);
  console.log(`\nMinority report:\n${final.minority_report}`);
  console.log(`\nRisks:\n- ${final.risks.join("\n- ") || "None"}`);
  console.log(`\nNext actions:\n- ${final.next_actions.join("\n- ") || "None"}`);
  console.log(`\nMemory candidates written: ${result.memoryRecords.length}`);
}

function printTranscript(result) {
  console.log("\nTranscript");
  console.log("----------");
  for (const message of result.session.messages) {
    console.log(`[Round ${message.round}] ${message.displayText}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node src/cli.js run --question "..." --group ./config/group.example.json
  node src/cli.js run --question "..." --group ./config/group.example.json --show-transcript
  node src/cli.js run --question-file ./question.md --group ./config/group.example.json
  node src/cli.js show-session ./sessions/session_....json
  node src/cli.js list-memory-pending
  node src/cli.js eval --tasks ./eval/tasks.json --output ./eval/reports/run
  node src/cli.js eval-compare --baseline ./eval/reports/baseline --candidate ./eval/reports/candidate
  node src/cli.js eval-compare --baseline ./eval/reports/baseline --candidate ./eval/reports/candidate --mode council-current
  node src/cli.js workspace init-group --root "D:\\AI小组工作区" --group-folder "产品决策组" --members "gpt-5,claude"
  node src/cli.js workspace replace-member --group-path "D:\\AI小组工作区\\产品决策组" --seat-id seat_01 --next-name gpt-6
  node src/cli.js workspace replace-member --group-path "D:\\AI小组工作区\\产品决策组" --seat-id seat_01 --next-name gpt-6 --new-private-folder --folder-name gpt-6-fresh
  node src/cli.js write-flow create-draft --group-path "D:\\AI小组工作区\\产品决策组" --recorder seat_01 --reviewers seat_02 --content "..."
  node src/cli.js write-flow add-review --group-path "D:\\AI小组工作区\\产品决策组" --draft-id draft_... --reviewer seat_02 --verdict approve --comment "..."
  node src/cli.js write-flow finalize --group-path "D:\\AI小组工作区\\产品决策组" --draft-id draft_... --approved-by user`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
