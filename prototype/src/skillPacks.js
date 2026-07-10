import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./appSettings.js";
import { fetchPublicText } from "./webTools.js";
import { nowIso } from "./types.js";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 1200;
const MAX_SEARCH_RESULTS = 10;
const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const BUILT_IN_SKILLS = [
  builtInSkill(
    "web-research",
    "联网调研",
    "用于需要当前信息、多个来源和可核查网址的调研任务。",
    [
      "先用 web_search 找到多个相关来源，再用 fetch_url 阅读关键原文。",
      "区分来源事实、模型推断和未知信息。引用实际读取的网址，不要编造链接。",
      "来源冲突时保留分歧，并说明哪一项仍需核查。"
    ]
  ),
  builtInSkill(
    "code-agent",
    "代码助手",
    "用于读取项目、修改代码、运行命令和测试、验证交付物的工程任务。",
    [
      "先检查现有项目结构、约定和真实错误，再做最小必要修改。",
      "通过现有文件、终端、测试和 Git 工具工作。工具失败时读取实际输出后换策略。",
      "声称文件已创建或构建前，运行相应验证并引用当前会话的真实证据。"
    ]
  ),
  builtInSkill(
    "document-reader",
    "文档阅读",
    "用于阅读、对比、提取和整理本地或在线文档内容。",
    [
      "先确认文件类型和可用读取方式，再读取正文与必要元数据。",
      "长文档分段处理，保留章节、页码或文件路径等来源指针。",
      "摘要必须标明是摘要，不得把推测写成原文事实。"
    ]
  ),
  builtInSkill(
    "review-work",
    "审查工作",
    "用于复查代码、方案或交付物，优先发现真实缺陷和缺失验证。",
    [
      "先核对目标和验收条件，再查看实际文件、差异、测试和运行证据。",
      "发现按严重程度排序，给出文件或证据位置。没有问题时也说明剩余测试空白。",
      "不把个人偏好冒充客观缺陷；主观判断必须明确标注。"
    ]
  ),
  builtInSkill(
    "memory-summary",
    "总结记忆",
    "用于把公开讨论整理为可追溯的小组摘要和长期记忆候选。",
    [
      "保留用户原话、已验证事实、未解决问题和来源时间，不保存隐藏思维过程。",
      "明确区分原文、总结者理解和推测。总结不等于事实本身。",
      "只把稳定偏好、长期规则或明确事实作为长期记忆候选。"
    ]
  ),
  builtInSkill(
    "writing-polish",
    "写作润色",
    "用于在不改变核心意思的前提下改善文字的清晰度、结构和语气。",
    [
      "先识别受众、用途和必须保留的事实，再修改表达。",
      "不新增未经提供或核实的事实。专业词能不用就不用，必须用时给出通俗解释。",
      "优先短句和自然段，删除重复、套话和空泛过渡。"
    ]
  ),
  builtInSkill(
    "browser-check",
    "浏览器检查",
    "用于打开真实页面、操作界面、检查状态并保存截图证据。",
    [
      "用 browser_control 打开真实页面并执行用户路径，不靠源码字符串推断界面可用。",
      "检查加载、交互、错误状态和关键视口；需要时保存截图。",
      "页面未加载、元素不存在或操作失败时如实记录。"
    ]
  )
];

export function listSkillCatalog(baseDir) {
  const installed = new Map(listInstalledSkillPacks(baseDir).map((item) => [item.id, item]));
  return {
    catalog: BUILT_IN_SKILLS.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      sourceType: "built_in",
      installed: installed.has(item.id),
      installedRecord: installed.get(item.id)
    }))
  };
}

export function listInstalledSkillPacks(baseDir) {
  const root = skillStoreRoot(baseDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SKILL_ID_PATTERN.test(entry.name))
    .map((entry) => readInstalledMetadata(baseDir, entry.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkillPacksForGroup(baseDir, groupPath) {
  const installed = listInstalledSkillPacks(baseDir);
  const enabledIds = new Set(readEnabledSkillIds(groupPath));
  const knownIds = new Set(installed.map((item) => item.id));
  return {
    skills: installed.map((item) => ({ ...item, enabled: enabledIds.has(item.id) })),
    enabledMissing: [...enabledIds].filter((id) => !knownIds.has(id))
  };
}

export function readSkillPack(baseDir, skillId) {
  const id = requireSkillId(skillId);
  const metadata = readInstalledMetadata(baseDir, id);
  if (!metadata) throw skillError("skill_not_found", `Unknown skill pack: ${id}.`);
  const markdownPath = path.join(skillDirectory(baseDir, id), "SKILL.md");
  const markdown = fs.readFileSync(markdownPath, "utf8");
  const parsed = parseSkillMarkdown(markdown, { expectedId: id });
  return {
    ok: true,
    source: "local_skill_store",
    skill: {
      ...metadata,
      instructions: parsed.body,
      markdownBytes: Buffer.byteLength(markdown, "utf8")
    }
  };
}

export function readSkillPackChunk(baseDir, skillId, options = {}) {
  const result = readSkillPack(baseDir, skillId);
  const content = Buffer.from(result.skill.instructions, "utf8");
  const requestedOffset = clampNumber(options.offset, 0, 0, content.length);
  const offset = alignUtf8Start(content, requestedOffset);
  const maxBytes = clampNumber(options.maxBytes, 12 * 1024, 1024, 16 * 1024);
  const end = alignUtf8End(content, Math.min(content.length, offset + maxBytes));
  return {
    ...result,
    skill: {
      ...result.skill,
      instructions: content.subarray(offset, end).toString("utf8"),
      instructionOffset: offset,
      nextOffset: end,
      instructionsBytes: end - offset,
      totalInstructionsBytes: content.length,
      truncated: end < content.length
    }
  };
}

export function installBuiltInSkillPack(baseDir, skillId, options = {}) {
  const id = requireSkillId(skillId);
  const item = BUILT_IN_SKILLS.find((skill) => skill.id === id);
  if (!item) throw skillError("skill_catalog_item_not_found", `Unknown built-in skill: ${id}.`);
  return installSkillMarkdown(baseDir, item.markdown, {
    ...options,
    id,
    sourceType: "built_in",
    source: `built-in:${id}`
  });
}

export function installSkillMarkdown(baseDir, markdownInput, options = {}) {
  const markdown = normalizeMarkdown(markdownInput);
  const parsed = parseSkillMarkdown(markdown, { expectedId: options.id });
  const id = requireSkillId(options.id || parsed.id);
  const directory = skillDirectory(baseDir, id);
  const exists = fs.existsSync(directory);
  if (exists && !options.overwrite) {
    return {
      ok: false,
      source: "local_skill_store",
      code: "skill_already_installed",
      error: `Skill pack ${id} is already installed.`,
      skill: readInstalledMetadata(baseDir, id)
    };
  }
  const installedAt = nowIso();
  const hash = sha256(markdown);
  const metadata = {
    id,
    name: parsed.name,
    description: parsed.description,
    sourceType: normalizeSourceType(options.sourceType),
    source: String(options.source || "direct_markdown").slice(0, 2000),
    sourceUrl: String(options.sourceUrl || "").slice(0, 4000),
    sha256: hash,
    bytes: Buffer.byteLength(markdown, "utf8"),
    installedAt,
    updatedAt: installedAt,
    executableContent: false
  };
  const temporary = `${directory}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, "SKILL.md"), markdown, "utf8");
  fs.writeFileSync(path.join(temporary, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (exists) fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(temporary, directory);
  appendSkillAudit(baseDir, "install", metadata);
  return { ok: true, source: "local_skill_store", skill: metadata };
}

export async function installRemoteSkillPack(baseDir, input = {}, options = {}) {
  const sourceUrl = normalizeSkillSourceUrl(input.url || input.sourceUrl);
  if (!sourceUrl) throw skillError("missing_skill_url", "A public HTTPS SKILL.md URL is required.");
  const response = await (options.fetchText || fetchPublicText)(sourceUrl, {
    timeoutMs: input.timeoutMs || options.timeoutMs,
    maxBytes: MAX_SKILL_BYTES,
    signal: options.signal,
    allowHttp: options.allowHttp,
    allowUnsafePrivateNetwork: options.allowUnsafePrivateNetwork
  });
  if (response.truncated) {
    throw skillError("skill_download_truncated", `Remote SKILL.md exceeds ${MAX_SKILL_BYTES} bytes and was not installed.`);
  }
  return installSkillMarkdown(baseDir, response.text, {
    id: input.skillId || input.id,
    overwrite: Boolean(input.overwrite),
    sourceType: "remote_url",
    source: skillSourceUrlForStorage(response.url || sourceUrl),
    sourceUrl: skillSourceUrlForStorage(response.url || sourceUrl)
  });
}

export function removeSkillPack(baseDir, skillId) {
  const id = requireSkillId(skillId);
  const metadata = readInstalledMetadata(baseDir, id);
  if (!metadata) return { ok: true, deleted: false, id };
  fs.rmSync(skillDirectory(baseDir, id), { recursive: true, force: true });
  appendSkillAudit(baseDir, "remove", { id, sha256: metadata.sha256, sourceType: metadata.sourceType });
  return { ok: true, deleted: true, id };
}

export function enableSkillForGroup(baseDir, groupPath, skillId) {
  const id = requireSkillId(skillId);
  if (!readInstalledMetadata(baseDir, id)) throw skillError("skill_not_found", `Skill pack ${id} is not installed.`);
  const group = readGroup(groupPath);
  const enabled = new Set(normalizeSkillIds(group.settings?.enabledSkillIds));
  enabled.add(id);
  writeEnabledSkillIds(groupPath, group, [...enabled]);
  appendSkillAudit(baseDir, "enable", { id, groupPath: safeGroupName(groupPath) });
  return { ok: true, id, enabled: true, enabledSkillIds: [...enabled] };
}

export function disableSkillForGroup(baseDir, groupPath, skillId) {
  const id = requireSkillId(skillId);
  const group = readGroup(groupPath);
  const enabled = new Set(normalizeSkillIds(group.settings?.enabledSkillIds));
  const changed = enabled.delete(id);
  writeEnabledSkillIds(groupPath, group, [...enabled]);
  appendSkillAudit(baseDir, "disable", { id, groupPath: safeGroupName(groupPath), changed });
  return { ok: true, id, enabled: false, changed, enabledSkillIds: [...enabled] };
}

export function listEnabledSkillMetadata(baseDir, groupPath) {
  const enabledIds = readEnabledSkillIds(groupPath);
  const metadata = [];
  const missing = [];
  for (const id of enabledIds) {
    const item = readInstalledMetadata(baseDir, id);
    if (item) metadata.push({ id: item.id, name: item.name, description: item.description, sha256: item.sha256 });
    else missing.push(id);
  }
  return { skills: metadata, missing };
}

export function formatEnabledSkillMetadataForPrompt(value = {}) {
  const skills = Array.isArray(value.skills) ? value.skills : [];
  const missing = Array.isArray(value.missing) ? value.missing : [];
  const lines = [];
  if (skills.length) {
    lines.push("Enabled skill packs (metadata only; full instructions are not loaded yet):");
    for (const skill of skills) lines.push(`- ${skill.id}: ${skill.name} — ${skill.description}`);
    lines.push("When a skill is relevant, request skill_read with skillId before following its detailed instructions.");
  }
  if (missing.length) lines.push(`Enabled skill ids missing from local storage: ${missing.join(", ")}. Do not claim their instructions are available.`);
  return lines.join("\n");
}

export async function searchSkillCandidates(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) return { ok: false, source: "github_repository_search", code: "missing_query", error: "Missing skill search query.", results: [] };
  const count = clampNumber(options.count, 8, 1, MAX_SEARCH_RESULTS);
  const catalogResults = BUILT_IN_SKILLS
    .filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(text.toLowerCase()))
    .slice(0, count)
    .map((item) => ({
      type: "built_in",
      id: item.id,
      name: item.name,
      description: item.description,
      verifiedSkillFile: true
    }));
  const endpoint = new URL(options.endpoint || "https://api.github.com/search/repositories");
  endpoint.searchParams.set("q", `${text} skill in:name,description,readme`);
  endpoint.searchParams.set("per_page", String(count));
  try {
    const response = await (options.fetchText || fetchPublicText)(endpoint.toString(), {
      timeoutMs: options.timeoutMs,
      maxBytes: 160 * 1024,
      signal: options.signal,
      allowHttp: options.allowHttp,
      allowUnsafePrivateNetwork: options.allowUnsafePrivateNetwork
    });
    const parsed = JSON.parse(response.text);
    const remoteResults = (parsed.items || []).slice(0, count).map((item) => ({
      type: "github_repository_candidate",
      id: String(item.full_name || "").replaceAll("/", "--").toLowerCase(),
      name: String(item.full_name || item.name || "").trim(),
      description: String(item.description || "").trim(),
      url: String(item.html_url || "").trim(),
      skillUrl: suggestedRawSkillUrl(item),
      stars: Number(item.stargazers_count || 0),
      updatedAt: String(item.updated_at || ""),
      verifiedSkillFile: false,
      note: "Repository search candidate only. Installation must fetch and validate the suggested SKILL.md URL."
    })).filter((item) => item.name && item.skillUrl);
    return { ok: true, source: "github_repository_search", query: text, results: [...catalogResults, ...remoteResults].slice(0, count) };
  } catch (error) {
    if (catalogResults.length) return { ok: true, source: "built_in_catalog_only", query: text, warning: error.message, results: catalogResults };
    return { ok: false, source: "github_repository_search", code: "skill_search_failed", error: error.message || "Skill search failed.", results: [] };
  }
}

export function parseSkillMarkdown(input, options = {}) {
  const markdown = normalizeMarkdown(input);
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw skillError("invalid_skill_frontmatter", "SKILL.md must start with YAML frontmatter bounded by --- lines.");
  const frontmatter = parseFrontmatter(match[1]);
  const name = String(frontmatter.name || "").trim();
  const description = String(frontmatter.description || "").trim();
  if (!name) throw skillError("missing_skill_name", "SKILL.md frontmatter requires name.");
  if (!description) throw skillError("missing_skill_description", "SKILL.md frontmatter requires description.");
  if (description.length > MAX_DESCRIPTION_CHARS) throw skillError("skill_description_too_long", `Skill description exceeds ${MAX_DESCRIPTION_CHARS} characters.`);
  const id = requireSkillId(options.expectedId || name);
  const body = match[2].trim();
  if (!body) throw skillError("missing_skill_body", "SKILL.md requires instruction content after frontmatter.");
  return { id, name, description, body, markdown };
}

function parseFrontmatter(text) {
  const result = {};
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const raw = match[2];
    if ((raw === "|" || raw === ">") && index + 1 < lines.length) {
      const values = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) values.push(lines[++index].trim());
      result[key] = raw === ">" ? values.join(" ") : values.join("\n");
    } else {
      result[key] = parseScalar(raw);
    }
  }
  return result;
}

function parseScalar(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

function builtInSkill(id, name, description, instructions) {
  const markdown = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    ...instructions.map((item) => `- ${item}`),
    ""
  ].join("\n");
  return { id, name, description, markdown };
}

function normalizeMarkdown(input) {
  const markdown = String(input || "").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim() + "\n";
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_SKILL_BYTES) throw skillError("skill_too_large", `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes.`);
  if (/\u0000/.test(markdown)) throw skillError("invalid_skill_content", "SKILL.md contains invalid control characters.");
  return markdown;
}

function normalizeSkillSourceUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw skillError("invalid_skill_url", "Skill source URL is invalid.");
  }
  if (url.hostname.toLowerCase() === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const blobIndex = parts.indexOf("blob");
    if (parts.length >= 5 && blobIndex === 2) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`;
    }
  }
  return url.toString();
}

function skillSourceUrlForStorage(value) {
  const url = new URL(String(value || ""));
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function suggestedRawSkillUrl(item = {}) {
  const fullName = String(item.full_name || "").trim();
  const branch = String(item.default_branch || "main").trim();
  if (!fullName || !branch) return "";
  return `https://raw.githubusercontent.com/${fullName}/${branch}/SKILL.md`;
}

function readInstalledMetadata(baseDir, skillId) {
  const id = requireSkillId(skillId);
  const directory = skillDirectory(baseDir, id);
  const metadataPath = path.join(directory, "metadata.json");
  const markdownPath = path.join(directory, "SKILL.md");
  if (!fs.existsSync(metadataPath) || !fs.existsSync(markdownPath)) return undefined;
  try {
    const stored = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const markdown = fs.readFileSync(markdownPath, "utf8");
    const parsed = parseSkillMarkdown(markdown, { expectedId: id });
    const actualHash = sha256(normalizeMarkdown(markdown));
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      sourceType: normalizeSourceType(stored.sourceType),
      source: String(stored.source || "").slice(0, 2000),
      sourceUrl: String(stored.sourceUrl || "").slice(0, 4000),
      sha256: actualHash,
      storedSha256: String(stored.sha256 || ""),
      integrity: actualHash === stored.sha256 ? "verified" : "changed_on_disk",
      bytes: Buffer.byteLength(markdown, "utf8"),
      installedAt: String(stored.installedAt || ""),
      updatedAt: String(stored.updatedAt || stored.installedAt || ""),
      executableContent: false
    };
  } catch {
    return undefined;
  }
}

function readEnabledSkillIds(groupPath) {
  if (!groupPath) return [];
  try {
    return normalizeSkillIds(readGroup(groupPath).settings?.enabledSkillIds);
  } catch {
    return [];
  }
}

function writeEnabledSkillIds(groupPath, group, ids) {
  group.settings = { ...(group.settings || {}), enabledSkillIds: normalizeSkillIds(ids) };
  const filePath = path.join(groupPath, "group.json");
  const temporary = `${filePath}.${process.pid}.tmp`;
  const backup = `${filePath}.${process.pid}.bak`;
  fs.writeFileSync(temporary, JSON.stringify(group, null, 2), "utf8");
  fs.rmSync(backup, { force: true });
  try {
    fs.renameSync(filePath, backup);
    fs.renameSync(temporary, filePath);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    if (!fs.existsSync(filePath) && fs.existsSync(backup)) fs.renameSync(backup, filePath);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function readGroup(groupPath) {
  const filePath = path.join(path.resolve(groupPath || ""), "group.json");
  if (!groupPath || !fs.existsSync(filePath)) throw skillError("group_not_found", "A real group workspace with group.json is required.");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeSkillIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter((item) => SKILL_ID_PATTERN.test(item)))];
}

function normalizeSourceType(value) {
  const source = String(value || "direct_markdown").trim();
  return ["built_in", "direct_markdown", "remote_url"].includes(source) ? source : "direct_markdown";
}

function skillStoreRoot(baseDir) {
  return path.join(userDataDir(baseDir), "skills");
}

function skillDirectory(baseDir, skillId) {
  return path.join(skillStoreRoot(baseDir), requireSkillId(skillId));
}

function requireSkillId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!SKILL_ID_PATTERN.test(id)) throw skillError("invalid_skill_id", "Skill id must use lowercase letters, digits, and hyphens and be at most 64 characters.");
  return id;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function appendSkillAudit(baseDir, action, data = {}) {
  try {
    const filePath = path.join(skillStoreRoot(baseDir), "audit.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ action, ...data, createdAt: nowIso() })}\n`, "utf8");
  } catch {}
}

function safeGroupName(groupPath) {
  return path.basename(path.resolve(groupPath || "."));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function alignUtf8Start(buffer, offset) {
  let index = Math.max(0, Math.min(buffer.length, offset));
  while (index < buffer.length && (buffer[index] & 0xC0) === 0x80) index += 1;
  return index;
}

function alignUtf8End(buffer, offset) {
  let index = Math.max(0, Math.min(buffer.length, offset));
  while (index > 0 && index < buffer.length && (buffer[index] & 0xC0) === 0x80) index -= 1;
  return index;
}

function skillError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
