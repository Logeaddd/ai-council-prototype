import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_FILES = 7;
const DEFAULT_MAX_FILE_BYTES = 96 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 680 * 1024;
const DEFAULT_MAX_TREE_ENTRIES = 500;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".sh",
  ".ps1",
  ".sql",
  ".csv",
  ".toml",
  ".properties",
  ".mcmeta",
  ".mcfunction",
  ".lang"
]);

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  ".gradle",
  ".mvn",
  "__pycache__"
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

export function importProjectFolder(folderPath, options = {}) {
  const root = path.resolve(requirePath(folderPath, "folderPath"));
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`Project import path is not a folder: ${root}`);

  const maxFiles = Number(options.maxFiles || DEFAULT_MAX_FILES);
  const maxFileBytes = Number(options.maxFileBytes || DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES);
  const maxTreeEntries = Number(options.maxTreeEntries || DEFAULT_MAX_TREE_ENTRIES);
  const state = {
    root,
    treeEntries: [],
    textFiles: [],
    skippedBinary: 0,
    skippedLarge: 0,
    skippedDirs: 0,
    treeTruncated: false
  };

  walk(root, "", state, { maxTreeEntries });
  const selected = selectTextFiles(state.textFiles, maxFiles);
  const attachments = [
    projectTreeAttachment(root, state, selected),
    ...readSelectedTextFiles(root, selected, { maxFileBytes, maxTotalBytes })
  ];

  return {
    root,
    totalTextFiles: state.textFiles.length,
    importedFiles: attachments.length - 1,
    skippedBinary: state.skippedBinary,
    skippedLarge: state.skippedLarge,
    skippedDirs: state.skippedDirs,
    treeTruncated: state.treeTruncated,
    attachments
  };
}

function walk(current, relative, state, options) {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".minecraft") {
      if (entry.isDirectory()) state.skippedDirs += 1;
      continue;
    }
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const normalizedRelative = childRelative.replaceAll("\\", "/");
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (normalizedRelative.toLowerCase() === "shared/file-ops") {
        state.skippedDirs += 1;
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) {
        state.skippedDirs += 1;
        continue;
      }
      addTreeEntry(state, options, `${indent(normalizedRelative)}${entry.name}/`);
      walk(absolute, childRelative, state, options);
      continue;
    }
    if (!entry.isFile()) continue;
    addTreeEntry(state, options, `${indent(normalizedRelative)}${entry.name}`);
    if (isTextCandidate(entry.name)) {
      state.textFiles.push({ path: normalizedRelative, absolute });
    } else {
      state.skippedBinary += 1;
    }
  }
}

function addTreeEntry(state, options, value) {
  if (state.treeEntries.length >= options.maxTreeEntries) {
    state.treeTruncated = true;
    return;
  }
  state.treeEntries.push(value);
}

function selectTextFiles(files, maxFiles) {
  const priority = [
    /(^|\/)(STORY|story|LORE|lore|WORLD|world).*\.md$/,
    /(^|\/).*世界观.*\.(md|txt|json)$/,
    /(^|\/)(MOD_HANDOFF|mod_handoff).*\.md$/,
    /(^|\/)(README|readme)\.md$/,
    /(^|\/)(package|mod|fabric\.mod|mcmod\.info)\.json$/,
    /(^|\/)mods\.toml$/,
    /(^|\/)src\/main\/resources\/assets\/[^/]+\/lang\/.+\.(json|lang)$/,
    /(^|\/)lang\/.+\.(json|lang)$/,
    /(^|\/)src\/.+\.(java|kt|js|ts|json)$/,
    /(^|\/)assets\/.+\.(json|mcmeta)$/,
    /\.(md|json|toml|properties|lang|mcfunction)$/
  ];
  return [...files]
    .sort((a, b) => scorePath(b.path, priority) - scorePath(a.path, priority) || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
}

function readSelectedTextFiles(root, files, options) {
  const attachments = [];
  let total = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file.absolute);
    if (buffer.includes(0)) continue;
    const truncated = buffer.length > options.maxFileBytes;
    const slice = truncated ? buffer.subarray(0, options.maxFileBytes) : buffer;
    total += slice.length;
    if (total > options.maxTotalBytes) break;
    const text = slice.toString("utf8");
    attachments.push({
      name: safeAttachmentName(`project-file-${attachments.length + 1}-${file.path}`),
      type: "text/plain",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      truncated,
      content: [
        `Project root: ${root}`,
        `Relative path: ${file.path}`,
        truncated ? `Status: truncated to ${options.maxFileBytes} bytes` : "Status: complete text content",
        "",
        text
      ].join("\n")
    });
  }
  return attachments;
}

function projectTreeAttachment(root, state, selected) {
  const content = [
    `Project import from: ${root}`,
    `Directory entries included: ${state.treeEntries.length}${state.treeTruncated ? " (truncated)" : ""}`,
    `Text files found: ${state.textFiles.length}`,
    `Text files imported: ${selected.length}`,
    `Skipped folders: ${state.skippedDirs}`,
    `Skipped non-text files: ${state.skippedBinary}`,
    "",
    "Imported file list:",
    ...selected.map((file) => `- ${file.path}`),
    "",
    "Directory tree:",
    ...state.treeEntries
  ].join("\n");
  return {
    name: "project-directory-tree.txt",
    type: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    content,
    truncated: state.treeTruncated
  };
}

function isTextCandidate(name) {
  if (SKIP_FILES.has(name)) return false;
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function scorePath(value, priority) {
  const normalized = value.replaceAll("\\", "/");
  const matched = priority.findIndex((pattern) => pattern.test(normalized));
  return matched < 0 ? 0 : priority.length - matched;
}

function indent(relativePath) {
  const depth = relativePath.split("/").length - 1;
  return "  ".repeat(depth);
}

function safeAttachmentName(value) {
  return String(value || "project-file")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .slice(0, 180);
}

function requirePath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}
