import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const VAULT_SCHEMA = "ai-council.credential-vault.v1";
const DPAPI_SCHEME = "windows-dpapi-current-user";
const DEFAULT_POOL_ID = "default";
const decryptedPoolCache = new Map();

// Credentials live outside the workspace and Git. On Windows the payload is
// encrypted with DPAPI for the current user, so copying the file alone is not
// enough to recover its secrets on another account or machine.
export function credentialVaultPath(options = {}) {
  if (options.vaultPath) return path.resolve(String(options.vaultPath));
  if (process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH) {
    return path.resolve(process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "AI Council", "credential-vault.v1.json");
}

export function credentialFingerprint(apiKey) {
  return `key_${createHash("sha256").update(String(apiKey || "")).digest("hex").slice(0, 16)}`;
}

export function saveCredentialPool(input = {}, options = {}) {
  const poolId = normalizedPoolId(input.id || input.poolId || DEFAULT_POOL_ID);
  const keys = uniqueKeys(input.keys || input.apiKeys || []);
  if (!keys.length) throw vaultError("credential_pool_empty", "Credential pool needs at least one non-empty key.");
  const vaultPath = credentialVaultPath(options);
  const document = readVaultDocument(vaultPath);
  const now = new Date().toISOString();
  const previous = document.pools.find((item) => item.id === poolId);
  const existingStates = new Map((previous?.keyStates || []).map((item) => [item.fingerprint, item]));
  const secret = JSON.stringify({
    schema: VAULT_SCHEMA,
    poolId,
    keys: keys.map((key) => ({ fingerprint: credentialFingerprint(key), apiKey: key }))
  });
  const encrypted = protectSecret(secret, options);
  const entry = {
    id: poolId,
    label: normalizedLabel(input.label || previous?.label || poolId),
    providerId: normalizedIdentifier(input.providerId || previous?.providerId || ""),
    apiBaseUrl: normalizedPublicUrl(input.apiBaseUrl || previous?.apiBaseUrl || ""),
    defaultModel: normalizedModel(input.defaultModel || input.model || previous?.defaultModel || ""),
    transport: normalizedIdentifier(input.transport || previous?.transport || "openai-compatible"),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    encryption: {
      scheme: encrypted.scheme,
      ciphertext: encrypted.ciphertext
    },
    keyStates: keys.map((key) => {
      const fingerprint = credentialFingerprint(key);
      const state = existingStates.get(fingerprint) || {};
      return {
        fingerprint,
        lastAttemptAt: state.lastAttemptAt || "",
        lastSuccessAt: state.lastSuccessAt || "",
        lastFailureAt: state.lastFailureAt || "",
        lastFailureCategory: state.lastFailureCategory || "",
        consecutiveFailures: normalizeCount(state.consecutiveFailures),
        disabledUntil: state.disabledUntil || ""
      };
    }),
    rotation: {
      nextFingerprint: previous?.rotation?.nextFingerprint || credentialFingerprint(keys[0])
    }
  };
  document.pools = [...document.pools.filter((item) => item.id !== poolId), entry];
  writeVaultDocument(vaultPath, document);
  clearCachedPool(vaultPath, poolId);
  return publicCredentialPool(entry);
}

export function readCredentialPool(poolId = DEFAULT_POOL_ID, options = {}) {
  const id = normalizedPoolId(poolId);
  const vaultPath = credentialVaultPath(options);
  const entry = readVaultDocument(vaultPath).pools.find((item) => item.id === id);
  if (!entry) throw vaultError("credential_pool_not_found", `Credential pool is not configured: ${id}.`);
  const cacheKey = `${vaultPath}\u0000${id}\u0000${entry.encryption?.ciphertext || ""}`;
  const decrypted = decryptedPoolCache.get(cacheKey) || unprotectSecret(entry.encryption, options);
  decryptedPoolCache.set(cacheKey, decrypted);
  let secret;
  try {
    secret = JSON.parse(decrypted);
  } catch {
    throw vaultError("credential_pool_corrupt", `Credential pool cannot be decoded: ${id}.`);
  }
  const expected = new Set((entry.keyStates || []).map((item) => item.fingerprint));
  const keys = Array.isArray(secret?.keys)
    ? secret.keys.map((item) => ({
      fingerprint: String(item?.fingerprint || credentialFingerprint(item?.apiKey)),
      apiKey: String(item?.apiKey || "").trim()
    })).filter((item) => item.apiKey && expected.has(item.fingerprint))
    : [];
  if (!keys.length) throw vaultError("credential_pool_empty", `Credential pool has no usable keys: ${id}.`);
  return { ...publicCredentialPool(entry), keys };
}

export function resolveCredentialCandidates(poolId = DEFAULT_POOL_ID, options = {}) {
  const pool = readCredentialPool(poolId, options);
  const nowMs = options.nowMs ?? Date.now();
  const stateByFingerprint = new Map(pool.keyStates.map((item) => [item.fingerprint, item]));
  const ordered = rotateFrom(pool.keys, pool.rotation?.nextFingerprint);
  const available = ordered.filter((item) => !isDeferred(stateByFingerprint.get(item.fingerprint), nowMs));
  const selected = available.length ? available : ordered;
  return {
    pool: publicCredentialPool(pool),
    allDeferred: !available.length,
    candidates: selected.map((item) => ({
      apiKey: item.apiKey,
      fingerprint: item.fingerprint,
      source: "credential_pool",
      poolId: pool.id
    }))
  };
}

export function recordCredentialPoolOutcome(poolId, fingerprint, outcome = {}, options = {}) {
  const id = normalizedPoolId(poolId);
  const vaultPath = credentialVaultPath(options);
  const document = readVaultDocument(vaultPath);
  const pool = document.pools.find((item) => item.id === id);
  if (!pool) throw vaultError("credential_pool_not_found", `Credential pool is not configured: ${id}.`);
  const index = pool.keyStates.findIndex((item) => item.fingerprint === fingerprint);
  if (index < 0) throw vaultError("credential_key_not_found", "Credential fingerprint is not part of this pool.");
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const previous = pool.keyStates[index] || {};
  const succeeded = outcome.status === "success";
  const category = normalizedFailureCategory(outcome.category);
  pool.keyStates[index] = succeeded
    ? {
      ...previous,
      fingerprint,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastFailureCategory: "",
      consecutiveFailures: 0,
      disabledUntil: ""
    }
    : {
      ...previous,
      fingerprint,
      lastAttemptAt: now,
      lastFailureAt: now,
      lastFailureCategory: category,
      consecutiveFailures: normalizeCount(previous.consecutiveFailures) + 1,
      disabledUntil: disabledUntilFor(category, options.nowMs ?? Date.now())
    };
  const ordered = pool.keyStates.map((item) => item.fingerprint);
  const current = ordered.indexOf(fingerprint);
  pool.rotation = { nextFingerprint: ordered[(current + 1 + ordered.length) % ordered.length] || fingerprint };
  pool.updatedAt = now;
  writeVaultDocument(vaultPath, document);
  return publicCredentialPool(pool);
}

function clearCachedPool(vaultPath, poolId) {
  const prefix = `${vaultPath}\u0000${poolId}\u0000`;
  for (const key of decryptedPoolCache.keys()) {
    if (key.startsWith(prefix)) decryptedPoolCache.delete(key);
  }
}

export function listCredentialPools(options = {}) {
  return readVaultDocument(credentialVaultPath(options)).pools.map(publicCredentialPool);
}

export function publicCredentialPool(pool = {}) {
  return {
    id: String(pool.id || ""),
    label: String(pool.label || ""),
    providerId: String(pool.providerId || ""),
    apiBaseUrl: String(pool.apiBaseUrl || ""),
    defaultModel: String(pool.defaultModel || ""),
    transport: String(pool.transport || ""),
    createdAt: String(pool.createdAt || ""),
    updatedAt: String(pool.updatedAt || ""),
    keyCount: Array.isArray(pool.keyStates) ? pool.keyStates.length : 0,
    keyStates: (pool.keyStates || []).map((item) => ({
      fingerprint: String(item.fingerprint || ""),
      lastAttemptAt: String(item.lastAttemptAt || ""),
      lastSuccessAt: String(item.lastSuccessAt || ""),
      lastFailureAt: String(item.lastFailureAt || ""),
      lastFailureCategory: String(item.lastFailureCategory || ""),
      consecutiveFailures: normalizeCount(item.consecutiveFailures),
      disabledUntil: String(item.disabledUntil || "")
    })),
    rotation: { nextFingerprint: String(pool.rotation?.nextFingerprint || "") }
  };
}

function readVaultDocument(filePath) {
  if (!fs.existsSync(filePath)) return { schema: VAULT_SCHEMA, pools: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.schema !== VAULT_SCHEMA || !Array.isArray(parsed.pools)) throw new Error("schema");
    return parsed;
  } catch {
    throw vaultError("credential_vault_corrupt", "Credential vault is unreadable. Restore it from a local backup or import the keys again.");
  }
}

function writeVaultDocument(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...document, schema: VAULT_SCHEMA }, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function protectSecret(text, options = {}) {
  if (options.protector) return { scheme: options.protector.scheme || "test", ciphertext: options.protector.protect(String(text)) };
  requireWindowsDpapi();
  return { scheme: DPAPI_SCHEME, ciphertext: invokeDpapi("protect", String(text)) };
}

function unprotectSecret(encryption = {}, options = {}) {
  if (options.protector) return options.protector.unprotect(String(encryption.ciphertext || ""));
  if (encryption.scheme !== DPAPI_SCHEME) throw vaultError("credential_vault_scheme", "Credential vault encryption scheme is unsupported on this machine.");
  requireWindowsDpapi();
  return invokeDpapi("unprotect", String(encryption.ciphertext || ""));
}

function invokeDpapi(mode, input) {
  const command = mode === "protect"
    ? "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)"
    : "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($p)";
  const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0 || !String(result.stdout || "").trim()) {
    throw vaultError(`credential_vault_${mode}_failed`, "Windows credential protection failed. The credential vault was not written or read.");
  }
  return String(result.stdout).trim();
}

function requireWindowsDpapi() {
  if (process.platform !== "win32") throw vaultError("credential_vault_platform", "The local credential vault requires Windows DPAPI on this build.");
}

function uniqueKeys(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [values])
    .map((value) => String(value || "").trim())
    .filter((value) => value && !seen.has(credentialFingerprint(value)) && Boolean(seen.add(credentialFingerprint(value))));
}

function rotateFrom(values, fingerprint) {
  const index = values.findIndex((item) => item.fingerprint === fingerprint);
  return index < 0 ? values : [...values.slice(index), ...values.slice(0, index)];
}

function isDeferred(state = {}, nowMs) {
  const deadline = Date.parse(String(state?.disabledUntil || ""));
  return Number.isFinite(deadline) && deadline > nowMs;
}

function disabledUntilFor(category, nowMs) {
  const delayMs = category === "authentication" ? 6 * 60 * 60 * 1000
    : category === "quota" ? 15 * 60 * 1000
      : category === "rate_limit" ? 90 * 1000
        : category === "transient" ? 30 * 1000
          : 0;
  return delayMs ? new Date(nowMs + delayMs).toISOString() : "";
}

function normalizedPoolId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw vaultError("credential_pool_id", "Credential pool id must use letters, numbers, dots, underscores, or dashes.");
  return id;
}

function normalizedIdentifier(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizedLabel(value) {
  return String(value || "").trim().slice(0, 120);
}

function normalizedModel(value) {
  return String(value || "").trim().slice(0, 240);
}

function normalizedPublicUrl(value) {
  return String(value || "").trim().slice(0, 2048).replace(/\/$/, "");
}

function normalizedFailureCategory(value) {
  return ["authentication", "quota", "rate_limit", "transient"].includes(value) ? value : "unknown";
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function vaultError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
