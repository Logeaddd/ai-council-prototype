import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readGroupIndex(baseDir) {
  const filePath = groupIndexPath(baseDir);
  if (!fs.existsSync(filePath)) return emptyIndex();
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeIndex(parsed);
}

export function upsertGroupIndexRecord(baseDir, record) {
  const index = readGroupIndex(baseDir);
  const normalized = normalizeRecord(record);
  const existing = index.groups.find((item) => item.id === normalized.id);
  const nextRecord = {
    ...(existing || {}),
    ...normalized,
    updatedAt: nowIso(),
    lastOpenedAt: record.lastOpenedAt || nowIso()
  };
  index.groups = [
    nextRecord,
    ...index.groups.filter((item) => item.id !== normalized.id)
  ];
  index.lastGroupId = nextRecord.id;
  writeGroupIndex(baseDir, index);
  return index;
}

export function updateGroupIndexRecord(baseDir, groupId, patch) {
  const index = readGroupIndex(baseDir);
  const target = index.groups.find((item) => item.id === groupId);
  if (!target) throw new Error(`Unknown group id: ${groupId}`);
  Object.assign(target, sanitizePatch(patch), { updatedAt: nowIso() });
  if (patch.lastOpenedAt) index.lastGroupId = target.id;
  writeGroupIndex(baseDir, index);
  return index;
}

export function removeGroupIndexRecord(baseDir, groupId) {
  const index = readGroupIndex(baseDir);
  index.groups = index.groups.filter((item) => item.id !== groupId);
  if (index.lastGroupId === groupId) index.lastGroupId = index.groups[0]?.id || "";
  writeGroupIndex(baseDir, index);
  return index;
}

export function recordIdForPath(groupPath) {
  const normalizedPath = path.resolve(groupPath).toLowerCase();
  const digest = crypto.createHash("sha1").update(normalizedPath).digest("hex").slice(0, 24);
  return `group_${digest}`;
}

function writeGroupIndex(baseDir, index) {
  const filePath = groupIndexPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalizeIndex(index), null, 2), "utf8");
}

function groupIndexPath(baseDir) {
  return path.join(baseDir, "user-data", "groups-index.json");
}

function emptyIndex() {
  return { version: 1, lastGroupId: "", groups: [] };
}

function normalizeIndex(value) {
  const index = {
    version: 1,
    lastGroupId: typeof value?.lastGroupId === "string" ? value.lastGroupId : "",
    groups: Array.isArray(value?.groups) ? value.groups.map(normalizeRecord) : []
  };
  if (!index.groups.some((group) => group.id === index.lastGroupId)) {
    index.lastGroupId = index.groups[0]?.id || "";
  }
  index.groups.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.lastOpenedAt || b.updatedAt).localeCompare(String(a.lastOpenedAt || a.updatedAt));
  });
  return index;
}

function normalizeRecord(record = {}) {
  const groupPath = String(record.path || record.groupPath || "").trim();
  if (!groupPath) throw new Error("Group index record needs path");
  const now = nowIso();
  return {
    id: String(record.id || recordIdForPath(groupPath)),
    name: String(record.name || path.basename(groupPath) || "Untitled group"),
    path: groupPath,
    pinned: Boolean(record.pinned),
    lastOpenedAt: String(record.lastOpenedAt || record.updatedAt || now),
    updatedAt: String(record.updatedAt || now)
  };
}

function sanitizePatch(patch = {}) {
  const sanitized = {};
  if (patch.name !== undefined) sanitized.name = String(patch.name || "").trim() || "Untitled group";
  if (patch.pinned !== undefined) sanitized.pinned = Boolean(patch.pinned);
  if (patch.lastOpenedAt !== undefined) sanitized.lastOpenedAt = String(patch.lastOpenedAt || nowIso());
  return sanitized;
}

function nowIso() {
  return new Date().toISOString();
}
