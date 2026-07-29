const CAMPAIGN_SCHEMA = "ai-council.real-user-campaign.v1";
export const EXTERNAL_ROOT_TOKEN = "{{EXTERNAL_ROOT}}";
export const CAMPAIGN_API_URL_TOKEN = "{{CAMPAIGN_API_URL}}";

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
      deliverable: task.deliverable,
      capabilityAcquisitionRequired: task.capabilityAcquisitionRequired === true,
      delegationRequired: task.delegationRequired === true
    },
    stages: stages.map((stage, index) => ({ id: `stage_${String(index + 1).padStart(2, "0")}`, ...stage })),
    fixtures: task.fixtures || [],
    apiFixture: task.apiFixture,
    historyFixture: task.historyFixture,
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

function apiCollectionTemplate(seed, random) {
  const file = `deliverables/catalog-${seed}.json`;
  const items = [
    { id: `atlas-${seed % 17}`, title: `Atlas ${seed % 10}`, priority: "high", active: true },
    { id: `beacon-${seed % 13}`, title: `Beacon ${seed % 8}`, priority: "medium", active: true },
    { id: `cedar-${seed % 11}`, title: `Cedar ${seed % 6}`, priority: "low", active: false }
  ];
  return {
    id: "api-collection",
    domain: "network_api_collection_and_structured_output",
    deliverable: file,
    initialQuestion: `Use a direct HTTP API request to collect the bounded catalog at ${CAMPAIGN_API_URL_TOKEN}. Create ${file} as valid JSON with an items array containing every returned item in response order. Include each item's id and title, then validate the artifact.`,
    edits: [
      { prompt: "Update the existing catalog JSON to preserve every collected item and include its priority field. Validate the artifact." },
      { prompt: "Update the same catalog JSON so every collected item also includes its active field. Preserve response order and validate it." },
      { prompt: "Use the latest requirements only: the final JSON must have source set to api_collection and an items array with id, title, priority and active for every collected item. Validate it." },
      { prompt: "Make the final requested catalog update without inventing or dropping API records. Preserve response order and validate the current JSON artifact." }
    ],
    reversalPrompt: "Use only the current catalog requirements. Do not restore an obsolete partial record layout from retained discussion.",
    recallPrompt: `Inspect the retained API task context and current ${file}, then continue from the newest requirement without creating a replacement artifact.`,
    finalPrompt: "Apply the final catalog requirement and validate the current JSON artifact one more time.",
    recoveryVerificationPrompt: `Validate ${file} once more after recovery and run a real command that confirms the JSON still parses.`,
    apiFixture: {
      path: `/v1/catalog/${seed}`,
      body: { items }
    },
    hiddenVerifier: {
      kind: "api_collection",
      file,
      expected: { source: "api_collection", items },
      apiUrl: CAMPAIGN_API_URL_TOKEN
    }
  };
}

function imageToolAcquisitionTemplate(seed, random) {
  const file = `deliverables/generated-image-${seed}.png`;
  const source = `inputs/image-spec-${seed}.json`;
  const width = randomInteger(random, 7, 11);
  const height = randomInteger(random, 6, 10);
  const colors = shuffled(random, ["#173F5F", "#20639B", "#3CAEA3", "#F6D55C", "#ED553B", "#7A5195"]);
  const spec = {
    width,
    height,
    background: colors[0],
    initialStripe: colors[1],
    finalStripe: colors[2],
    border: colors[3]
  };
  return {
    id: "image-tool-acquisition",
    domain: "capability_acquisition_and_binary_artifact",
    deliverable: file,
    capabilityAcquisitionRequired: true,
    initialQuestion: `Read ${source} and create ${file} as an RGBA PNG with the specified width, height and solid background color. The workspace has no task-specific image generator: choose and acquire a suitable third-party package or CLI yourself, without asking which product to use. Do not hand-encode PNG bytes. Verify the generated image.`,
    edits: [
      { prompt: `Update the existing PNG so its center column uses initialStripe from ${source}. Keep every other pixel as the specified background and verify the image.` },
      { prompt: `Update the same PNG with a one-pixel border using border from ${source}. Preserve the center stripe and verify the RGBA image.` },
      { prompt: `Change only the center stripe to finalStripe from ${source}. Keep the current border, dimensions and background, then verify the PNG.` },
      { prompt: `Make the final image update in ${file}: use the exact dimensions from ${source}, a one-pixel border, the finalStripe center column and background everywhere else. Verify the finished RGBA PNG without replacing it with a text or SVG file.` }
    ],
    reversalPrompt: "Use only the newest image requirements. Do not restore the initial stripe color or remove the current border.",
    recallPrompt: `Inspect the retained image task context, ${source} and the current ${file}, then continue from the newest requirement with the acquired capability.`,
    finalPrompt: "Apply the final requested PNG edit with the acquired third-party capability and verify the current binary artifact again.",
    recoveryVerificationPrompt: `Use the acquired image capability to inspect ${file} after recovery and run a real validation of its dimensions and RGBA data.`,
    fixtures: [{ path: source, content: JSON.stringify(spec, null, 2) + "\n" }],
    hiddenVerifier: {
      kind: "png_rgba",
      file,
      width,
      height,
      pixels: expectedImagePixels(spec),
      requiresAcquisition: true,
      // A clean, real virtual environment prevents an ambient host package
      // from being mistaken for agent-acquired capability evidence.
      requiresCleanPythonEnvironment: true
    }
  };
}

function delegatedBriefTemplate(seed, random) {
  const source = `inputs/release-research-${seed}.txt`;
  const file = `deliverables/release-brief-${seed}.json`;
  const release = `orion-${seed % 17}`;
  const window = `2026-Q${(seed % 4) + 1}`;
  return {
    id: "delegated-brief",
    domain: "bounded_research_delegation_and_owner_delivery",
    deliverable: file,
    delegationRequired: true,
    initialQuestion: `Create the verified release brief at ${file}. Work as a delivery team: the delivery owner must first use the native delegate_task control to create a narrow, read-only research task for Critic (assignee_id "critic") to inspect ${source} and return a bounded handoff naming the source and extracted release facts. Do not write the final brief until that handoff is available. The owner must then integrate the handoff into valid JSON with release, window and status fields, and validate the artifact. The contributor must not write the deliverable or finalize the task.`,
    edits: [
      { prompt: "Update the existing release brief to add a top-level string field named source with exactly value research_note. Do not replace it with a research_note object. Preserve the research-derived release and window, keep valid JSON, and have the owner validate it." },
      { prompt: "Update the same release brief to add audience set to internal. Preserve every current research-derived field and validate the current artifact." },
      { prompt: "Use only the latest requirement: status must be approved while release, window, source and audience remain present. Do not recreate the project or redo the completed research handoff. Validate the JSON." },
      { prompt: "Make the final requested release-brief update in the same artifact. Keep the handoff-derived release/window, a top-level string source equal to research_note, audience internal and status approved. The delivery owner must validate the finished JSON." }
    ],
    reversalPrompt: "Use the current release-brief requirements only. Do not restore an obsolete status or discard the completed research handoff.",
    recallPrompt: `Inspect the retained task context, the current ${file}, and the recorded contributor handoff. Continue the existing delivery from the newest requirement without creating a replacement project.`,
    finalPrompt: "Apply the final release-brief requirement and validate the current artifact one more time as the delivery owner.",
    recoveryVerificationPrompt: `After recovery, have the delivery owner inspect ${file} and run a real JSON validation. Do not repeat the completed contributor research or let the contributor write the deliverable.`,
    fixtures: [{ path: source, content: `release=${release}\nwindow=${window}\n` }],
    hiddenVerifier: {
      kind: "json",
      file,
      expected: { release, window, source: "research_note", audience: "internal", status: "approved" },
      requiresDelegation: true
    }
  };
}

function contextHistoryRetrievalTemplate(seed, random) {
  const file = `deliverables/history-lookup-${seed}.json`;
  const marker = `retained-record-${seed}-${randomInteger(random, 1000, 9999)}`;
  const historicalValue = `archive-value-${seed}-${randomInteger(random, 100000, 999999)}`;
  const sessionId = `retained-history-${seed}`;
  const targetMessageIndex = 36;
  return {
    id: "context-history-retrieval",
    domain: "retained_group_history_retrieval_and_delivery",
    deliverable: file,
    initialQuestion: `Use the search_context tool, rather than directly reading journal files, to retrieve the retained historical record with lookup marker ${JSON.stringify(marker)}. Do not guess its value. Then create ${file} as valid JSON with marker, historicalValue, retrievalMethod set to search_context, and status set to retrieved. Validate the current JSON after writing it.`,
    edits: [
      { prompt: "Update the existing lookup JSON to add recordType set to retained_lookup. Preserve the retrieved marker and historicalValue, keep valid JSON, and validate it." },
      { prompt: "Update the same lookup JSON to add retrievedBy set to context_search. Preserve the retrieved history value and validate the current artifact." },
      { prompt: "Use only the newest requirements: retain the retrieved marker and historicalValue, retrievalMethod search_context, status retrieved, recordType retained_lookup, and retrievedBy context_search. Do not replace the lookup with a guessed value. Validate it." },
      { prompt: "Make the final requested history-lookup update in the same artifact. Keep every current required field, use the retrieved historical value, and validate the finished JSON." }
    ],
    reversalPrompt: "Use the current retained-history requirements only. Do not restore an obsolete field layout or substitute an unverified value.",
    recallPrompt: `Retrieve the current retained-history context for ${JSON.stringify(marker)} when needed, then continue the existing ${file} from the latest requirements without creating a replacement project.`,
    finalPrompt: "Apply the final history-lookup requirement and validate the current artifact one more time.",
    recoveryVerificationPrompt: `After recovery, inspect ${file}, retain the historical value previously obtained through search_context, and run a real JSON validation without guessing or recreating the lookup.`,
    historyFixture: {
      sessionId,
      marker,
      historicalValue,
      targetMessageIndex,
      targetEventId: `${sessionId}:message:${targetMessageIndex}`,
      distractorCount: 72
    },
    hiddenVerifier: {
      kind: "json",
      file,
      expected: {
        marker,
        historicalValue
      },
      advisoryExpected: {
        retrievalMethod: "search_context",
        status: "retrieved",
        recordType: "retained_lookup",
        retrievedBy: "context_search"
      },
      requiresContextRetrieval: true,
      contextEventId: `${sessionId}:message:${targetMessageIndex}`
    }
  };
}

function pdfDocumentTemplate(seed, random) {
  const file = `deliverables/illustrated-report-${seed}.pdf`;
  const source = `inputs/report-spec-${seed}.json`;
  const title = `Field Brief ${seed % 97}`;
  const sections = ["Context", "Findings", "Recommendation"];
  const audience = ["project team", "decision makers", "contributors"][Math.floor(random() * 3)];
  const spec = { title, sections, audience, revision: 1 };
  return {
    id: "pdf-report",
    domain: "document_generation_and_binary_artifact",
    deliverable: file,
    capabilityAcquisitionRequired: true,
    initialQuestion: `Read ${source} and create ${file} as a complete illustrated PDF report. It must be at least two pages, include every requested section, and embed at least one raster illustration. The workspace has no task-specific PDF generator: choose and acquire a suitable third-party package or CLI yourself without asking which product to use. Do not hand-encode PDF bytes. Verify the generated document.`,
    edits: [
      { prompt: `Update the existing PDF report using the current spec in ${source}: make its Context section explicit, preserve the existing pages and raster illustration, then verify the same document.` },
      { prompt: `Update the same PDF report so its Findings section is complete. Keep it an illustrated multi-page PDF, preserve the existing required content, and verify it.` },
      { prompt: `Use only the newest report requirements: retain every requested section, include the current audience from ${source}, keep at least two pages and a raster illustration, then verify the current PDF.` },
      { prompt: `Make the final requested PDF update in ${file}. Keep one complete illustrated report, every current requested section and audience, at least two pages, and a raster illustration. Verify the finished PDF without replacing it with a text, HTML, or image file.` }
    ],
    reversalPrompt: "Use only the newest PDF report requirements. Do not restore an obsolete audience, omit a current section, or split the requested report into multiple files.",
    recallPrompt: `Inspect the retained report context, ${source}, and the current ${file}, then continue the existing document from the newest requirements without creating a replacement project.`,
    finalPrompt: `Apply the final PDF report requirement in ${file} and verify its current document structure, page count, and raster illustration one more time.`,
    recoveryVerificationPrompt: `After recovery, inspect ${file} with the acquired document capability and run a real verification that it remains a multi-page illustrated PDF.`,
    fixtures: [{ path: source, content: JSON.stringify(spec, null, 2) + "\n" }],
    hiddenVerifier: {
      kind: "pdf_document",
      file,
      minimumPages: 2,
      requiresImages: true,
      requiresAcquisition: true
    }
  };
}

function skillGuidedDocumentTemplate(seed, random) {
  const file = `deliverables/skill-brief-${seed}.json`;
  const source = `inputs/skill-brief-${seed}.json`;
  const title = `Skill Brief ${seed % 97}`;
  const summary = `Structured workflow note ${randomInteger(random, 1000, 9999)}`;
  const audience = ["contributors", "reviewers", "operators"][Math.floor(random() * 3)];
  const spec = { title, summary, audience };
  return {
    id: "skill-guided-document",
    domain: "skill_discovery_install_enable_read_and_structured_delivery",
    deliverable: file,
    capabilityAcquisitionRequired: true,
    initialQuestion: `Read ${source}. Then independently find a suitable maintained Skill for structured document work: use skill_search, install the chosen Skill with skill_install, enable it with skill_enable, and read its instructions with skill_read before making the deliverable. Do not invoke a made-up dynamic tool such as skill:<id>. Create ${file} as valid JSON containing the title, summary, and audience from the input plus status set to draft. Validate the artifact.`,
    edits: [
      { prompt: "Update the existing skill-guided JSON so status is review. Preserve the input-derived title, summary and audience, keep valid JSON, and validate it." },
      { prompt: "Update the same JSON to add format set to skill_guided. Keep every existing required field and validate the artifact." },
      { prompt: "Use only the newest requirements: keep title, summary, audience, format skill_guided, and set version to 2. Preserve valid JSON and validate it." },
      { prompt: "Make the final requested update in the same JSON: keep every current required field, set status to approved, and validate the finished artifact." }
    ],
    reversalPrompt: "Use only the current skill-guided document requirements. Do not restore an obsolete status or remove the current format and version fields.",
    recallPrompt: `Inspect ${source}, the current ${file}, and retained task context. Continue the existing skill-guided document from the newest requirement without creating a replacement project.`,
    finalPrompt: `Apply the final skill-guided document requirement in ${file} and validate the current JSON one more time.`,
    recoveryVerificationPrompt: `After recovery, inspect ${file} and validate its current JSON structure without reinstalling an already enabled Skill or recreating the project.`,
    fixtures: [{ path: source, content: JSON.stringify(spec, null, 2) + "\n" }],
    hiddenVerifier: {
      kind: "json",
      file,
      expected: { title, summary, audience, status: "approved", format: "skill_guided", version: 2 },
      requiresAcquisition: true,
      requiresSkillLifecycle: true
    }
  };
}

function mcpMemoryRecordTemplate(seed, random) {
  const file = `deliverables/mcp-record-${seed}.json`;
  const source = `inputs/mcp-record-${seed}.json`;
  const topic = `record-${seed % 97}`;
  const value = `mcp-fact-${randomInteger(random, 10000, 99999)}`;
  const spec = { topic, value };
  return {
    id: "mcp-memory-record",
    domain: "mcp_discovery_configuration_tool_use_and_structured_delivery",
    deliverable: file,
    capabilityAcquisitionRequired: true,
    initialQuestion: `Read ${source}. Independently obtain and use an MCP server appropriate for recording a small fact: first search npm with mcp_search_npm, configure the selected server with mcp_install_npm, inspect its real tools with mcp_list_tools, and invoke a suitable tool with mcp_call. Do not guess the MCP tool schema. Then create ${file} as valid JSON containing topic and value from the input plus source set to mcp_memory and status set to draft. Workspace tools may create the final JSON but cannot substitute for the required MCP search, configuration, tool listing, and tool call. Validate the artifact.`,
    edits: [
      { prompt: "Update the existing MCP record JSON so status is review. Preserve topic, value and source mcp_memory, keep valid JSON, and validate it." },
      { prompt: "Update the same MCP record JSON to add version set to 2. Preserve every current field and validate it." },
      { prompt: "Use the newest requirements only: keep topic, value, source mcp_memory, version 2, and set status to approved. Validate the current JSON artifact." },
      { prompt: "Make the final requested MCP record update in the same artifact. Keep every current required field and validate the finished JSON." }
    ],
    reversalPrompt: "Use only the current MCP record requirements. Do not restore an obsolete status or remove the required source and version fields.",
    recallPrompt: `Inspect ${source}, the current ${file}, and retained task context. Continue the same MCP-backed record from the newest requirement without replacing the project.`,
    finalPrompt: `Apply the final MCP record requirement in ${file} and validate the current JSON one more time.`,
    recoveryVerificationPrompt: `After recovery, inspect ${file} and validate its current JSON without repeating a completed MCP installation or recreating the project.`,
    fixtures: [{ path: source, content: JSON.stringify(spec, null, 2) + "\n" }],
    hiddenVerifier: {
      kind: "json",
      file,
      expected: { topic, value, source: "mcp_memory", status: "approved", version: 2 },
      requiresAcquisition: true,
      requiresMcpLifecycle: true
    }
  };
}

const TASK_TEMPLATES = [nodeCliTemplate, pythonCliTemplate, jsonDocumentTemplate, externalNodeCliTemplate, jsonToCsvTemplate, zipArchiveTemplate, apiCollectionTemplate, imageToolAcquisitionTemplate, delegatedBriefTemplate, contextHistoryRetrievalTemplate, pdfDocumentTemplate, skillGuidedDocumentTemplate, mcpMemoryRecordTemplate];

function expectedImagePixels(spec) {
  const background = hexRgba(spec.background);
  const stripe = hexRgba(spec.finalStripe);
  const border = hexRgba(spec.border);
  const center = Math.floor(spec.width / 2);
  const pixels = [];
  for (let y = 0; y < spec.height; y += 1) {
    for (let x = 0; x < spec.width; x += 1) {
      const color = x === 0 || y === 0 || x === spec.width - 1 || y === spec.height - 1
        ? border
        : x === center ? stripe : background;
      pixels.push(...color);
    }
  }
  return pixels;
}

function hexRgba(value) {
  const hex = String(value || "").replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).concat(255);
}

function shuffled(random, values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

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
