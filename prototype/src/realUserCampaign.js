const CAMPAIGN_SCHEMA = "ai-council.real-user-campaign.v1";
export const EXTERNAL_ROOT_TOKEN = "{{EXTERNAL_ROOT}}";

export function createSeededCampaignScenario(options = {}) {
  const seed = normalizeSeed(options.seed);
  const random = seededRandom(seed);
  const template = TASK_TEMPLATES[seed % TASK_TEMPLATES.length];
  const task = template(seed, random);
  const followupCount = randomInteger(random, 7, 9);
  const stageCount = randomInteger(random, Math.max(17, followupCount + 10), 30);
  const followups = buildFollowups(task, followupCount);
  const disturbances = buildDisturbances(seed, task);
  const stages = [
    userStage("initial", task.initialQuestion, { artifactEdit: true }),
    ...followups,
    ...disturbances
  ];
  while (stages.length < stageCount) {
    stages.splice(Math.max(1, stages.length - 2), 0, checkpointStage(stages.length));
  }
  return {
    schema: CAMPAIGN_SCHEMA,
    id: `campaign-${task.id}-${seed}`,
    seed,
    capacity: {
      stages: stageCount,
      followups: followupCount,
      requiredArtifactEdits: 4
    },
    task: {
      id: task.id,
      domain: task.domain,
      initialQuestion: task.initialQuestion,
      deliverable: task.deliverable
    },
    stages: stages.map((stage, index) => ({ id: `stage_${String(index + 1).padStart(2, "0")}`, ...stage })),
    fixtures: task.fixtures || [],
    hiddenVerifier: task.hiddenVerifier
  };
}

export function publicCampaignScenario(campaign = {}) {
  return {
    schema: campaign.schema,
    id: campaign.id,
    seed: campaign.seed,
    capacity: campaign.capacity,
    task: campaign.task,
    stages: (campaign.stages || []).map(({ id, kind, prompt, mutation, interruptAt, checkpoint }) => ({
      id,
      kind,
      prompt,
      mutation,
      interruptAt,
      checkpoint
    }))
  };
}

function buildFollowups(task, count) {
  const edits = task.edits.slice(0, 4).map((edit, index) => userStage("followup", edit.prompt, {
    artifactEdit: true,
    editIndex: index + 1
  }));
  const remaining = [
    userStage("followup", "continue", { continuation: true }),
    userStage("followup", task.reversalPrompt, { requirementReversal: true }),
    userStage("followup", task.recallPrompt, { oldDetailRecall: true }),
    userStage("followup", "继续", { continuation: true }),
    userStage("followup", task.finalPrompt, { artifactEdit: true })
  ];
  return [...edits, ...remaining].slice(0, count);
}

function buildDisturbances(seed, task) {
  const suffix = String(seed).slice(-4);
  return [
    { kind: "member_mutation", mutation: { type: "rename", seatId: "seat_01", displayName: `Builder ${suffix}` } },
    { kind: "member_mutation", mutation: { type: "role", seatId: "seat_02", role: "reviewer" } },
    { kind: "member_mutation", mutation: { type: "reorder", seatIds: ["seat_02", "seat_01", "seat_03"] } },
    { kind: "member_mutation", mutation: { type: "disable", seatId: "seat_02" } },
    { kind: "member_mutation", mutation: { type: "restore", seatId: "seat_02", role: "summarizer" } },
    { kind: "interrupt", interruptAt: "during_model_streaming" },
    { kind: "reopen", prompt: "continue" },
    { kind: "interrupt", prompt: task.recoveryVerificationPrompt, interruptAt: "during_tool_or_build_activity" },
    { kind: "reopen", prompt: "continue" }
  ];
}

function checkpointStage(index) {
  return {
    kind: "checkpoint",
    checkpoint: `resume_state_${index}`
  };
}

function userStage(kind, prompt, attributes = {}) {
  return { kind, prompt, ...attributes };
}

function nodeCliTemplate(seed, random) {
  const name = ["greeting", "salutation", "message"][Math.floor(random() * 3)];
  const file = `deliverables/${name}-${seed}.js`;
  const labels = ["Hello", "Welcome", "Greetings", "Thanks", "Ready"];
  return {
    id: "node-cli",
    domain: "coding",
    deliverable: file,
    initialQuestion: `Create a command-line program at ${file}. It accepts --name <value> and prints a greeting for that name. Run it and verify it works.`,
    edits: labels.slice(0, 4).map((label) => ({ prompt: `Update the existing greeting program so it uses ${JSON.stringify(label)} while keeping the same command-line interface. Verify the edited program.` })),
    reversalPrompt: "Use the current requirements only; do not restore a superseded earlier greeting. Verify the current program.",
    recallPrompt: "Check the retained task history for the current artifact and continue from the latest requirement.",
    finalPrompt: "Make the final requested greeting change and verify the deliverable again.",
    recoveryVerificationPrompt: "Run the current deliverable once more to verify its current state after recovery.",
    hiddenVerifier: { kind: "node_cli", file, args: ["--name", "Ada"], expectedOutput: "Thanks, Ada." }
  };
}

function pythonCliTemplate(seed, random) {
  const file = `deliverables/tool-${seed}.py`;
  const names = ["alpha", "beta", "gamma", "delta"];
  return {
    id: "python-cli",
    domain: "coding_and_runtime",
    deliverable: file,
    initialQuestion: `Create a small Python command-line utility at ${file}. It accepts one text value and prints a labeled result. Run it and verify it works.`,
    edits: names.map((name) => ({ prompt: `Edit the existing utility so its visible label is ${JSON.stringify(name)}. Preserve its command-line input and verify it.` })),
    reversalPrompt: "Apply only the newest label requirement and verify the utility without restoring old labels.",
    recallPrompt: "Retrieve the current task context, then continue the existing utility without creating a replacement project.",
    finalPrompt: "Apply the final requested utility edit and run the current program to verify it.",
    recoveryVerificationPrompt: "Run the current utility once more to verify its current state after recovery.",
    hiddenVerifier: { kind: "python_cli", file, args: ["Ada"], expectedOutput: "delta: Ada" }
  };
}

function jsonDocumentTemplate(seed, random) {
  const file = `deliverables/record-${seed}.json`;
  const states = ["draft", "review", "approved", "released"];
  return {
    id: "json-document",
    domain: "file_and_structured_data",
    deliverable: file,
    initialQuestion: `Create the requested JSON record at ${file} with clear name, status and version fields. Validate that it parses after writing it.`,
    edits: states.map((status) => ({ prompt: `Update the existing JSON record so its status is ${JSON.stringify(status)}. Keep it valid JSON and verify it parses.` })),
    reversalPrompt: "Use the newest status only. Do not bring back an earlier status from retained discussion.",
    recallPrompt: "Inspect the current artifact and retained context, then continue from the latest JSON requirement.",
    finalPrompt: "Apply the final JSON record change and validate the file one more time.",
    recoveryVerificationPrompt: "Validate the current JSON record once more after recovery.",
    hiddenVerifier: { kind: "json", file, expected: { status: "released" } }
  };
}

function jsonToCsvTemplate(seed, random) {
  const source = `inputs/records-${seed}.json`;
  const file = `deliverables/records-${seed}.csv`;
  const records = [
    { name: `Ada-${seed % 10}`, score: 92 },
    { name: `Lin-${seed % 7}`, score: 67 },
    { name: `Mika-${seed % 5}`, score: 81 }
  ];
  const rows = records.map((record) => [record.name, String(record.score), record.score >= 80 ? "PASS" : "REVIEW"]);
  return {
    id: "json-to-csv",
    domain: "file_read_write_and_data_transform",
    deliverable: file,
    initialQuestion: `Read the JSON records in ${source} and create ${file} as valid CSV with name and score columns. Preserve every source record and validate the generated file.`,
    edits: [
      { prompt: "Update the existing CSV to add a result column: use PASS for scores at least 80 and REVIEW otherwise. Keep every source record and validate the file." },
      { prompt: "Keep the existing CSV artifact, preserve source order, and ensure score values remain plain integers. Validate the updated file." },
      { prompt: "Use the latest requirements only: the CSV header must be name,score,result and its result values must be PASS or REVIEW. Validate it." },
      { prompt: "Make the final requested CSV update without replacing the project. Re-read the source when needed, preserve all records, and validate the output." }
    ],
    reversalPrompt: "Use only the current CSV requirements. Do not restore an earlier column layout or label from retained discussion.",
    recallPrompt: "Inspect the retained source file and current CSV artifact, then continue from the newest requirement.",
    finalPrompt: "Apply the final CSV requirement and validate the current artifact one more time.",
    recoveryVerificationPrompt: "Validate the current CSV artifact once more after recovery.",
    fixtures: [{ path: source, content: JSON.stringify({ records }, null, 2) }],
    hiddenVerifier: { kind: "csv", file, headers: ["name", "score", "result"], rows }
  };
}

function externalNodeCliTemplate(seed, random) {
  const file = `${EXTERNAL_ROOT_TOKEN}/deliverables/external-greeting-${seed}.js`;
  const labels = ["Hello", "Welcome", "Greetings", "Thanks"];
  return {
    id: "external-node-cli",
    domain: "user_authorized_external_workspace",
    deliverable: file,
    externalWorkspace: true,
    initialQuestion: `Use the user-authorized external project root ${EXTERNAL_ROOT_TOKEN}. Create a command-line program at ${file}. It accepts --name <value> and prints a greeting. Run it and verify it works.`,
    edits: labels.map((label) => ({ prompt: `In the same user-authorized external project, update ${file} so it uses ${JSON.stringify(label)} while keeping the command-line interface. Verify the edited program.` })),
    reversalPrompt: `Use only the newest requirement in the external project at ${EXTERNAL_ROOT_TOKEN}; do not restore a superseded earlier greeting. Verify the current program.`,
    recallPrompt: `Check the retained task history for ${file} and continue the user-authorized external project from the latest requirement.`,
    finalPrompt: `Make the final requested greeting change in ${file} and verify the external deliverable again.`,
    recoveryVerificationPrompt: `Run ${file} once more to verify its current state after recovery.`,
    hiddenVerifier: { kind: "node_cli", file, args: ["--name", "Ada"], expectedOutput: "Thanks, Ada." }
  };
}

function zipArchiveTemplate(seed, random) {
  const sourceRoot = `inputs/archive-${seed}`;
  const file = `deliverables/archive-${seed}.zip`;
  const entries = [
    { name: "notes.txt", content: `release notes ${seed}\n` },
    { name: "manifest.json", content: JSON.stringify({ artifact: `archive-${seed}`, version: 1 }, null, 2) + "\n" },
    { name: "checklist.txt", content: "review\npackage\nverify\n" }
  ];
  return {
    id: "zip-archive",
    domain: "archive_packaging",
    deliverable: file,
    initialQuestion: `Read the source files in ${sourceRoot} and create ${file} as a ZIP archive containing notes.txt. Verify that the archive opens and includes the requested file.`,
    edits: [
      { prompt: `Update the existing ZIP so it also contains manifest.json from ${sourceRoot}. Verify the archive structure.` },
      { prompt: `Update the existing ZIP so it also contains checklist.txt from ${sourceRoot}. Preserve existing requested entries and verify it.` },
      { prompt: "Use the latest requirements only: keep the requested files at the archive root, without an extra parent directory. Verify the ZIP contents." },
      { prompt: "Make the final requested archive update, preserve every required source file, and verify the finished ZIP." }
    ],
    reversalPrompt: "Use only the latest archive requirements. Do not restore an obsolete directory layout from retained discussion.",
    recallPrompt: `Inspect ${sourceRoot} and the current ZIP, then continue from the newest packaging requirement.`,
    finalPrompt: "Apply the final archive requirement and validate the current ZIP one more time.",
    recoveryVerificationPrompt: `Validate ${file} once more after recovery.`,
    fixtures: entries.map((entry) => ({ path: `${sourceRoot}/${entry.name}`, content: entry.content })),
    hiddenVerifier: { kind: "zip", file, entries }
  };
}

const TASK_TEMPLATES = [nodeCliTemplate, pythonCliTemplate, jsonDocumentTemplate, externalNodeCliTemplate, jsonToCsvTemplate, zipArchiveTemplate];

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInteger(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function normalizeSeed(value) {
  const number = Number.parseInt(String(value ?? 20260715), 10);
  return Number.isFinite(number) ? Math.abs(number) : 20260715;
}
