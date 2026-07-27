// A process-local provenance tag. It cannot be supplied by model JSON because
// only this module holds the WeakSet used to recognize it.
const nativeModelSources = new WeakSet();

export function markNativeModelSource(value) {
  if (value && typeof value === "object") nativeModelSources.add(value);
  return value;
}

export function hasNativeModelSource(value) {
  return Boolean(value && typeof value === "object" && nativeModelSources.has(value));
}
