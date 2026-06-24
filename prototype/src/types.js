export const ROUND_STATUSES = new Set(["speak", "skip", "error", "unavailable"]);

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${rand}`;
}
