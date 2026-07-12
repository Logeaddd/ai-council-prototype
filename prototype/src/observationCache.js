const OBSERVATION_TOOLS = new Set(["read_file", "list_directory", "search_files", "grep_content"]);

export function createObservationCache() {
  const entries = new Map();
  let workspaceRevision = 0;

  return {
    get(request = {}) {
      if (request.force) return undefined;
      const key = observationKey(request);
      if (!key) return undefined;
      const entry = entries.get(key);
      if (!entry || entry.workspaceRevision !== workspaceRevision) return undefined;
      return clone(entry);
    },

    set(request = {}, value, source = {}) {
      const key = observationKey(request);
      if (!key) return undefined;
      const entry = {
        key,
        workspaceRevision,
        value: canonicalObservationValue(request, value),
        sourceId: String(source.id || source.proposalId || ""),
        sourceAgentId: String(source.source_agent_id || ""),
        sourceAgentName: String(source.source_agent_name || ""),
        observedAt: String(source.createdAt || new Date().toISOString())
      };
      entries.set(key, entry);
      return clone(entry);
    },

    invalidate(reason = "workspace_mutated") {
      workspaceRevision += 1;
      entries.clear();
      return { workspaceRevision, reason };
    },

    revision() {
      return workspaceRevision;
    },

    size() {
      return entries.size;
    }
  };
}

export function observationKey(request = {}) {
  const tool = normalizedObservationTool(request);
  if (!tool) return "";
  const root = normalizeValue(request.root || "workspace");
  const target = normalizeValue(request.path || ".");
  if (tool === "read_file" || tool === "list_directory") {
    return `${tool}|${root}|${target}`;
  }
  const query = normalizeValue(request.query || request.pattern);
  return `${tool}|${root}|${target}|${query}`;
}

export function isObservationRequest(request = {}) {
  return Boolean(normalizedObservationTool(request));
}

export function hasMaterialWorkspaceChange(record = {}) {
  if (["write", "append", "delete", "restore", "move", "patch"].includes(String(record.op || record.action || ""))
    && ["executed", "committed", "restored", "completed"].includes(String(record.status || ""))) {
    return true;
  }
  const changes = record.result?.workspaceChanges || record.workspaceChanges || {};
  if (Number(changes.totalChanges || 0) > 0) return true;
  return [changes.created, changes.modified, changes.deleted]
    .some((items) => Array.isArray(items) && items.length > 0);
}

export function observationValueForConsumer(request = {}, value = {}) {
  const tool = normalizedObservationTool(request);
  if (tool === "read_file") {
    if (request.op === "read") {
      return pick(value, ["bytes", "truncated", "content"]);
    }
    return {
      ok: true,
      source: "shared_observation_cache",
      root: value.root || "workspace",
      path: value.path || normalizeDisplayPath(request.path),
      ...pick(value, ["bytes", "truncated", "content"])
    };
  }
  if (tool === "list_directory") {
    const entries = normalizeListEntries(value.entries, value.path || request.path);
    if (request.op === "list") {
      return {
        entries: entries.map((entry) => entry.type === "directory" ? `${entry.name}/` : entry.name),
        truncated: Boolean(value.truncated)
      };
    }
    return {
      ok: true,
      source: "shared_observation_cache",
      root: value.root || "workspace",
      path: value.path || normalizeDisplayPath(request.path || "."),
      entries,
      truncated: Boolean(value.truncated)
    };
  }
  return clone(value);
}

function canonicalObservationValue(request, value = {}) {
  const tool = normalizedObservationTool(request);
  if (tool === "read_file") {
    return {
      kind: "read_file",
      root: value.root || "workspace",
      path: value.path || normalizeDisplayPath(request.path),
      ...pick(value, ["bytes", "truncated", "content"])
    };
  }
  if (tool === "list_directory") {
    return {
      kind: "list_directory",
      root: value.root || "workspace",
      path: value.path || normalizeDisplayPath(request.path || "."),
      entries: normalizeListEntries(value.entries, value.path || request.path),
      truncated: Boolean(value.truncated)
    };
  }
  return clone(value);
}

function normalizeListEntries(entries, parentPath) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (entry && typeof entry === "object") {
      return {
        name: String(entry.name || ""),
        path: String(entry.path || joinPath(parentPath, entry.name)),
        type: String(entry.type || "other")
      };
    }
    const raw = String(entry || "");
    const directory = raw.endsWith("/");
    const name = directory ? raw.slice(0, -1) : raw;
    return {
      name,
      path: joinPath(parentPath, name),
      type: directory ? "directory" : "file"
    };
  }).filter((entry) => entry.name);
}

function joinPath(parent, name) {
  const base = normalizeDisplayPath(parent || ".");
  return base === "." ? String(name || "") : `${base}/${String(name || "")}`;
}

function normalizeDisplayPath(value) {
  const normalized = String(value || ".").trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalized || ".";
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, clone(value[key])]));
}

function normalizedObservationTool(request) {
  const direct = String(request.tool || "");
  if (OBSERVATION_TOOLS.has(direct)) return direct;
  const op = String(request.op || "");
  if (op === "read") return "read_file";
  if (op === "list") return "list_directory";
  return "";
}

function normalizeValue(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}
