import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInsidePath } from "./pathGuards.js";
import { loadPublicEvent, queryPublicEvents } from "./publicEventJournal.js";

const DEFAULT_MAX_BYTES = 128 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function loadGitCommitContext(groupPath, request = {}) {
  const commit = String(request.commit || request.commitHash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw contextError("invalid_commit", "Commit must be a 7 to 40 character hexadecimal Git hash.");
  const matches = queryPublicEvents(groupPath, {
    type: "tool_result",
    tool: "git_operation",
    commit,
    limit: 50
  });
  if (!matches.length) throw contextError("unknown_commit", `No retained public Git event references commit ${commit}.`);
  const selected = selectCommitEvent(groupPath, matches, request.eventId);
  const event = loadPublicEvent(groupPath, selected.id).content;
  const cwd = String(event.payload?.result?.cwd || event.payload?.cwd || ".");
  const repoPath = resolveRepository(groupPath, cwd);
  const fullHash = runGit(repoPath, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  const diff = runGit(repoPath, ["show", "--format=fuller", "--binary", "--no-ext-diff", "--no-renames", fullHash]);
  const buffer = Buffer.from(diff, "utf8");
  const offset = clamp(request.offset || 0, 0, buffer.length);
  const maxBytes = clamp(request.maxBytes || request.max_bytes || DEFAULT_MAX_BYTES, 4096, MAX_PAGE_BYTES);
  const end = Math.min(buffer.length, offset + maxBytes);
  const linkedEvents = queryPublicEvents(groupPath, { sessionId: event.sessionId, limit: 200 })
    .filter((item) => item.sequence >= event.sequence && ["tool_result", "file_operation_result", "final_decision", "session_status"].includes(item.type))
    .map((item) => ({
      eventId: item.id,
      sequence: item.sequence,
      type: item.type,
      occurredAt: item.occurredAt,
      actorId: item.actorId,
      actorName: item.actorName,
      status: item.status,
      tool: item.tool,
      filePaths: item.filePaths,
      sourcePath: item.sourcePath
    }));
  return {
    source: "local_git_commit",
    sourceType: "git_commit_diff",
    eventId: event.id,
    sessionId: event.sessionId,
    commit: fullHash,
    cwd: cwd.replaceAll("\\", "/"),
    sourcePath: `${cwd.replaceAll("\\", "/") || "."}/.git#commit=${fullHash}`,
    offset,
    nextOffset: end,
    totalBytes: buffer.length,
    truncated: end < buffer.length,
    content: buffer.subarray(offset, end).toString("utf8"),
    linkedEvents
  };
}

function selectCommitEvent(groupPath, matches, requestedEventId) {
  if (requestedEventId) {
    const selected = matches.find((item) => item.id === requestedEventId);
    if (!selected) throw contextError("commit_event_mismatch", "The requested event does not reference this commit.");
    return selected;
  }
  const repositories = new Set(matches.map((item) => {
    try {
      const event = loadPublicEvent(groupPath, item.id).content;
      return String(event.payload?.result?.cwd || event.payload?.cwd || ".").replaceAll("\\", "/").toLowerCase();
    } catch {
      return "";
    }
  }).filter(Boolean));
  if (repositories.size > 1) {
    throw contextError("ambiguous_commit", "This commit prefix appears in more than one retained repository. Load the matching event first and pass its eventId with commit.");
  }
  return matches[0];
}

function resolveRepository(groupPath, cwd) {
  const root = fs.realpathSync.native(path.resolve(groupPath));
  const candidate = path.resolve(root, cwd || ".");
  if (!isInsidePath(root, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw contextError("commit_repository_unavailable", "The retained commit repository is no longer available inside the group workspace.");
  }
  const realCandidate = fs.realpathSync.native(candidate);
  if (!isInsidePath(root, realCandidate)) {
    throw contextError("commit_repository_escape", "The retained commit repository resolves outside the group workspace.");
  }
  return realCandidate;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
  if (result.error) throw contextError("git_context_failed", result.error.message);
  if (result.status !== 0) {
    throw contextError("commit_unavailable", String(result.stderr || result.stdout || `git exited with ${result.status}`).trim());
  }
  return String(result.stdout || "");
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? Math.floor(number) : min));
}

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
