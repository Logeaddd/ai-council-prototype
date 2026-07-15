import test from "node:test";
import assert from "node:assert/strict";
import { createSeededCampaignScenario, publicCampaignScenario } from "../src/realUserCampaign.js";

test("seeded user campaign generates reproducible capacity, edits, followups and disturbances without leaking its verifier", () => {
  const first = createSeededCampaignScenario({ seed: 20260715 });
  const second = createSeededCampaignScenario({ seed: 20260715 });
  const publicScenario = publicCampaignScenario(first);
  const followups = first.stages.filter((stage) => stage.kind === "followup");
  const artifactEdits = first.stages.filter((stage) => stage.artifactEdit);
  const mutations = first.stages.filter((stage) => stage.kind === "member_mutation").map((stage) => stage.mutation.type);

  assert.deepEqual(first, second);
  assert.equal(first.stages.length, first.capacity.stages);
  assert.equal(first.capacity.stages >= 10 && first.capacity.stages <= 30, true);
  assert.equal(followups.length, first.capacity.followups);
  assert.equal(followups.length >= 5 && followups.length <= 10, true);
  assert.equal(artifactEdits.length >= first.capacity.requiredArtifactEdits, true);
  assert.deepEqual(mutations, ["rename", "role", "reorder", "disable", "restore"]);
  assert.deepEqual(first.stages.filter((stage) => stage.kind === "interrupt").map((stage) => stage.interruptAt), ["during_model_streaming", "during_tool_or_build_activity"]);
  assert.equal(first.stages.filter((stage) => stage.kind === "reopen" && stage.prompt === "continue").length, 2);
  assert.equal(JSON.stringify(publicScenario).includes("hiddenVerifier"), false);
  assert.equal(JSON.stringify(publicScenario).includes(first.hiddenVerifier.expectedOutput), false);
});

test("different seeds select deterministic task variants while preserving the campaign contract", () => {
  const campaigns = [1, 2, 3, 4, 5, 6].map((seed) => createSeededCampaignScenario({ seed }));
  assert.equal(new Set(campaigns.map((campaign) => campaign.task.id)).size >= 2, true);
  for (const campaign of campaigns) {
    assert.equal(campaign.stages.length >= 10 && campaign.stages.length <= 30, true);
    assert.equal(campaign.stages.filter((stage) => stage.kind === "followup").length >= 5, true);
    assert.equal(campaign.stages.filter((stage) => stage.artifactEdit).length >= 4, true);
  }
});
