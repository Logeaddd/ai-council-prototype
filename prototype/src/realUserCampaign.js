const CAMPAIGN_SCHEMA = "ai-council.real-user-campaign.v1";

export function createSeededCampaignScenario(options = {}) {
  const seed = normalizeSeed(options.seed);
  const random = seededRandom(seed);
  const template = TASK_TEMPLATES[seed % TASK_TEMPLATES.length];
  const task = template(seed, random);
  const followupCount = randomInteger(random, 7, 9);
  const stageCount = randomInteger(random, Math.max(14, followupCount + 9), 30);
  const followups = buildFollowups(task, followupCount);
  const disturbances = buildDisturbances(seed);
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

function buildDisturbances(seed) {
  const suffix = String(seed).slice(-4);
  return [
    { kind: "member_mutation", mutation: { type: "rename", seatId: "seat_01", displayName: `Builder ${suffix}` } },
    { kind: "member_mutation", mutation: { type: "role", seatId: "seat_02", role: "reviewer" } },
    { kind: "member_mutation", mutation: { type: "reorder", seatIds: ["seat_02", "seat_01", "seat_03"] } },
    { kind: "member_mutation", mutation: { type: "disable", seatId: "seat_02" } },
    { kind: "member_mutation", mutation: { type: "restore", seatId: "seat_02", role: "summarizer" } },
    { kind: "interrupt", interruptAt: "during_model_or_tool_activity" },
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
    hiddenVerifier: { kind: "json", file, expected: { status: "released" } }
  };
}

const TASK_TEMPLATES = [nodeCliTemplate, pythonCliTemplate, jsonDocumentTemplate];

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
