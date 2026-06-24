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
      enabled: member.enabled ?? true
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
