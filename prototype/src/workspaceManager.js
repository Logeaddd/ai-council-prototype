import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./types.js";

export function initGroupWorkspace(options) {
  const root = requireOption(options.root, "root");
  const groupFolderName = requireOption(options.groupFolderName, "groupFolderName");
  const members = options.members ?? [];
  const groupPath = path.resolve(root, sanitizeSegment(groupFolderName));

  createDirs([
    groupPath,
    path.join(groupPath, "shared", "inbox"),
    path.join(groupPath, "shared", "drafts"),
    path.join(groupPath, "shared", "approved"),
    path.join(groupPath, "shared", "harness"),
    path.join(groupPath, "shared", "memory_pending"),
    path.join(groupPath, "shared", "logs"),
    path.join(groupPath, "members"),
    path.join(groupPath, "sessions"),
    path.join(groupPath, "approvals")
  ]);

  const seats = members.map((member, index) => {
    const seatId = member.seatId || `seat_${String(index + 1).padStart(2, "0")}`;
    const displayName = member.displayName || member.model || seatId;
    const folderName = uniqueSegment(
      groupPath,
      "members",
      member.folderName || displayName || seatId
    );
    const privateFolder = path.join(groupPath, "members", folderName);
    createMemberDirs(privateFolder);
    writeText(path.join(privateFolder, "handoff.md"), initialHandoff(displayName));
    return {
      seatId,
      displayName,
      currentModel: member.model || displayName,
      privateFolder: path.relative(groupPath, privateFolder).replaceAll("\\", "/"),
      role: member.role || "",
      team: member.team || "",
      weight: member.weight ?? 1,
      enabled: member.enabled ?? true,
      reviewer: Boolean(member.reviewer),
      mandatoryRedTeam: Boolean(member.mandatoryRedTeam || member.reviewer),
      judge: Boolean(member.judge),
      providerPreset: member.providerPreset || "",
      apiBaseUrl: member.apiBaseUrl || member.apiUrl || "",
      apiUrl: member.apiUrl || member.apiBaseUrl || "",
      apiKey: member.apiKey || "",
      reasoningEffort: normalizeReasoningEffort(member.reasoningEffort)
    };
  });

  const group = {
    groupFolderName,
    groupPath,
    createdAt: nowIso(),
    seats
  };

  writeJson(path.join(groupPath, "group.json"), group);
  appendLog(groupPath, `Created group workspace: ${groupFolderName}`);
  return group;
}

export function replaceMember(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const seatId = requireOption(options.seatId, "seatId");
  const nextDisplayName = requireOption(options.nextDisplayName, "nextDisplayName");
  const groupFile = path.join(groupPath, "group.json");
  const group = JSON.parse(fs.readFileSync(groupFile, "utf8"));
  const seat = group.seats.find((item) => item.seatId === seatId);
  if (!seat) throw new Error(`Unknown seatId: ${seatId}`);

  const previous = {
    displayName: seat.displayName,
    currentModel: seat.currentModel,
    privateFolder: seat.privateFolder
  };

  if (options.newPrivateFolder) {
    const folderName = uniqueSegment(
      groupPath,
      "members",
      options.folderName || nextDisplayName
    );
    const privateFolder = path.join(groupPath, "members", folderName);
    createMemberDirs(privateFolder);
    writeText(path.join(privateFolder, "handoff.md"), initialHandoff(nextDisplayName));
    seat.privateFolder = path.relative(groupPath, privateFolder).replaceAll("\\", "/");
  }

  seat.displayName = nextDisplayName;
  seat.currentModel = options.nextModel || nextDisplayName;
  seat.replacedAt = nowIso();
  seat.previous = previous;

  writeJson(groupFile, group);
  appendLog(groupPath, `Replaced ${seatId}: ${previous.displayName} -> ${nextDisplayName}; privateFolder=${seat.privateFolder}`);
  return { group, seat, previous };
}

export function addMember(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const groupFile = path.join(groupPath, "group.json");
  const group = JSON.parse(fs.readFileSync(groupFile, "utf8"));
  const seats = group.seats || group.agents || [];
  const seatId = options.seatId || nextSeatId(seats);
  if (seats.some((item) => (item.seatId || item.id) === seatId)) {
    throw new Error(`Seat already exists: ${seatId}`);
  }
  const displayName = String(options.displayName || options.name || `成员 ${seats.length + 1}`).trim();
  const role = normalizeSeatRole(options.role);
  const reviewer = role === "reviewer" || Boolean(options.reviewer);
  const judge = role === "summarizer" || Boolean(options.judge);
  const folderName = uniqueSegment(
    groupPath,
    "members",
    options.folderName || displayName || seatId
  );
  const privateFolder = path.join(groupPath, "members", folderName);
  createMemberDirs(privateFolder);
  writeText(path.join(privateFolder, "handoff.md"), initialHandoff(displayName));

  const seat = {
    seatId,
    displayName,
    currentModel: options.model || displayName,
    model: options.model || displayName,
    privateFolder: path.relative(groupPath, privateFolder).replaceAll("\\", "/"),
    role,
    team: options.team || "",
    weight: options.weight ?? 1,
    enabled: options.enabled ?? true,
    reviewer,
    mandatoryRedTeam: Boolean(options.mandatoryRedTeam || reviewer),
    judge,
    reviewIntensity: normalizeReviewIntensity(options.reviewIntensity),
    reasoningEffort: normalizeReasoningEffort(options.reasoningEffort),
    providerPreset: options.providerPreset || "",
    apiBaseUrl: options.apiBaseUrl || options.apiUrl || "",
    apiUrl: options.apiUrl || options.apiBaseUrl || "",
    apiKey: options.apiKey || ""
  };

  if (group.seats) group.seats.push(seat);
  else if (group.agents) group.agents.push(seat);
  else group.seats = [seat];
  const permission = options.permission || options.tier;
  if (permission !== undefined) {
    group.permissions = group.permissions || { defaultTier: "text", seatTiers: {} };
    group.permissions.defaultTier = normalizePermissionTier(group.permissions.defaultTier || "text");
    group.permissions.seatTiers = group.permissions.seatTiers || {};
    group.permissions.seatTiers[seatId] = normalizePermissionTier(permission);
  }
  writeJson(groupFile, group);
  appendLog(groupPath, `Added ${seatId}: ${displayName}; privateFolder=${seat.privateFolder}`);
  return { ok: true, group, seat };
}

export function reorderSeats(options) {
  const groupPath = path.resolve(requireOption(options.groupPath, "groupPath"));
  const seatIds = options.seatIds;
  if (!Array.isArray(seatIds)) throw new Error("seatIds must be an array");
  const groupFile = path.join(groupPath, "group.json");
  const group = JSON.parse(fs.readFileSync(groupFile, "utf8"));
  const seatKey = Array.isArray(group.seats) ? "seats" : "agents";
  const seats = Array.isArray(group[seatKey]) ? group[seatKey] : [];
  const ids = seatIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (ids.length !== seats.length) {
    throw new Error("Seat order must include every current seat exactly once");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Seat order contains duplicate seat ids");
  }
  const byId = new Map();
  seats.forEach((seat, index) => {
    byId.set(seatIdForOrder(seat, index), seat);
  });
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) {
    throw new Error(`Unknown seatId in order: ${unknown.join(", ")}`);
  }
  group[seatKey] = ids.map((id) => byId.get(id));
  writeJson(groupFile, group);
  appendLog(groupPath, `Reordered seats: ${ids.join(", ")}`);
  return { ok: true, group };
}

function createMemberDirs(privateFolder) {
  createDirs([
    privateFolder,
    path.join(privateFolder, "inbox"),
    path.join(privateFolder, "notes"),
    path.join(privateFolder, "drafts"),
    path.join(privateFolder, "private_memory")
  ]);
}

function createDirs(dirs) {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

function appendLog(groupPath, line) {
  const logPath = path.join(groupPath, "shared", "logs", "workspace.log");
  fs.appendFileSync(logPath, `${nowIso()} ${line}\n`, "utf8");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function writeText(filePath, text) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, "utf8");
}

function initialHandoff(displayName) {
  return `# Handoff\n\nCurrent member: ${displayName}\n\n## Notes\n\n- No handoff yet.\n`;
}

function requireOption(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function sanitizeSegment(value) {
  return String(value).trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_") || "untitled";
}

function uniqueSegment(root, parent, preferred) {
  const base = sanitizeSegment(preferred);
  let candidate = base;
  let index = 2;
  while (fs.existsSync(path.join(root, parent, candidate))) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function nextSeatId(seats) {
  const used = new Set(seats.map((item) => item.seatId || item.id).filter(Boolean));
  let index = seats.length + 1;
  while (used.has(`seat_${String(index).padStart(2, "0")}`)) index += 1;
  return `seat_${String(index).padStart(2, "0")}`;
}

function seatIdForOrder(seat = {}, index = 0) {
  return seat.seatId || seat.id || `seat_${String(index + 1).padStart(2, "0")}`;
}

function normalizeReviewIntensity(value) {
  const count = Number.parseInt(String(value || 2), 10);
  if (count === 1 || count === 2 || count === 3) return count;
  return 2;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(effort)) return effort;
  return "";
}

function normalizeSeatRole(value) {
  if (value === "reviewer" || value === "summarizer") return value;
  return "ordinary";
}

function normalizePermissionTier(value) {
  if (["text", "tool", "full"].includes(value)) return value;
  throw new Error(`Unknown permission tier: ${value}`);
}
