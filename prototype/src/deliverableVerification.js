import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias, resolveInside } from "./pathGuards.js";
import { nowIso } from "./types.js";
import { inspectZipArchive, readZipArchiveEntries } from "./archiveTools.js";

const MUTATING_TOOL_NAMES = new Set([
  "execute_command",
  "run_code",
  "install_package",
  "run_tests",
  "git_operation",
  "extract_archive",
  "create_archive"
]);
const INSPECTION_TOOL_NAMES = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "grep_content"
]);
const FORBIDDEN_SEGMENTS = new Set([".git", ".hg", ".svn", ".idea", ".vscode", "node_modules"]);
const INTERNAL_ROOT_SEGMENTS = new Set(["members", "sessions", "approvals"]);
const FORBIDDEN_BASENAMES = new Set([".env", ".npmrc", ".pypirc", "credentials", "credentials.json"]);
const DELIVERABLE_EXTENSIONS = new Set([
  ".exe", ".msi", ".jar", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".whl", ".deb", ".rpm", ".dmg", ".appimage", ".apk", ".aab", ".ipa", ".dll", ".so", ".dylib", ".wasm",
  ".pdf", ".docx", ".pptx", ".xlsx", ".odt", ".ods", ".odp",
  ".json", ".jsonl", ".txt", ".md", ".csv", ".tsv", ".html", ".xml", ".yaml", ".yml", ".toml", ".sql",
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".ps1",
  ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".wav", ".mp3", ".mp4", ".webm"
]);
const DELIVERABLE_EXTENSION_PATTERN = [...DELIVERABLE_EXTENSIONS]
  .map((extension) => extension.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");
const EVIDENCE_TIME_TOLERANCE_MS = 5000;
const MAX_PDF_INSPECTION_BYTES = 64 * 1024 * 1024;

export function normalizeDeliverableClaims(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      path: String(item.path || item.file || item.directory || "").trim(),
      claim: normalizeClaimType(item.claim || item.status || item.kind),
      evidence_ids: normalizeEvidenceIds(item.evidence_ids || item.evidenceIds || item.evidence)
    }))
    .filter((item) => item.path)
    .slice(0, 20);
}

export function verifyFinalDeliverables(options = {}) {
  const groupPath = path.resolve(options.groupPath || "");
  const session = options.session || {};
  const projectRoots = authorizedProjectRoots(session);
  const structured = normalizeDeliverableClaims(session.finalDecision?.deliverables);
  const claims = mergeDeliverableClaims(structured, extractDeliverableClaims(session.finalDecision?.answer));
  if (!claims.length) {
    return {
      status: "not_claimed",
      source: "deterministic_workspace_verification",
      verifiedAt: nowIso(),
      claims: []
    };
  }

  const evidence = collectSessionEvidence(session);
  const verifiedClaims = claims.map((claim, index) => verifyClaim({
    claim,
    index,
    groupPath,
    projectRoots,
    evidence
  }));
  return {
    status: verifiedClaims.every((item) => item.status.startsWith("verified_")) ? "verified" : "needs_revision",
    source: "deterministic_workspace_verification",
    verifiedAt: nowIso(),
    claims: verifiedClaims
  };
}

export function applyDeliverableVerification(session, report) {
  if (!session?.finalDecision || !report || report.status === "not_claimed") return session?.finalDecision;
  const finalDecision = session.finalDecision;
  finalDecision.deliverable_verification = report;
  const unresolved = report.claims.filter((item) => !item.status.startsWith("verified_"));
  finalDecision.answer = appendVerificationBlock(finalDecision.answer, report.claims, unresolved.length > 0);
  if (!unresolved.length) return finalDecision;

  const issues = unresolved.map((item, index) => ({
    id: `deliverable-verification-${index + 1}`,
    issue: deliverableIssue(item),
    severity: "blocker",
    blocks_final: true,
    in_scope: true,
    why: "The final answer claimed a workspace deliverable that current-session evidence did not verify.",
    suggested_fix: "Create or inspect the deliverable with a successful tool call, then cite that evidence id in the final decision.",
    source_agent_id: "system",
    source_agent_name: "Deliverable verifier",
    status: "open"
  }));
  finalDecision.blocking_issues = mergeIssues(finalDecision.blocking_issues, issues);
  finalDecision.risks = mergeText(finalDecision.risks, issues.map((item) => `BLOCKER ${item.id}: ${item.issue}`));
  if (finalDecision.final_state !== "failed_to_converge") finalDecision.final_state = "needs_revision";
  return finalDecision;
}

export function enforceRequestedArtifactRequirements(options = {}) {
  if (!options.session?.finalDecision) return { status: "not_requested", requirements: [] };
  const report = verifyRequestedArtifactProgress(options);
  const failed = report.requirements.filter((item) => item.status !== "verified");
  if (failed.length) {
    const issues = failed.map((item, index) => ({
      id: `requested-artifact-${index + 1}`,
      issue: item.reason,
      severity: "blocker",
      blocks_final: true,
      in_scope: true,
      why: `The user explicitly requested a ${item.extension} artifact, but this run did not verify one.`,
      suggested_fix: `Run the real build, inspect the resulting ${item.extension} file, and keep the successful command evidence in this session.`,
      source_agent_id: "system",
      source_agent_name: "Deliverable verifier",
      status: "open"
    }));
    options.session.finalDecision.final_state = "needs_revision";
    options.session.finalDecision.blocking_issues = mergeIssues(options.session.finalDecision.blocking_issues, issues);
    options.session.finalDecision.risks = mergeText(options.session.finalDecision.risks, issues.map((item) => `BLOCKER ${item.id}: ${item.issue}`));
  }
  options.session.finalDecision.requested_artifact_verification = report;
  return report;
}

export function verifyRequestedArtifactProgress(options = {}) {
  const requested = requestedArtifactRequirements(options.question, options.session);
  if (!requested.length) return { status: "not_requested", source: "explicit_user_artifact_requirement", verifiedAt: nowIso(), requirements: [] };
  const groupPath = path.resolve(options.groupPath || "");
  const evidence = collectSessionEvidence(options.session || {});
  const requirements = requested.map((requirement) => verifyRequestedArtifact(requirement, groupPath, evidence, authorizedProjectRoots(options.session)));
  return {
    status: requirements.every((item) => item.status === "verified") ? "verified" : "needs_revision",
    source: "explicit_user_artifact_requirement",
    verifiedAt: nowIso(),
    requirements
  };
}

export function normalizeRequestedArtifactRequirements(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const requirements = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const extension = normalizeArtifactExtension(item.extension || path.extname(String(item.path || item.file || "")));
    if (!extension || !DELIVERABLE_EXTENSIONS.has(extension)) continue;
    const key = `${extension}:${Boolean(item.requiresImages)}:${Math.max(0, Number(item.minimumPages || 0))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      extension,
      source: "task_contract",
      requiresImages: Boolean(item.requiresImages),
      minimumPages: Math.max(0, Math.floor(Number(item.minimumPages || 0)))
    });
  }
  return requirements.slice(0, 20);
}

function requestedArtifactRequirements(question, session = {}) {
  const contractRequirements = normalizeRequestedArtifactRequirements(session?.taskContract?.artifacts);
  if (contractRequirements.length) return contractRequirements;
  return requestedArtifactExtensions(question).map((extension) => ({
    extension,
    source: "legacy_question_inference",
    requiresImages: extension === ".pdf" && requestRequiresIllustrations(question),
    minimumPages: 0
  }));
}

function requestedArtifactExtensions(question) {
  const text = String(question || "");
  const requested = [...text.matchAll(/(^|[^A-Za-z0-9])((?:\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}))/g)]
    .map((match) => match[2].toLowerCase())
    .filter((extension) => DELIVERABLE_EXTENSIONS.has(extension));
  const formats = [
    [".jar", /\bjar\b|模组包|模組包/i],
    [".exe", /\bexe\b|可执行文件|可執行檔|安装程序|安裝程式/i],
    [".pdf", /\bpdf\b/i],
    [".docx", /\bdocx\b|\bword(?: document)?\b|Word文档|Word文件/i],
    [".xlsx", /\bxlsx\b|\bexcel(?: workbook| spreadsheet)?\b|Excel表格|电子表格|試算表/i],
    [".pptx", /\bpptx\b|\bpowerpoint\b|PPT文件|演示文稿|簡報/i],
    [".json", /\bjson\b/i],
    [".csv", /\bcsv\b/i],
    [".txt", /\btxt\b|纯文本文件|純文字檔/i],
    [".zip", /\bzip\b|压缩包|壓縮檔/i],
    [".py", /\bpython (?:file|script|program)\b|Python脚本|Python程序/i],
    [".java", /\bjava (?:file|source|program)\b|Java源码|Java程序/i],
    [".html", /\bhtml\b|网页文件|網頁檔/i]
  ];
  for (const [extension, pattern] of formats) {
    if (pattern.test(text)) requested.push(extension);
  }
  return [...new Set(requested)];
}

function normalizeArtifactExtension(value) {
  const extension = String(value || "").trim().toLowerCase();
  return extension.startsWith(".") ? extension : extension ? `.${extension}` : "";
}

function requestRequiresIllustrations(question) {
  const text = String(question || "");
  return /\b(?:illustrated|with\s+images?|include\s+images?|image-rich)\b|\u56fe\u6587|\u914d\u56fe|\u56fe\u7247/i.test(text);
}

function verifyRequestedArtifact(requirement, groupPath, evidence, projectRoots = []) {
  const extension = requirement.extension;
  const candidates = evidence
    .filter((item) => item.kind === "tool")
    .flatMap((item) => workspaceArtifactPaths(item.item, projectRoots).map((relativePath) => ({ relativePath, evidenceId: item.id })))
    .filter((item) => item.relativePath.toLowerCase().endsWith(extension));
  for (const candidate of candidates) {
    const resolvablePath = normalizeAuthorizedArtifactPath(candidate.relativePath, projectRoots);
    let absolutePath;
    try {
      absolutePath = resolveDeliverablePath(groupPath, resolvablePath, projectRoots).absolutePath;
    } catch {
      continue;
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile() || fs.statSync(absolutePath).size <= 0) continue;
    const validation = inspectArtifactFormat(extension, absolutePath, requirement);
    if (!validation.ok) continue;
    return {
      extension,
      requirement_source: requirement.source,
      status: "verified",
      path: candidate.relativePath,
      evidence_id: candidate.evidenceId,
      format: validation.format
    };
  }
  return {
    extension,
    requirement_source: requirement.source,
    status: "missing_or_invalid",
    reason: `No valid ${extension} artifact satisfying its structural requirements was produced and observed by a successful command in this run.`
  };
}

function normalizeAuthorizedArtifactPath(value, projectRoots = []) {
  const raw = String(value || "").trim();
  if (!path.isAbsolute(raw)) return raw;
  for (const root of Array.isArray(projectRoots) ? projectRoots : []) {
    try {
      const realRoot = fs.realpathSync.native(root);
      const realTarget = fs.realpathSync.native(raw);
      if (isInsidePath(realRoot, realTarget)) {
        return `project:${path.relative(realRoot, realTarget).replaceAll("\\", "/")}`;
      }
    } catch {}
  }
  return raw;
}

function inspectArtifactFormat(extension, absolutePath, requirement = {}) {
  try {
    if (extension === ".jar") {
      const entries = archiveEntriesByName(absolutePath);
      const manifest = entries.get("meta-inf/manifest.mf");
      const classEntry = [...entries.entries()].find(([name, content]) => name.endsWith(".class") && content.length > 0);
      return formatResult(Boolean(manifest && /(?:^|\r?\n)manifest-version\s*:/i.test(manifest.toString("utf8")) && classEntry), "jar", {
        entryCount: entries.size,
        hasManifest: Boolean(manifest),
        classCount: [...entries.keys()].filter((name) => name.endsWith(".class")).length
      });
    }
    if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
      const entries = archiveEntriesByName(absolutePath);
      const required = extension === ".docx" ? "word/document.xml" : extension === ".xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
      const document = entries.get(required);
      const expectedElement = extension === ".docx" ? /<(?:\w+:)?document\b/i : extension === ".xlsx" ? /<(?:\w+:)?workbook\b/i : /<(?:\w+:)?presentation\b/i;
      return formatResult(Boolean(entries.get("[content_types].xml") && document && expectedElement.test(document.toString("utf8"))), extension.slice(1), {
        entryCount: entries.size,
        requiredPart: required
      });
    }
    if (extension === ".zip" || extension === ".whl") {
      const entries = archiveEntriesByName(absolutePath);
      return formatResult(entries.size > 0, extension.slice(1), { entryCount: entries.size });
    }
    if (extension === ".pdf") return inspectPdfDocument(absolutePath, requirement);
    const head = readHead(absolutePath, 16);
    if (extension === ".png") return formatResult(head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
    if ([".jpg", ".jpeg"].includes(extension)) return formatResult(head[0] === 0xff && head[1] === 0xd8, "jpeg");
    if (extension === ".gif") return formatResult(["GIF87a", "GIF89a"].includes(head.toString("ascii", 0, 6)), "gif");
    if (extension === ".webp") return formatResult(head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP", "webp");
    if ([".json", ".jsonl"].includes(extension)) {
      const content = fs.readFileSync(absolutePath, "utf8");
      if (extension === ".json") JSON.parse(content);
      else {
        const lines = content.split(/\r?\n/).filter(Boolean);
        if (!lines.length) throw new Error("JSONL is empty");
        lines.forEach((line) => JSON.parse(line));
      }
    }
    return formatResult(true, extension.slice(1));
  } catch {
    return formatResult(false, extension.slice(1));
  }
}

function archiveEntriesByName(absolutePath) {
  inspectZipArchive(absolutePath);
  return new Map(readZipArchiveEntries(absolutePath)
    .map((entry) => [String(entry.name || "").toLowerCase(), entry.content]));
}

export function inspectPdfDocument(absolutePath, requirement = {}) {
  try {
    const size = fs.statSync(absolutePath).size;
    if (size > MAX_PDF_INSPECTION_BYTES) return formatResult(false, "pdf", { error: "pdf_too_large_to_inspect" });
    const buffer = fs.readFileSync(absolutePath);
    const text = buffer.toString("latin1");
    const header = /^%PDF-1\.[0-9]/.test(text);
    const eof = text.lastIndexOf("%%EOF");
    const startXref = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1);
    const xrefOffset = Number(startXref?.[1]);
    const validXrefOffset = Number.isInteger(xrefOffset) && xrefOffset > 0 && xrefOffset < buffer.length
      && (/^xref(?:\r?\n|\s)/.test(text.slice(xrefOffset, xrefOffset + 16)) || /^\d+\s+\d+\s+obj\b/.test(text.slice(xrefOffset, xrefOffset + 32)));
    const objects = [...text.matchAll(/(?:^|\s)(\d+\s+\d+)\s+obj\b([\s\S]*?)endobj/g)];
    const objectCount = objects.length;
    const pageCount = (text.match(/\/Type\s*\/Page\b/g) || []).length;
    const imageObjectReferences = objects
      .filter((item) => /\/Subtype\s*\/Image\b/.test(item[2]))
      .map((item) => `${item[1]} R`);
    const imageCount = imageObjectReferences.length;
    const referencedImageCount = imageObjectReferences.filter((reference) => new RegExp(`/XObject\\s*<<[\\s\\S]{0,4096}?${reference.replace(/\\s/g, "\\\\s+")}`).test(text)).length;
    const hasDocumentStructure = /\/Type\s*\/Catalog\b/.test(text) && /\/Type\s*\/Pages\b/.test(text) && pageCount > 0;
    const baseValid = header && eof >= Math.max(0, text.length - 2048) && validXrefOffset && objectCount >= 3 && hasDocumentStructure;
    const pagesValid = !requirement.minimumPages || pageCount >= requirement.minimumPages;
    const imagesValid = !requirement.requiresImages || referencedImageCount > 0;
    return formatResult(baseValid && pagesValid && imagesValid, "pdf", {
      bytes: size,
      objectCount,
      pageCount,
      imageCount,
      referencedImageCount,
      baseValid,
      pagesValid,
      imagesValid,
      requiresImages: Boolean(requirement.requiresImages),
      minimumPages: Number(requirement.minimumPages || 0)
    });
  } catch {
    return formatResult(false, "pdf");
  }
}

function formatResult(ok, format, details = {}) {
  return { ok, format: { type: format, ...details } };
}

function readHead(filePath, bytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function workspaceArtifactPaths(record = {}, projectRoots = []) {
  const changes = record.result?.workspaceChanges || {};
  const changedPaths = [changes.created, changes.modified, changes.observedArtifacts]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .map((item) => String(typeof item === "string" ? item : item?.path || "").trim())
    .filter(Boolean);
  if (INSPECTION_TOOL_NAMES.has(String(record.tool || ""))) {
    const observedPath = String(record.path || record.result?.path || "").trim();
    if (observedPath) changedPaths.push(observedPath);
  }
  if (record.tool === "create_archive" && record.result?.archivePath) changedPaths.push(String(record.result.archivePath));
  if (["execute_command", "run_code", "run_tests"].includes(String(record.tool || ""))) {
    changedPaths.push(...executionOutputArtifactPaths(record, projectRoots));
  }
  return [...new Set(changedPaths)];
}

function executionOutputArtifactPaths(record = {}, projectRoots = []) {
  const output = [record.result?.stdout, record.result?.stderr].filter(Boolean).join("\n");
  const windows = new RegExp(`[A-Za-z]:[\\\\/][^<>"|\\r\\n]*?\\.(?:${DELIVERABLE_EXTENSION_PATTERN})(?=$|[\\s'"),;:\\]}])`, "gi");
  const posix = new RegExp(`(?:^|[\\s'"(=])(/[^<>"|\\r\\n]*?\\.(?:${DELIVERABLE_EXTENSION_PATTERN}))(?=$|[\\s'"),;:\\]}])`, "gim");
  const candidates = [
    ...(output ? [...output.matchAll(windows)].map((match) => match[0]) : []),
    ...(output ? [...output.matchAll(posix)].map((match) => match[1]) : []),
    ...recentAuthorizedRootArtifacts(record, projectRoots)
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return [...new Set(candidates)].filter((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      return stat.isFile() && stat.size > 0 && modifiedDuringEvidenceWindow(stat, record);
    } catch {
      return false;
    }
  });
}

function recentAuthorizedRootArtifacts(record, projectRoots = []) {
  const found = [];
  const stack = (Array.isArray(projectRoots) ? projectRoots : [])
    .map((root) => ({ directory: String(root || "").trim(), depth: 0 }))
    .filter((item) => item.directory);
  let scanned = 0;
  while (stack.length && scanned < 5000 && found.length < 100) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (scanned >= 5000 || found.length >= 100) break;
      scanned += 1;
      const candidate = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 2 && !entry.isSymbolicLink()) stack.push({ directory: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !DELIVERABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.size > 0 && modifiedDuringEvidenceWindow(stat, record)) found.push(candidate);
      } catch {}
    }
  }
  return found;
}

function extractDeliverableClaims(answer) {
  const text = String(answer || "");
  const matches = [...text.matchAll(/(`+)([^`\r\n]{1,260})\1/g)];
  const seen = new Set();
  const claims = [];
  for (const match of matches) {
    const candidate = String(match[2] || "").trim().replace(/^['"]|['"]$/g, "");
    if (!looksLikeWorkspacePath(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const surroundingText = claimSentence(text, Number(match.index || 0), Number(match.index || 0) + match[0].length);
    const claim = completionClaimType(surroundingText);
    if (!claim && !existenceClaim(surroundingText)) continue;
    claims.push({
      path: candidate,
      claim: claim || "existing",
      evidence_ids: []
    });
  }
  return claims.slice(0, 20);
}

function verifyClaim({ claim, index, groupPath, projectRoots = [], evidence }) {
  const base = {
    id: `deliverable-${index + 1}`,
    path: claim.path,
    claim: claim.claim,
    cited_evidence_ids: claim.evidence_ids
  };
  let resolved;
  try {
    resolved = resolveDeliverablePath(groupPath, claim.path, projectRoots);
  } catch (error) {
    return { ...base, status: "invalid_path", reason: error.message };
  }
  if (!fs.existsSync(resolved.absolutePath)) {
    return { ...base, normalized_path: resolved.relativePath, status: "missing", evidence_ids: [] };
  }

  try {
    const realTarget = fs.realpathSync.native(resolved.absolutePath);
    const realRoot = fs.realpathSync.native(resolved.rootPath || groupPath);
    if (!isInsidePath(realRoot, realTarget)) {
      const scope = resolved.scope === "project" ? "retained user-authorized root" : "group workspace";
      return { ...base, normalized_path: resolved.relativePath, status: "invalid_path", reason: `Deliverable path resolves outside the ${scope}.` };
    }
  } catch (error) {
    return { ...base, normalized_path: resolved.relativePath, status: "invalid_path", reason: error.message };
  }

  const stat = fs.statSync(resolved.absolutePath);
  const candidates = claim.evidence_ids.length
    ? evidence.filter((item) => claim.evidence_ids.includes(item.id))
    : evidence;
  const matches = candidates
    .map((item) => matchEvidence(item, resolved, stat))
    .filter(Boolean);
  const buildMatches = matches.filter((item) => item.strength === "build");
  const mutationMatches = matches.filter((item) => ["build", "mutation"].includes(item.strength));
  const inspectionMatches = matches.filter((item) => item.strength === "inspection");
  const facts = fileFacts(resolved.absolutePath, stat);

  if (claim.claim === "built" && buildMatches.length) {
    return {
      ...base,
      normalized_path: resolved.relativePath,
      status: "verified_built",
      evidence_ids: buildMatches.map((item) => item.id),
      evidence_matches: buildMatches,
      ...facts
    };
  }
  if (claim.claim === "created" && mutationMatches.length) {
    return {
      ...base,
      normalized_path: resolved.relativePath,
      status: "verified_created",
      evidence_ids: mutationMatches.map((item) => item.id),
      evidence_matches: mutationMatches,
      ...facts
    };
  }
  if (claim.claim === "existing" && (mutationMatches.length || inspectionMatches.length)) {
    const accepted = [...mutationMatches, ...inspectionMatches];
    return {
      ...base,
      normalized_path: resolved.relativePath,
      status: "verified_existing",
      evidence_ids: accepted.map((item) => item.id),
      evidence_matches: accepted,
      ...facts
    };
  }
  return {
    ...base,
    normalized_path: resolved.relativePath,
    status: "exists_unverified",
    evidence_ids: matches.map((item) => item.id),
    evidence_matches: matches,
    reason: claim.claim === "built"
      ? "The path exists, but no successful current-session build command proves it was built in this session."
      : claim.claim === "created"
        ? "The path exists, but no successful current-session mutation evidence proves it was created in this session."
        : "The path exists, but no successful current-session evidence inspected or created it.",
    ...facts
  };
}

function collectSessionEvidence(session) {
  const tools = (session.toolExecutionResults || []).map((item) => ({
    id: String(item.id || ""),
    kind: "tool",
    tool: String(item.tool || ""),
    status: String(item.status || ""),
    item
  }));
  const fileOperations = (session.fileOperationExecutionResults || []).map((item) => ({
    id: String(item.proposalId || item.id || ""),
    kind: "file_operation",
    tool: String(item.op || item.operation || item.action || ""),
    status: String(item.status || ""),
    item
  }));
  return [...tools, ...fileOperations].filter((item) => item.id && evidenceSucceeded(item));
}

function evidenceSucceeded(evidence) {
  if (evidence.kind === "file_operation") return ["executed", "completed"].includes(evidence.status);
  if (evidence.status !== "completed" || evidence.item.result?.ok === false) return false;
  if (evidence.item.result?.timedOut || evidence.item.background || evidence.item.result?.background) return false;
  return true;
}

function matchEvidence(evidence, resolved, stat) {
  if (evidence.kind === "file_operation") {
    const evidencePath = normalizeEvidencePath(evidence.item.path || evidence.item.targetPath);
    if (evidencePath && evidencePath === normalizedPathKey(resolved.relativePath)) {
      const mutation = ["write", "append", "delete"].includes(evidence.tool) && evidence.status === "executed";
      return { id: evidence.id, kind: evidence.kind, tool: evidence.tool, strength: mutation ? "mutation" : "inspection", match: "exact_path" };
    }
    return null;
  }

  const item = evidence.item;
  if (INSPECTION_TOOL_NAMES.has(evidence.tool)) {
    const direct = inspectionPathMatch(item, resolved);
    if (direct) return { id: evidence.id, kind: evidence.kind, tool: evidence.tool, strength: "inspection", match: direct };
  }
  const workspaceChangeMatch = exactWorkspaceChangeMatch(item.result?.workspaceChanges, resolved.relativePath);
  if (MUTATING_TOOL_NAMES.has(evidence.tool) && workspaceChangeMatch) {
    return {
      id: evidence.id,
      kind: evidence.kind,
      tool: evidence.tool,
      strength: buildEvidence(item) ? "build" : "mutation",
      match: workspaceChangeMatch
    };
  }
  if (buildEvidence(item) && exactObservedArtifactMatch(item, resolved.relativePath)) {
    return {
      id: evidence.id,
      kind: evidence.kind,
      tool: evidence.tool,
      strength: "build",
      match: "workspace_observed_after_successful_build"
    };
  }
  if (resolved.scope === "project"
    && MUTATING_TOOL_NAMES.has(evidence.tool)
    && exactAuthorizedArtifactEvidenceMatch(item, resolved)) {
    return {
      id: evidence.id,
      kind: evidence.kind,
      tool: evidence.tool,
      strength: buildEvidence(item) ? "build" : "mutation",
      match: "authorized_external_artifact_observed_after_successful_execution"
    };
  }
  if (MUTATING_TOOL_NAMES.has(evidence.tool)
    && !hasWorkspaceChangeManifest(item.result)
    && modifiedDuringEvidenceWindow(stat, item)) {
    return {
      id: evidence.id,
      kind: evidence.kind,
      tool: evidence.tool,
      strength: buildEvidence(item) ? "build" : "mutation",
      match: "legacy_modified_during_successful_execution"
    };
  }
  return null;
}

function exactWorkspaceChangeMatch(workspaceChanges, relativePath) {
  if (!workspaceChanges || workspaceChanges.status !== "completed") return "";
  const claimKey = normalizedPathKey(relativePath);
  for (const change of [...(workspaceChanges.created || []), ...(workspaceChanges.modified || [])]) {
    if (change?.reliable === false) continue;
    if (normalizedPathKey(change?.path) !== claimKey) continue;
    return `workspace_change_${change.change || "observed"}`;
  }
  return "";
}

function hasWorkspaceChangeManifest(result) {
  return Boolean(result && Object.hasOwn(result, "workspaceChanges"));
}

function exactObservedArtifactMatch(item, relativePath) {
  const workspaceChanges = item?.result?.workspaceChanges;
  if (!workspaceChanges || workspaceChanges.status !== "completed") return false;
  const claimKey = normalizedPathKey(relativePath);
  const cwdKey = normalizedPathKey(item?.result?.cwd || item?.cwd || ".");
  if (cwdKey && cwdKey !== "." && claimKey !== cwdKey && !claimKey.startsWith(`${cwdKey}/`)) return false;
  return (workspaceChanges.observedArtifacts || []).some((item) => (
    item?.reliable !== false && normalizedPathKey(item?.path) === claimKey
  ));
}

function exactAuthorizedArtifactEvidenceMatch(item, resolved) {
  if (!resolved.rootPath || !["execute_command", "run_code", "run_tests"].includes(String(item.tool || ""))) return false;
  let realTarget;
  try { realTarget = fs.realpathSync.native(resolved.absolutePath); } catch { return false; }
  return executionOutputArtifactPaths(item, [resolved.rootPath]).some((candidate) => {
    try {
      return fs.realpathSync.native(candidate) === realTarget;
    } catch {
      return false;
    }
  });
}

function inspectionPathMatch(item, resolved) {
  const claimKey = normalizedPathKey(resolved.relativePath);
  const requestPath = normalizeEvidencePath(item.path || item.result?.path);
  if (item.tool === "read_file" && requestPath === claimKey) return "exact_path";
  if (item.tool === "list_directory") {
    const parentKey = normalizedPathKey(path.posix.dirname(resolved.relativePath.replaceAll("\\", "/")));
    if (requestPath === claimKey) return "exact_directory";
    if (requestPath === parentKey && listingContains(item.result?.entries, path.basename(resolved.relativePath))) return "parent_listing";
  }
  if (["search_files", "grep_content"].includes(item.tool) && resultContainsPath(item.result, claimKey)) return "search_result";
  return "";
}

function modifiedDuringEvidenceWindow(stat, item) {
  const completedAt = Date.parse(item.createdAt || "");
  if (!Number.isFinite(completedAt)) return false;
  const durationMs = Math.max(0, Number(item.result?.durationMs || item.durationMs || 0));
  const start = completedAt - durationMs - EVIDENCE_TIME_TOLERANCE_MS;
  const end = completedAt + EVIDENCE_TIME_TOLERANCE_MS;
  return stat.mtimeMs >= start && stat.mtimeMs <= end;
}

function resolveDeliverablePath(groupPath, value, projectRoots = []) {
  const raw = String(value || "").trim();
  if (path.isAbsolute(raw)) {
    const normalized = normalizeAuthorizedArtifactPath(raw, projectRoots);
    if (normalized !== raw) return resolveDeliverablePath(groupPath, normalized, projectRoots);
    throw new Error("Deliverable absolute path is outside retained user-authorized roots.");
  }
  if (raw.toLowerCase().startsWith("project:")) {
    const relative = raw.slice("project:".length).replace(/^[/\\]+/, "");
    for (const root of projectRoots) {
      try {
        const realRoot = fs.realpathSync.native(root);
        const candidate = path.resolve(realRoot, relative);
        if (!isInsidePath(realRoot, candidate)) continue;
        if (!fs.existsSync(candidate)) continue;
        const realTarget = fs.realpathSync.native(candidate);
        if (!isInsidePath(realRoot, realTarget)) continue;
        assertSafeDeliverablePath(relative.replaceAll("\\", "/"));
        return { absolutePath: candidate, relativePath: `project:${relative.replaceAll("\\", "/")}`, scope: "project", rootPath: realRoot };
      } catch {}
    }
    throw new Error("Deliverable project path is outside retained user-authorized roots or does not exist.");
  }
  const alias = normalizeWorkspacePathAlias(value, { name: "deliverable path" });
  const absolutePath = resolveInside(groupPath, alias.path, { name: "deliverable path" });
  const relativePath = path.relative(groupPath, absolutePath).replaceAll("\\", "/") || ".";
  assertSafeDeliverablePath(relativePath);
  return { absolutePath, relativePath, scope: "workspace", rootPath: groupPath };
}

function authorizedProjectRoots(session = {}) {
  return [...new Set((Array.isArray(session.authorizedProjectRoots) ? session.authorizedProjectRoots : [])
    .map((root) => String(root || "").trim())
    .filter((root) => root && fs.existsSync(root) && fs.statSync(root).isDirectory()))];
}

function assertSafeDeliverablePath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part.toLowerCase())) throw new Error(`Forbidden deliverable path segment: ${part}`);
  }
  if (INTERNAL_ROOT_SEGMENTS.has(parts[0]?.toLowerCase())) {
    throw new Error(`Internal workspace data cannot be declared as a deliverable: ${parts[0]}`);
  }
  const basename = String(parts.at(-1) || "").toLowerCase();
  if (FORBIDDEN_BASENAMES.has(basename)
    || basename.startsWith(".env.")
    || basename.startsWith("credentials.")
    || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "group.json"].includes(basename)
    || [".pem", ".key", ".p12", ".pfx"].includes(path.extname(basename))) {
    throw new Error("Secret or credential files cannot be declared as deliverables.");
  }
  if (parts[0]?.toLowerCase() === "shared" && ["logs", "memory", "memory_pending", "inbox", "file-ops"].includes(parts[1]?.toLowerCase())) {
    throw new Error("Internal shared data cannot be declared as a deliverable.");
  }
}

function fileFacts(absolutePath, stat) {
  if (stat.isFile()) {
    return {
      type: "file",
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      sha256: sha256File(absolutePath)
    };
  }
  if (stat.isDirectory()) {
    return {
      type: "directory",
      entry_count: safeDirectoryCount(absolutePath),
      modified_at: stat.mtime.toISOString()
    };
  }
  return { type: "other", modified_at: stat.mtime.toISOString() };
}

function appendVerificationBlock(answer, claims, failed) {
  const text = String(answer || "").trim();
  if (!claims.length || text.includes("文件核验（软件自动检查）：")) return text;
  const lines = claims.map((item) => {
    const facts = [
      item.type,
      Number.isFinite(item.size_bytes) ? `${item.size_bytes} bytes` : "",
      item.sha256 ? `文件指纹(SHA-256)=${item.sha256}` : "",
      item.evidence_ids?.length ? `evidence=${item.evidence_ids.join(",")}` : ""
    ].filter(Boolean).join("; ");
    return `- ${item.normalized_path || item.path}: ${userFacingStatus(item.status)}${facts ? `; ${facts}` : ""}`;
  });
  const prefix = failed ? "软件核验未通过：以下总结中的交付物完成说法不能视为已证实。\n\n" : "";
  return `${prefix}${text}\n\n文件核验（软件自动检查）：\n${lines.join("\n")}`;
}

function deliverableIssue(item) {
  if (item.status === "missing") return `Claimed deliverable is missing: ${item.normalized_path || item.path}`;
  if (item.status === "invalid_path") return `Claimed deliverable path is invalid: ${item.path}`;
  return `Claimed deliverable exists but is not verified by successful current-session evidence: ${item.normalized_path || item.path}`;
}

function completionClaimType(text) {
  const value = String(text || "");
  if (/\b(?:built|compiled|packaged|exported)\b|\b(?:build|compile|package|export)(?:\s+(?:completed|succeeded|successful|successfully))\b|(?:构建|编译|打包|导出)(?:成功|完成|为|于|到|成)?/i.test(value)) return "built";
  if (/\b(?:created|generated|produced)\b|\b(?:create|generate|produce)(?:\s+(?:completed|succeeded|successful|successfully))\b|(?:创建|生成)(?:成功|完成|为|于|到|成)?/i.test(value)) return "created";
  return "";
}

function claimSentence(text, start, end) {
  const before = String(text || "").slice(0, start);
  const after = String(text || "").slice(end);
  const previousBoundary = Math.max(
    before.lastIndexOf("\n"),
    before.lastIndexOf("。"),
    before.lastIndexOf("！"),
    before.lastIndexOf("？"),
    before.lastIndexOf(". "),
    before.lastIndexOf("! "),
    before.lastIndexOf("? ")
  );
  const nextBoundaryCandidates = ["\n", "。", "！", "？", ". ", "! ", "? "]
    .map((marker) => after.indexOf(marker))
    .filter((index) => index >= 0);
  const nextBoundary = nextBoundaryCandidates.length ? Math.min(...nextBoundaryCandidates) : after.length;
  return `${before.slice(previousBoundary + 1)} ${String(text || "").slice(start, end)} ${after.slice(0, nextBoundary)}`;
}

function existenceClaim(text) {
  return /\b(?:exists?|available|located|saved|found|artifact|deliverable|output)\b|(?:存在|可用|位于|保存于|保存到|文件在|产物|交付物|输出文件)/i.test(String(text || ""));
}

function looksLikeWorkspacePath(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("://")) return false;
  if (/[|><;\r\n]/.test(text) || /^\s*(?:npm|pnpm|yarn|git|gradle|mvn|python|node)\s/i.test(text)) return false;
  const basename = text.replaceAll("\\", "/").split("/").at(-1) || "";
  if (/[\\/]/.test(text)) return /\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(basename) || /[\\/]$/.test(text);
  return DELIVERABLE_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

function normalizeClaimType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["built", "compiled", "packaged", "exported"].includes(text)) return "built";
  if (["created", "generated", "produced"].includes(text)) return "created";
  return "existing";
}

function normalizeEvidenceIds(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20);
}

function normalizeEvidencePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const alias = normalizeWorkspacePathAlias(text, { name: "evidence path" });
    if (!alias.aliased && path.isAbsolute(alias.path)) return "";
    return normalizedPathKey(alias.path);
  } catch {
    return "";
  }
}

function normalizedPathKey(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/")).replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function listingContains(entries, basename) {
  const target = process.platform === "win32" ? basename.toLowerCase() : basename;
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const name = String(entry?.name || entry?.path || entry || "");
    return (process.platform === "win32" ? name.toLowerCase() : name) === target;
  });
}

function resultContainsPath(result, claimKey) {
  const stack = [result];
  let inspected = 0;
  while (stack.length && inspected < 500) {
    const value = stack.pop();
    inspected += 1;
    if (typeof value === "string" && normalizeEvidencePath(value) === claimKey) return true;
    if (Array.isArray(value)) stack.push(...value.slice(0, 100));
    else if (value && typeof value === "object") stack.push(...Object.values(value).slice(0, 100));
  }
  return false;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function userFacingStatus(status) {
  if (status === "verified_built") return "已验证为本轮构建";
  if (status === "verified_created") return "已验证为本轮创建";
  if (status === "verified_existing") return "已验证存在";
  if (status === "exists_unverified") return "文件存在，但本轮没有成功操作证明它是这次完成的";
  if (status === "missing") return "文件不存在";
  return "路径无效";
}

function mergeDeliverableClaims(structured, extracted) {
  const byPath = new Map();
  for (const item of [...structured, ...extracted]) {
    const key = normalizedPathKey(item.path);
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, { ...item, evidence_ids: [...item.evidence_ids] });
      continue;
    }
    byPath.set(key, {
      ...previous,
      claim: strongerClaim(previous.claim, item.claim),
      evidence_ids: [...new Set([...previous.evidence_ids, ...item.evidence_ids])]
    });
  }
  return [...byPath.values()].slice(0, 20);
}

function strongerClaim(a, b) {
  const rank = { existing: 1, created: 2, built: 3 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

function buildEvidence(item) {
  if (item.tool !== "execute_command") return false;
  const command = String(item.command || item.result?.command || "").toLowerCase();
  return /(?:^|\s|[\\/])(?:gradle|gradlew)(?:\.bat|\.cmd|\.exe)?\b[^\r\n]*(?:build|assemble|jar|publish|release)\b|(?:^|\s|[\\/])(?:mvn|mvnw)(?:\.bat|\.cmd|\.exe)?\b[^\r\n]*(?:package|install|deploy)\b|\bcargo\s+(?:build|install|publish)\b|\brustc\b[^\r\n]*\s-o\s|\bgo\s+(?:build|install)\b|\b(?:make|ninja)\b(?:\s+(?:all|build|package|install|release))?|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|package|dist|release)\b|\bdotnet\s+(?:build|publish|pack)\b|\bcmake\s+--build\b|\b(?:python|python3|py)(?:\.exe)?\s+-m\s+build\b|\b(?:python|python3|py)(?:\.exe)?\s+[^\r\n]*setup\.py\s+(?:bdist\w*|sdist)\b|\bpip\s+wheel\b|\bjar\s+(?:c|--create)\b|\b(?:gcc|g\+\+|clang|clang\+\+|cl)(?:\.exe)?\b[^\r\n]*\s(?:-o|\/fe)\s*\S+|\b(?:zip|tar)\b[^\r\n]*(?:-c|--create)|\bcompress-archive\b|\b(?:pyinstaller|electron-builder)\b/i.test(command);
}

function safeDirectoryCount(directoryPath) {
  try {
    return fs.readdirSync(directoryPath).length;
  } catch {
    return undefined;
  }
}

function mergeIssues(existing = [], added = []) {
  const byId = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.id, item]));
  for (const item of added) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeText(existing = [], added = []) {
  const seen = new Set();
  return [...(Array.isArray(existing) ? existing : []), ...added].filter((item) => {
    const text = String(item || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
