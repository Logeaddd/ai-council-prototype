import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";

export function createRecorderDraft(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const recorderSeatId = requireOption(options.recorderSeatId, "recorderSeatId");
  const content = requireOption(options.content, "content");
  const target = options.target || "approved";
  const reviewerSeatIds = options.reviewerSeatIds ?? [];
  const group = readGroup(groupPath);
  const recorder = findSeat(group, recorderSeatId);
  const reviewers = reviewerSeatIds.map((seatId) => findSeat(group, seatId));
  const draftId = makeId("draft");
  const draft = {
    id: draftId,
    status: reviewerSeatIds.length ? "pending_review" : "pending_user_final_approval",
    target,
    content,
    recorderSeatId,
    recorderName: recorder.displayName,
    reviewerSeatIds,
    reviewerNames: reviewers.map((reviewer) => reviewer.displayName),
    createdAt: nowIso(),
    reviews: []
  };

  const draftPath = path.join(groupPath, "shared", "drafts", `${draftId}.json`);
  writeJson(draftPath, draft);
  appendLog(groupPath, `Recorder draft created: ${draftId} by ${recorderSeatId}; reviewers=${reviewerSeatIds.join(",") || "none"}`);
  return { draft, draftPath };
}

export function addReview(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const draftId = requireOption(options.draftId, "draftId");
  const reviewerSeatId = requireOption(options.reviewerSeatId, "reviewerSeatId");
  const verdict = requireOption(options.verdict, "verdict");
  const comment = options.comment || "";
  const draftPath = draftFile(groupPath, draftId);
  const draft = readJson(draftPath);
  const group = readGroup(groupPath);
  const reviewer = findSeat(group, reviewerSeatId);
  if (!draft.reviewerSeatIds.includes(reviewerSeatId)) {
    throw new Error(`Reviewer ${reviewerSeatId} is not assigned to draft ${draftId}`);
  }

  const review = {
    reviewerSeatId,
    reviewerName: reviewer.displayName,
    verdict,
    comment,
    createdAt: nowIso()
  };
  draft.reviews = draft.reviews.filter((item) => item.reviewerSeatId !== reviewerSeatId);
  draft.reviews.push(review);
  draft.status = nextReviewStatus(draft);
  writeJson(draftPath, draft);

  const reviewPath = path.join(groupPath, "approvals", `${draftId}.${reviewerSeatId}.review.json`);
  writeJson(reviewPath, review);
  appendLog(groupPath, `Review added: ${draftId} by ${reviewerSeatId}; verdict=${verdict}`);
  return { draft, review, reviewPath };
}

export function finalizeDraft(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const draftId = requireOption(options.draftId, "draftId");
  const approvedBy = requireOption(options.approvedBy, "approvedBy");
  const draftPath = draftFile(groupPath, draftId);
  const draft = readJson(draftPath);
  if (draft.status !== "pending_user_final_approval") {
    throw new Error(`Draft ${draftId} is not ready for final approval`);
  }

  draft.status = "approved";
  draft.approvedBy = approvedBy;
  draft.approvedAt = nowIso();
  const targetDir = draft.target === "memory_pending"
    ? path.join(groupPath, "shared", "memory_pending")
    : path.join(groupPath, "shared", "approved");
  fs.mkdirSync(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, `${draftId}.json`);
  writeJson(finalPath, draft);
  fs.rmSync(draftPath);
  appendLog(groupPath, `Draft approved: ${draftId} by ${approvedBy}; target=${draft.target}`);
  return { draft, finalPath };
}

export function listDrafts(groupPath, options = {}) {
  const draftsDir = path.join(path.resolve(groupPath), "shared", "drafts");
  if (!fs.existsSync(draftsDir)) return [];
  const drafts = fs.readdirSync(draftsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(draftsDir, file)));
  return options.status ? drafts.filter((draft) => draft.status === options.status) : drafts;
}

export function listApproved(groupPath, options = {}) {
  const target = options.target === "memory_pending" ? "memory_pending" : "approved";
  const dir = path.join(path.resolve(groupPath), "shared", target);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(dir, file)));
}

function allReviewsComplete(draft) {
  const reviewed = new Set(draft.reviews.map((review) => review.reviewerSeatId));
  return draft.reviewerSeatIds.every((seatId) => reviewed.has(seatId));
}

function nextReviewStatus(draft) {
  if (draft.reviews.some((review) => review.verdict === "reject")) return "changes_requested";
  return allReviewsComplete(draft) ? "pending_user_final_approval" : "pending_review";
}

function readGroup(groupPath) {
  return readJson(path.join(groupPath, "group.json"));
}

function findSeat(group, seatId) {
  const seat = group.seats.find((item) => item.seatId === seatId);
  if (!seat) throw new Error(`Unknown seatId: ${seatId}`);
  return seat;
}

function draftFile(groupPath, draftId) {
  return path.join(groupPath, "shared", "drafts", `${draftId}.json`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function appendLog(groupPath, line) {
  const logPath = path.join(groupPath, "shared", "logs", "workspace.log");
  fs.appendFileSync(logPath, `${nowIso()} ${line}\n`, "utf8");
}

function requireOption(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
