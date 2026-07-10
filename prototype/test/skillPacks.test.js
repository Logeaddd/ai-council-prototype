import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  disableSkillForGroup,
  enableSkillForGroup,
  formatEnabledSkillMetadataForPrompt,
  installBuiltInSkillPack,
  installRemoteSkillPack,
  installSkillMarkdown,
  listEnabledSkillMetadata,
  listInstalledSkillPacks,
  listSkillCatalog,
  listSkillPacksForGroup,
  parseSkillMarkdown,
  readSkillPack,
  removeSkillPack,
  searchSkillCandidates
} from "../src/skillPacks.js";
import { executeToolRequests } from "../src/toolRequests.js";

function makeRoots() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-skill-base-"));
  const dataDir = path.join(baseDir, "data");
  const groupPath = path.join(baseDir, "group");
  fs.mkdirSync(groupPath, { recursive: true });
  fs.writeFileSync(path.join(groupPath, "group.json"), JSON.stringify({ name: "Test", settings: {} }, null, 2), "utf8");
  return { baseDir, dataDir, groupPath };
}

function markdown(id = "custom-skill", marker = "CUSTOM_SKILL_FACT") {
  return `---\nname: ${id}\ndescription: Use for a focused real workflow.\n---\n\n# Workflow\n\n- ${marker}\n`;
}

test("skill markdown parser requires bounded frontmatter and instructions", () => {
  const parsed = parseSkillMarkdown(markdown());
  assert.equal(parsed.id, "custom-skill");
  assert.equal(parsed.name, "custom-skill");
  assert.match(parsed.body, /CUSTOM_SKILL_FACT/);
  assert.throws(() => parseSkillMarkdown("# Missing frontmatter"), /frontmatter/);
  assert.throws(() => parseSkillMarkdown("---\nname: bad\n---\nbody"), /description/);
});

test("direct and built-in skill installs persist real content hash and catalog state", () => {
  const { baseDir, dataDir } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    const direct = installSkillMarkdown(baseDir, markdown());
    const builtIn = installBuiltInSkillPack(baseDir, "code-agent");
    const duplicate = installSkillMarkdown(baseDir, markdown());
    const installed = listInstalledSkillPacks(baseDir);
    const read = readSkillPack(baseDir, "custom-skill");
    const catalog = listSkillCatalog(baseDir);

    assert.equal(direct.ok, true);
    assert.equal(direct.skill.sha256.length, 64);
    assert.equal(direct.skill.executableContent, false);
    assert.equal(builtIn.ok, true);
    assert.equal(builtIn.skill.name, "代码助手");
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, "skill_already_installed");
    assert.equal(installed.length, 2);
    assert.match(read.skill.instructions, /CUSTOM_SKILL_FACT/);
    assert.equal(read.skill.integrity, "verified");
    assert.equal(catalog.catalog.find((item) => item.id === "code-agent")?.installed, true);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("remote skill install rejects a truncated response instead of storing partial instructions", async () => {
  const { baseDir, dataDir } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    await assert.rejects(
      installRemoteSkillPack(baseDir, { url: "https://example.com/SKILL.md" }, {
        fetchText: async () => ({
          ok: true,
          url: "https://example.com/SKILL.md",
          text: markdown("partial-skill"),
          truncated: true
        })
      }),
      (error) => error.code === "skill_download_truncated"
    );
    assert.equal(listInstalledSkillPacks(baseDir).length, 0);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("skills enable per group and inject metadata without full body", () => {
  const { baseDir, dataDir, groupPath } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    installSkillMarkdown(baseDir, markdown());
    enableSkillForGroup(baseDir, groupPath, "custom-skill");
    const state = listSkillPacksForGroup(baseDir, groupPath);
    const enabled = listEnabledSkillMetadata(baseDir, groupPath);
    const prompt = formatEnabledSkillMetadataForPrompt(enabled);

    assert.equal(state.skills[0].enabled, true);
    assert.equal(enabled.skills[0].id, "custom-skill");
    assert.match(prompt, /custom-skill/);
    assert.match(prompt, /skill_read/);
    assert.doesNotMatch(prompt, /CUSTOM_SKILL_FACT/);

    disableSkillForGroup(baseDir, groupPath, "custom-skill");
    assert.equal(listSkillPacksForGroup(baseDir, groupPath).skills[0].enabled, false);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("remote skill install reads a real bounded HTTP response and stores source facts", async () => {
  const { baseDir, dataDir } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(markdown("remote-skill", "REMOTE_SKILL_FACT"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await installRemoteSkillPack(baseDir, {
      url: `http://127.0.0.1:${address.port}/SKILL.md`
    }, {
      allowHttp: true,
      allowUnsafePrivateNetwork: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.skill.sourceType, "remote_url");
    assert.match(result.skill.sourceUrl, /127\.0\.0\.1/);
    assert.match(readSkillPack(baseDir, "remote-skill").skill.instructions, /REMOTE_SKILL_FACT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("remote skill source facts omit signed query parameters and fragments", async () => {
  const { baseDir, dataDir } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    const result = await installRemoteSkillPack(baseDir, {
      url: "https://example.com/SKILL.md?token=SECRET_QUERY_VALUE#fragment"
    }, {
      fetchText: async (url) => ({ ok: true, url, text: markdown("signed-skill"), truncated: false })
    });
    assert.equal(result.skill.sourceUrl, "https://example.com/SKILL.md");
    assert.doesNotMatch(JSON.stringify(result), /SECRET_QUERY_VALUE|fragment/);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("skill tool records omit signed URL queries even when installation is rejected", async () => {
  const { baseDir, dataDir, groupPath } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    const result = await executeToolRequests({
      baseDir,
      groupPath,
      permissionTier: "tool",
      agent: { id: "tool", name: "Tool" },
      round: 1,
      requests: [{
        tool: "skill_install",
        skillUrl: "https://example.com/SKILL.md?token=SECRET_QUERY_VALUE#fragment",
        reason: "Install remote instructions."
      }]
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.rejected[0].skillUrl, "https://example.com/SKILL.md");
    assert.doesNotMatch(serialized, /SECRET_QUERY_VALUE|fragment/);
    assert.doesNotMatch(fs.readFileSync(path.join(groupPath, "shared", "logs", "tools.jsonl"), "utf8"), /SECRET_QUERY_VALUE|fragment/);
    assert.doesNotMatch(fs.readFileSync(path.join(groupPath, "shared", "logs", "skills.jsonl"), "utf8"), /SECRET_QUERY_VALUE|fragment/);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("skill search labels GitHub results as unverified repository candidates", async () => {
  const response = await searchSkillCandidates("deploy", {
    endpoint: "http://127.0.0.1/search",
    allowHttp: true,
    allowUnsafePrivateNetwork: true,
    fetchText: async () => ({
      ok: true,
      url: "http://127.0.0.1/search",
      text: JSON.stringify({ items: [{
        full_name: "example/deploy-skill",
        name: "deploy-skill",
        description: "Deploy workflow",
        html_url: "https://github.com/example/deploy-skill",
        default_branch: "main",
        stargazers_count: 3,
        updated_at: "2026-07-10T00:00:00Z"
      }] })
    })
  });

  assert.equal(response.ok, true);
  const candidate = response.results.find((item) => item.type === "github_repository_candidate");
  assert.equal(candidate.verifiedSkillFile, false);
  assert.equal(candidate.skillUrl, "https://raw.githubusercontent.com/example/deploy-skill/main/SKILL.md");
  assert.match(candidate.note, /candidate only/i);
});

test("removing a skill deletes the real stored package", () => {
  const { baseDir, dataDir } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    installSkillMarkdown(baseDir, markdown());
    assert.equal(removeSkillPack(baseDir, "custom-skill").deleted, true);
    assert.equal(removeSkillPack(baseDir, "custom-skill").deleted, false);
    assert.equal(listInstalledSkillPacks(baseDir).length, 0);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("tool chain reads only enabled skills and reserves skill mutations for full permission", async () => {
  const { baseDir, dataDir, groupPath } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  try {
    installSkillMarkdown(baseDir, markdown());
    const disabledRead = await executeToolRequests({
      baseDir, groupPath, permissionTier: "tool", agent: { id: "tool", name: "Tool" }, round: 1,
      requests: [{ tool: "skill_read", skillId: "custom-skill", reason: "Read relevant instructions." }]
    });
    assert.equal(disabledRead.results[0].code, "skill_not_enabled");

    enableSkillForGroup(baseDir, groupPath, "custom-skill");
    const enabledRead = await executeToolRequests({
      baseDir, groupPath, permissionTier: "tool", agent: { id: "tool", name: "Tool" }, round: 1,
      requests: [{ tool: "skill_read", skillId: "custom-skill", reason: "Read relevant instructions." }]
    });
    assert.match(enabledRead.results[0].result.skill.instructions, /CUSTOM_SKILL_FACT/);

    const deniedMutation = await executeToolRequests({
      baseDir, groupPath, permissionTier: "tool", agent: { id: "tool", name: "Tool" }, round: 1,
      requests: [{ tool: "skill_disable", skillId: "custom-skill", reason: "Change group skills." }]
    });
    assert.equal(deniedMutation.rejected[0].code, "permission_denied");

    const fullMutation = await executeToolRequests({
      baseDir, groupPath, permissionTier: "full", agent: { id: "full", name: "Full" }, round: 1,
      requests: [{ tool: "skill_disable", skillId: "custom-skill", reason: "Change group skills." }]
    });
    assert.equal(fullMutation.results[0].status, "completed");
    assert.equal(listSkillPacksForGroup(baseDir, groupPath).skills[0].enabled, false);
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});

test("skill_read pages large UTF-8 instructions and stores only bounded request and audit summaries", async () => {
  const { baseDir, dataDir, groupPath } = makeRoots();
  const previous = process.env.AI_COUNCIL_DATA_DIR;
  process.env.AI_COUNCIL_DATA_DIR = dataDir;
  const marker = "分页内容".repeat(1800);
  try {
    installSkillMarkdown(baseDir, markdown("paged-skill", marker));
    enableSkillForGroup(baseDir, groupPath, "paged-skill");
    const first = await executeToolRequests({
      baseDir, groupPath, permissionTier: "tool", agent: { id: "tool", name: "Tool" }, round: 1,
      requests: [{ tool: "skill_read", skillId: "paged-skill", maxBytes: 4096, reason: "Read a bounded chunk." }]
    });
    const firstSkill = first.results[0].result.skill;
    assert.equal(firstSkill.truncated, true);
    assert.equal(firstSkill.instructionsBytes <= 4096, true);
    assert.doesNotMatch(JSON.stringify(first.events), /分页内容分页内容分页内容/);

    const second = await executeToolRequests({
      baseDir, groupPath, permissionTier: "tool", agent: { id: "tool", name: "Tool" }, round: 1,
      requests: [{ tool: "skill_read", skillId: "paged-skill", offset: firstSkill.nextOffset, maxBytes: 4096, reason: "Continue reading." }]
    });
    assert.equal(second.results[0].result.skill.instructionOffset, firstSkill.nextOffset);
    assert.doesNotMatch(fs.readFileSync(path.join(groupPath, "shared", "logs", "skills.jsonl"), "utf8"), /分页内容分页内容分页内容/);

    const directBodyMarker = "DIRECT_BODY_NOT_IN_ACCEPTED_RECORD";
    const direct = await executeToolRequests({
      baseDir, groupPath, permissionTier: "full", agent: { id: "full", name: "Full" }, round: 1,
      requests: [{ tool: "skill_install", skillMarkdown: markdown("direct-record-skill", directBodyMarker), reason: "Install direct text." }]
    });
    assert.doesNotMatch(JSON.stringify(direct.accepted), new RegExp(directBodyMarker));
  } finally {
    if (previous === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = previous;
  }
});
