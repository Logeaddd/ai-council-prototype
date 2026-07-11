import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./appSettings.js";
import { fetchPublicBuffer, fetchPublicText } from "./webTools.js";
import { nowIso } from "./types.js";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_BUNDLE_FILES = 80;
const MAX_BUNDLE_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 1200;
const MAX_SEARCH_RESULTS = 10;
const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const LEGACY_PROMPT_SKILL_IDS = new Set(["web-research", "code-agent", "document-reader", "review-work", "memory-summary", "writing-polish", "browser-check"]);

const SKILL_CATALOG = [
  githubSkill("openai-playwright", "Playwright", "浏览器操作与界面测试", "openai", "skills", "skills/.curated/playwright", "49f948faa9258a0c61caceaf225e179651397431", ["LICENSE.txt", "NOTICE.txt", "SKILL.md", "agents/openai.yaml", "assets/playwright-small.svg", "assets/playwright.png", "references/cli.md", "references/workflows.md", "scripts/playwright_cli.sh"]),
  githubSkill("openai-pdf", "PDF", "读取、创建和检查 PDF", "openai", "skills", "skills/.curated/pdf", "49f948faa9258a0c61caceaf225e179651397431", ["LICENSE.txt", "SKILL.md", "agents/openai.yaml", "assets/pdf.png"]),
  githubSkill("openai-security-best-practices", "安全检查", "按语言和框架检查常见安全问题", "openai", "skills", "skills/.curated/security-best-practices", "49f948faa9258a0c61caceaf225e179651397431", ["LICENSE.txt", "SKILL.md", "agents/openai.yaml", "references/golang-general-backend-security.md", "references/javascript-express-web-server-security.md", "references/javascript-general-web-frontend-security.md", "references/javascript-jquery-web-frontend-security.md", "references/javascript-typescript-nextjs-web-server-security.md", "references/javascript-typescript-react-web-frontend-security.md", "references/javascript-typescript-vue-web-frontend-security.md", "references/python-django-web-server-security.md", "references/python-fastapi-web-server-security.md", "references/python-flask-web-server-security.md"]),
  githubSkill("anthropic-doc-coauthoring", "文档协作", "共同起草、修改和检查文档", "anthropics", "skills", "skills/doc-coauthoring", "9d2f1ae187231d8199c64b5b762e1bdf2244733d", ["SKILL.md"])
];

export function listSkillCatalog(baseDir) {
  const installed = new Map(listInstalledSkillPacks(baseDir).map((item) => [item.id, item]));
  return {
    catalog: SKILL_CATALOG.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      sourceType: "github_directory",
      source: item.source,
      sourceUrl: item.sourceUrl,
      repository: item.repository,
      repositoryPath: item.repositoryPath,
      ref: item.ref,
      installed: installed.has(item.id),
      installedRecord: installed.get(item.id)
    }))
  };
}

export function listInstalledSkillPacks(baseDir) {
  pruneLegacyPromptSkills(baseDir);
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
  const knownIds = new Set(installed.map((item) => item.id));
  const enabledIds = new Set(removeLegacyEnabledSkillIds(groupPath, knownIds));
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

export async function installBuiltInSkillPack(baseDir, skillId, options = {}) {
  const id = requireSkillId(skillId);
  const item = SKILL_CATALOG.find((skill) => skill.id === id);
  if (!item) throw skillError("skill_catalog_item_not_found", `Unknown catalog skill: ${id}.`);
  return installGithubSkillDirectory(baseDir, { ...item, ...(Array.isArray(options.files) ? { files: options.files } : {}) }, options);
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

export async function installGithubSkillDirectory(baseDir, input = {}, options = {}) {
  const spec = normalizeGithubSkillSpec(input);
  const existingBySource = listInstalledSkillPacks(baseDir).find((item) => item.sourceIdentity === spec.sourceIdentity && item.id !== spec.id);
  if (existingBySource) {
    return {
      ok: false,
      source: "local_skill_store",
      code: "skill_source_already_installed",
      error: `This Skill source is already installed as ${existingBySource.id}.`,
      skill: existingBySource
    };
  }
  const directory = skillDirectory(baseDir, spec.id);
  if (fs.existsSync(directory) && !options.overwrite) {
    return { ok: false, source: "local_skill_store", code: "skill_already_installed", error: `Skill pack ${spec.id} is already installed.`, skill: readInstalledMetadata(baseDir, spec.id) };
  }

  const fetchText = options.fetchText || fetchPublicText;
  const fetchBytes = options.fetchBytes || fetchPublicBuffer;
  let revision = spec.ref;
  let blobs;
  if (Array.isArray(spec.files) && spec.files.length) {
    blobs = spec.files.map((filePath) => ({ path: filePath, type: "blob", size: 0, sha: "pinned-manifest" }));
  } else {
    const directoryInfo = await resolveGithubDirectoryInfo(fetchText, spec, options);
    if (!directoryInfo || directoryInfo.type !== "dir" || !directoryInfo.sha) throw skillError("skill_directory_not_found", "GitHub Skill directory was not found.");
    revision = String(directoryInfo.sha);
    const tree = await fetchGithubJson(fetchText, githubApiUrl(`/repos/${spec.owner}/${spec.repo}/git/trees/${directoryInfo.sha}?recursive=1`), options);
    if (tree.truncated) throw skillError("skill_tree_truncated", "GitHub returned a truncated Skill directory tree.");
    blobs = (Array.isArray(tree.tree) ? tree.tree : []).filter((item) => item.type === "blob");
  }
  validateBundleEntries(blobs);

  const files = [];
  let totalBytes = 0;
  for (const blob of blobs) {
    const relativePath = normalizeBundlePath(blob.path);
    const rawUrl = Array.isArray(spec.files) && spec.files.length
      ? `https://cdn.jsdelivr.net/gh/${spec.owner}/${spec.repo}@${encodeURIComponent(spec.ref)}/${encodeGithubPath(spec.repositoryPath)}/${encodeGithubPath(relativePath)}`
      : `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${encodeURIComponent(spec.ref)}/${encodeGithubPath(spec.repositoryPath)}/${encodeGithubPath(relativePath)}`;
    const payload = await fetchSkillFileWithRetry(fetchBytes, rawUrl, {
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_BUNDLE_FILE_BYTES,
      signal: options.signal,
      allowHttp: options.allowHttp,
      allowUnsafePrivateNetwork: options.allowUnsafePrivateNetwork
    });
    if (payload.truncated) throw skillError("skill_file_too_large", `${relativePath} exceeds the per-file limit.`);
    const content = Buffer.from(payload.buffer);
    if (content.length > MAX_BUNDLE_FILE_BYTES) throw skillError("skill_file_too_large", `${relativePath} exceeds the per-file limit.`);
    totalBytes += content.length;
    if (totalBytes > MAX_BUNDLE_BYTES) throw skillError("skill_bundle_too_large", `Skill bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`);
    files.push({ path: relativePath, content, sha: String(blob.sha || "") });
  }
  const skillFile = files.find((item) => item.path === "SKILL.md");
  if (!skillFile) throw skillError("missing_skill_file", "GitHub Skill directory does not contain SKILL.md.");
  const markdown = normalizeMarkdown(skillFile.content.toString("utf8"));
  const parsed = parseSkillMarkdown(markdown, { expectedId: spec.id });
  verifyLocalReferences(markdown, new Set(files.map((item) => item.path)));

  const installedAt = nowIso();
  const bundleHash = hashBundle(files);
  const licenseFile = files.find((item) => /^LICENSE(?:\.|$)/i.test(item.path));
  const metadata = {
    id: spec.id,
    name: spec.displayName || parsed.name,
    description: spec.description || parsed.description,
    sourceType: "github_directory",
    source: spec.source,
    sourceUrl: spec.sourceUrl,
    sourceIdentity: spec.sourceIdentity,
    repository: `${spec.owner}/${spec.repo}`,
    repositoryPath: spec.repositoryPath,
    ref: spec.ref,
    revision,
    sha256: sha256(markdown),
    bundleSha256: bundleHash,
    bytes: Buffer.byteLength(markdown, "utf8"),
    bundleBytes: totalBytes,
    fileCount: files.length,
    files: files.map((item) => item.path),
    licenseFile: licenseFile?.path || "",
    installedAt,
    updatedAt: installedAt,
    executableContent: files.some((item) => item.path.startsWith("scripts/"))
  };
  const temporary = `${directory}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  try {
    for (const file of files) {
      const target = path.join(temporary, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.path === "SKILL.md" ? markdown : file.content);
    }
    fs.writeFileSync(path.join(temporary, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(temporary, directory);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  appendSkillAudit(baseDir, "install", metadata);
  return { ok: true, source: "local_skill_store", skill: metadata };
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
  const catalogResults = SKILL_CATALOG
    .filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(text.toLowerCase()))
    .slice(0, count)
    .map((item) => ({
      type: "catalog",
      id: item.id,
      name: item.name,
      description: item.description,
      sourceUrl: item.sourceUrl,
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

function githubSkill(id, name, description, owner, repo, repositoryPath, ref, files) {
  const repository = `${owner}/${repo}`;
  return {
    id,
    name,
    displayName: name,
    description,
    owner,
    repo,
    repository,
    repositoryPath,
    ref,
    files,
    source: `github:${repository}/${repositoryPath}@${ref}`,
    sourceUrl: `https://github.com/${repository}/tree/${ref}/${repositoryPath}`,
    sourceIdentity: `github:${repository.toLowerCase()}/${repositoryPath.toLowerCase()}`
  };
}

function normalizeGithubSkillSpec(input = {}) {
  const owner = String(input.owner || "").trim();
  const repo = String(input.repo || "").trim();
  const repositoryPath = normalizeBundlePath(input.repositoryPath || input.path || "");
  const ref = String(input.ref || "main").trim();
  const id = requireSkillId(input.id || input.skillId);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw skillError("invalid_skill_repository", "GitHub repository owner or name is invalid.");
  if (!repositoryPath || !ref || /[\r\n]/.test(ref)) throw skillError("invalid_skill_repository", "GitHub Skill path or ref is invalid.");
  const repository = `${owner}/${repo}`;
  return {
    ...input,
    id,
    owner,
    repo,
    repository,
    repositoryPath,
    ref,
    source: `github:${repository}/${repositoryPath}@${ref}`,
    sourceUrl: `https://github.com/${repository}/tree/${encodeURIComponent(ref)}/${repositoryPath}`,
    sourceIdentity: `github:${repository.toLowerCase()}/${repositoryPath.toLowerCase()}`
  };
}

async function fetchGithubJson(fetchText, url, options = {}) {
  const response = await fetchText(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: 160 * 1024,
    signal: options.signal,
    allowHttp: options.allowHttp,
    allowUnsafePrivateNetwork: options.allowUnsafePrivateNetwork
  });
  if (response.truncated) throw skillError("skill_github_response_truncated", "GitHub response exceeded the download limit.");
  try {
    return JSON.parse(response.text);
  } catch {
    throw skillError("skill_github_response_invalid", "GitHub returned invalid JSON while installing the Skill.");
  }
}

async function fetchSkillFileWithRetry(fetchBytes, url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchBytes(url, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function resolveGithubDirectoryInfo(fetchText, spec, options = {}) {
  const parts = spec.repositoryPath.split("/");
  const directoryName = parts.pop();
  const parentPath = parts.join("/");
  const contents = await fetchGithubJson(
    fetchText,
    githubApiUrl(`/repos/${spec.owner}/${spec.repo}/contents/${encodeGithubPath(parentPath)}?ref=${encodeURIComponent(spec.ref)}`),
    options
  );
  if (!Array.isArray(contents)) return contents;
  return contents.find((item) => item.type === "dir" && item.name === directoryName);
}

function githubApiUrl(pathname) {
  return `https://api.github.com${pathname}`;
}

function encodeGithubPath(value) {
  return String(value || "").split("/").map(encodeURIComponent).join("/");
}

function normalizeBundlePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) throw skillError("invalid_skill_file_path", "Skill bundle contains an unsafe file path.");
  return parts.join("/");
}

function validateBundleEntries(blobs) {
  if (!blobs.length) throw skillError("empty_skill_bundle", "GitHub Skill directory is empty.");
  if (blobs.length > MAX_BUNDLE_FILES) throw skillError("skill_bundle_too_many_files", `Skill bundle exceeds ${MAX_BUNDLE_FILES} files.`);
  let declaredBytes = 0;
  const paths = new Set();
  for (const blob of blobs) {
    const relativePath = normalizeBundlePath(blob.path);
    if (paths.has(relativePath.toLowerCase())) throw skillError("duplicate_skill_file", `Skill bundle repeats ${relativePath}.`);
    paths.add(relativePath.toLowerCase());
    const size = Number(blob.size || 0);
    if (!Number.isFinite(size) || size < 0 || size > MAX_BUNDLE_FILE_BYTES) throw skillError("skill_file_too_large", `${relativePath} exceeds the per-file limit.`);
    declaredBytes += size;
  }
  if (declaredBytes > MAX_BUNDLE_BYTES) throw skillError("skill_bundle_too_large", `Skill bundle exceeds ${MAX_BUNDLE_BYTES} bytes.`);
}

function verifyLocalReferences(markdown, files) {
  const references = [...markdown.matchAll(/(?:^|[\s`(])((?:scripts|references|assets|agents)\/[A-Za-z0-9_./-]+)/gm)]
    .map((match) => match[1].replace(/[),.;:'"]+$/g, ""));
  const missing = [...new Set(references)].filter((item) => !files.has(item));
  if (missing.length) throw skillError("skill_bundle_missing_reference", `Skill bundle is missing referenced files: ${missing.slice(0, 5).join(", ")}.`);
}

function hashBundle(files) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
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
      name: String(stored.name || parsed.name),
      description: String(stored.description || parsed.description),
      sourceType: normalizeSourceType(stored.sourceType),
      source: String(stored.source || "").slice(0, 2000),
      sourceUrl: String(stored.sourceUrl || "").slice(0, 4000),
      sourceIdentity: String(stored.sourceIdentity || "").slice(0, 2000),
      repository: String(stored.repository || "").slice(0, 500),
      repositoryPath: String(stored.repositoryPath || "").slice(0, 2000),
      ref: String(stored.ref || "").slice(0, 500),
      revision: String(stored.revision || "").slice(0, 200),
      sha256: actualHash,
      bundleSha256: String(stored.bundleSha256 || ""),
      storedSha256: String(stored.sha256 || ""),
      integrity: actualHash === stored.sha256 ? "verified" : "changed_on_disk",
      bytes: Buffer.byteLength(markdown, "utf8"),
      bundleBytes: Number(stored.bundleBytes || Buffer.byteLength(markdown, "utf8")),
      fileCount: Number(stored.fileCount || 1),
      files: Array.isArray(stored.files) ? stored.files.map((item) => String(item)).slice(0, MAX_BUNDLE_FILES) : ["SKILL.md"],
      licenseFile: String(stored.licenseFile || ""),
      installedAt: String(stored.installedAt || ""),
      updatedAt: String(stored.updatedAt || stored.installedAt || ""),
      executableContent: Boolean(stored.executableContent)
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

function removeLegacyEnabledSkillIds(groupPath, knownIds = new Set()) {
  const ids = readEnabledSkillIds(groupPath);
  const filtered = ids.filter((id) => !LEGACY_PROMPT_SKILL_IDS.has(id) || knownIds.has(id));
  if (groupPath && filtered.length !== ids.length) {
    try {
      const group = readGroup(groupPath);
      writeEnabledSkillIds(groupPath, group, filtered);
    } catch {}
  }
  return filtered;
}

function pruneLegacyPromptSkills(baseDir) {
  const root = skillStoreRoot(baseDir);
  if (!fs.existsSync(root)) return;
  for (const id of LEGACY_PROMPT_SKILL_IDS) {
    const directory = path.join(root, id);
    const metadataPath = path.join(directory, "metadata.json");
    if (!fs.existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.sourceType !== "built_in" || metadata.source !== `built-in:${id}`) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      appendSkillAudit(baseDir, "remove_legacy_prompt_stub", { id, sourceType: "built_in" });
    } catch {}
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
  return ["built_in", "direct_markdown", "remote_url", "github_directory"].includes(source) ? source : "direct_markdown";
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
