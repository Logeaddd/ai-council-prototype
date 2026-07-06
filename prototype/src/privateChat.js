import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./types.js";

const MAX_PRIVATE_MESSAGES = 50;

export function appendPrivateChatMessage(groupPath, seatId, text, options = {}) {
  const seat = findSeat(groupPath, seatId, options);
  const content = String(text || "").trim();
  if (!content) throw new Error("Private message cannot be empty.");
  const record = {
    id: makeId("pm"),
    seatId: canonicalSeatId(seat),
    seatName: seat.displayName || canonicalSeatId(seat),
    from: options.from || "boss",
    audience: canonicalSeatId(seat),
    text: content,
    ...(options.status ? { status: String(options.status) } : {}),
    createdAt: nowIso()
  };
  fs.mkdirSync(privateInboxDir(groupPath, seat), { recursive: true });
  fs.appendFileSync(privateChatFile(groupPath, seat), `${JSON.stringify(record)}\n`, "utf8");
  appendSharedHint(groupPath, record);
  return record;
}

export function readPrivateChatMessages(groupPath, seatId, options = {}) {
  const seat = findSeat(groupPath, seatId, options);
  const limit = Math.max(1, Number(options.limit || MAX_PRIVATE_MESSAGES));
  return readJsonl(privateChatFile(groupPath, seat)).slice(-limit).reverse();
}

export function readPrivateContextMessages(groupPath, seatId, options = {}) {
  return readPrivateChatMessages(groupPath, seatId, options).slice().reverse();
}

function appendSharedHint(groupPath, record) {
  const logDir = path.join(groupPath, "shared", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "private-chat.jsonl"), `${JSON.stringify({
    id: record.id,
    seatId: record.seatId,
    seatName: record.seatName,
    audience: record.audience,
    createdAt: record.createdAt,
    event: "private_message_sent"
  })}\n`, "utf8");
}

function findSeat(groupPath, seatId, options = {}) {
  const groupFile = path.join(groupPath, "group.json");
  const group = JSON.parse(fs.readFileSync(groupFile, "utf8"));
  const normalizedId = String(seatId || "");
  const seat = (group.seats || []).find((item) => item.seatId === normalizedId || item.id === normalizedId || item.displayName === normalizedId);
  const resolved = seat || fallbackSeatFromOptions(groupPath, normalizedId, options.seat);
  if (!resolved) throw new Error(`Unknown seatId: ${seatId}`);
  if (!resolved.privateFolder) throw new Error(`Seat ${seatId} has no private folder.`);
  ensurePrivateSeatDirs(groupPath, resolved);
  return resolved;
}

function canonicalSeatId(seat) {
  return seat.seatId || seat.id || seat.displayName || "";
}

function fallbackSeatFromOptions(groupPath, seatId, seat = {}) {
  const candidateId = String(seat.seatId || seat.id || seatId || "").trim();
  if (!candidateId || candidateId !== seatId) return null;
  const displayName = String(seat.displayName || seat.role || candidateId).trim();
  const folderName = sanitizeSegment(displayName && displayName !== candidateId ? `${displayName}-${candidateId}` : candidateId);
  return {
    seatId: candidateId,
    displayName: displayName || candidateId,
    role: String(seat.role || ""),
    privateFolder: path.relative(groupPath, path.join(groupPath, "members", folderName)).replaceAll("\\", "/")
  };
}

function ensurePrivateSeatDirs(groupPath, seat) {
  const dir = privateInboxDir(groupPath, seat);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(path.dirname(dir), "notes"), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(dir), "drafts"), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(dir), "private_memory"), { recursive: true });
}

function sanitizeSegment(value) {
  return String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_") || "member";
}

function privateChatFile(groupPath, seat) {
  return path.join(privateInboxDir(groupPath, seat), "private-chat.jsonl");
}

function privateInboxDir(groupPath, seat) {
  const folder = path.resolve(groupPath, seat.privateFolder || "");
  const root = path.resolve(groupPath);
  if (folder !== root && !folder.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Private folder escapes group workspace: ${seat.privateFolder}`);
  }
  return path.join(folder, "inbox");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
