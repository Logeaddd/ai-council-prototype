import path from "node:path";

export function createCouncilRunRegistry() {
  const active = new Map();
  let sequence = 0;

  return {
    start(groupPath) {
      const key = normalizeRunKey(groupPath);
      const previous = active.get(key);
      if (previous && !previous.controller.signal.aborted) {
        previous.controller.abort(abortReason("superseded_by_new_run"));
      }
      const run = {
        id: `run_${Date.now()}_${++sequence}`,
        key,
        controller: new AbortController(),
        startedAt: new Date().toISOString()
      };
      active.set(key, run);
      return run;
    },

    stop(groupPath, reason = "stopped_by_user") {
      const key = normalizeRunKey(groupPath);
      const run = active.get(key);
      if (!run) return { stopped: false, runId: "" };
      if (!run.controller.signal.aborted) {
        run.controller.abort(abortReason(reason));
      }
      return { stopped: true, runId: run.id };
    },

    finish(groupPath, runId) {
      const key = normalizeRunKey(groupPath);
      const current = active.get(key);
      if (!current || current.id !== runId) return false;
      active.delete(key);
      return true;
    },

    get(groupPath) {
      return active.get(normalizeRunKey(groupPath));
    },

    size() {
      return active.size;
    }
  };
}

function normalizeRunKey(groupPath) {
  const value = String(groupPath || "").trim();
  if (!value) throw new Error("A group path is required for a council run.");
  return process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
}

function abortReason(code) {
  const error = new Error(code);
  error.name = "AbortError";
  error.code = code;
  return error;
}
