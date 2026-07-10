import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInsidePath, normalizeWorkspacePathAlias, resolveInside } from "./pathGuards.js";
import { nowIso } from "./types.js";

const MUTATING_TOOL_NAMES = new Set([
  "execute_command",
  "run_code",
  "install_package",
  "run_tests",
  "git_operation",
  "extract_archive"
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
const DELIVERABLE_EXTENSIONS = new Set([".exe", ".msi", ".jar", ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".whl", ".deb", ".rpm", ".dmg", ".appimage", ".apk", ".aab", ".ipa", ".dll", ".so", ".dylib", ".wasm", ".pdf", ".docx", ".pptx", ".xlsx"]);
const EVIDENCE_TIME_TOLERANCE_MS = 5000;

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

function verifyClaim({ claim, index, groupPath, evidence }) {
  const base = {
    id: `deliverable-${index + 1}`,
    path: claim.path,
    claim: claim.claim,
    cited_evidence_ids: claim.evidence_ids
  };
  let resolved;
  try {
    resolved = resolveDeliverablePath(groupPath, claim.path);
  } catch (error) {
    return { ...base, status: "invalid_path", reason: error.message };
  }
  if (!fs.existsSync(resolved.absolutePath)) {
    return { ...base, normalized_path: resolved.relativePath, status: "missing", evidence_ids: [] };
  }

  try {
    const realGroup = fs.realpathSync.native(groupPath);
    const realTarget = fs.realpathSync.native(resolved.absolutePath);
    if (!isInsidePath(realGroup, realTarget)) {
      return { ...base, normalized_path: resolved.relativePath, status: "invalid_path", reason: "Deliverable path resolves outside the group workspace." };
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

function resolveDeliverablePath(groupPath, value) {
  const alias = normalizeWorkspacePathAlias(value, { name: "deliverable path" });
  if (!alias.aliased && path.isAbsolute(alias.path)) throw new Error("Deliverable path must be relative to the group workspace.");
  const absolutePath = resolveInside(groupPath, alias.path, { name: "deliverable path" });
  const relativePath = path.relative(groupPath, absolutePath).replaceAll("\\", "/") || ".";
  assertSafeDeliverablePath(relativePath);
  return { absolutePath, relativePath };
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
