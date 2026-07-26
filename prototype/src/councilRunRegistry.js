import path from "node:path";

export function createCouncilRunRegistry() {
  const active = new Map();
  const byId = new Map();
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
        startedAt: new Date().toISOString(),
        state: "running",
        eventSequence: 0,
        events: [],
        subscribers: new Set()
      };
      active.set(key, run);
      byId.set(run.id, run);
      pruneRetainedRuns(byId);
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
      const run = byId.get(String(runId || ""));
      if (!run || run.key !== key) return false;
      if (current?.id === run.id) active.delete(key);
      if (run.state === "running") run.state = run.controller.signal.aborted ? "interrupted" : "completed";
      run.completedAt = new Date().toISOString();
      notifySubscribers(run, "finish", run);
      run.subscribers.clear();
      return Boolean(current?.id === run.id);
    },

    get(groupPath) {
      return active.get(normalizeRunKey(groupPath));
    },

    getById(runId) {
      return byId.get(String(runId || ""));
    },

    publish(runId, event = {}) {
      const run = byId.get(String(runId || ""));
      if (!run) return undefined;
      const record = {
        ...(event && typeof event === "object" ? event : {}),
        runId: run.id,
        eventSequence: ++run.eventSequence
      };
      run.events.push(record);
      if (run.events.length > 1000) run.events.splice(0, run.events.length - 1000);
      notifySubscribers(run, "event", record);
      return record;
    },

    replay(runId, after = 0) {
      const run = byId.get(String(runId || ""));
      if (!run) return [];
      const cursor = normalizeCursor(after);
      return run.events.filter((event) => Number(event.eventSequence || 0) > cursor);
    },

    subscribe(runId, subscriber = {}) {
      const run = byId.get(String(runId || ""));
      if (!run) return undefined;
      const entry = {
        event: typeof subscriber.event === "function" ? subscriber.event : undefined,
        finish: typeof subscriber.finish === "function" ? subscriber.finish : undefined
      };
      run.subscribers.add(entry);
      return () => run.subscribers.delete(entry);
    },

    size() {
      return active.size;
    }
  };
}

function notifySubscribers(run, type, value) {
  for (const subscriber of run.subscribers) {
    try {
      if (type === "event") subscriber.event?.(value);
      else subscriber.finish?.(value);
    } catch {
      // Observer failure must never stop the durable council run.
    }
  }
}

function normalizeCursor(value) {
  const parsed = Number.parseInt(String(value || 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pruneRetainedRuns(byId) {
  const retained = [...byId.values()];
  if (retained.length <= 64) return;
  for (const run of retained) {
    if (byId.size <= 64) break;
    if (run.state !== "running") byId.delete(run.id);
  }
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
