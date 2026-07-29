import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { callAgentResult } from "../src/modelClient.js";
import {
  credentialFingerprint,
  listCredentialPools,
  readCredentialPool,
  recordCredentialPoolOutcome,
  resolveCredentialCandidates,
  saveCredentialPool
} from "../src/credentialVault.js";

function tempVault() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-vault-")), "credential-vault.json");
}

const testProtector = {
  scheme: "test-base64",
  protect(value) { return Buffer.from(value, "utf8").toString("base64"); },
  unprotect(value) { return Buffer.from(value, "base64").toString("utf8"); }
};

test("credential vault stores only encrypted test payload and returns redacted pool facts", () => {
  const vaultPath = tempVault();
  saveCredentialPool({
    id: "deepseek-primary",
    label: "DeepSeek primary",
    providerId: "deepseek",
    apiBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keys: ["synthetic-key-a", "synthetic-key-b", "synthetic-key-a"]
  }, { vaultPath, protector: testProtector });

  const raw = fs.readFileSync(vaultPath, "utf8");
  assert.equal(raw.includes("synthetic-key-a"), false);
  assert.equal(raw.includes("synthetic-key-b"), false);
  const publicPool = listCredentialPools({ vaultPath })[0];
  assert.equal(publicPool.keyCount, 2);
  assert.deepEqual(Object.keys(publicPool).sort(), ["apiBaseUrl", "createdAt", "defaultModel", "id", "keyCount", "keyStates", "label", "providerId", "rotation", "transport", "updatedAt"]);

  const restored = readCredentialPool("deepseek-primary", { vaultPath, protector: testProtector });
  assert.deepEqual(restored.keys.map((item) => item.apiKey), ["synthetic-key-a", "synthetic-key-b"]);
});

test("credential pool rotates away from an unavailable key and keeps task errors distinct", () => {
  const vaultPath = tempVault();
  saveCredentialPool({ id: "rotation", keys: ["synthetic-key-a", "synthetic-key-b"] }, { vaultPath, protector: testProtector });
  const first = credentialFingerprint("synthetic-key-a");
  recordCredentialPoolOutcome("rotation", first, { status: "failed", category: "rate_limit" }, {
    vaultPath,
    protector: testProtector,
    nowMs: Date.parse("2026-01-01T00:00:00.000Z")
  });
  const candidates = resolveCredentialCandidates("rotation", {
    vaultPath,
    protector: testProtector,
    nowMs: Date.parse("2026-01-01T00:00:01.000Z")
  });
  assert.deepEqual(candidates.candidates.map((item) => item.apiKey), ["synthetic-key-b"]);
  assert.equal(candidates.candidates[0].fingerprint, credentialFingerprint("synthetic-key-b"));
});

test("model client fails over to the next encrypted pool key after authentication failure", async () => {
  const vaultPath = tempVault();
  saveCredentialPool({ id: "model-rotation", keys: ["synthetic-denied", "synthetic-accepted"] }, { vaultPath });
  const previousPath = process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH;
  process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH = vaultPath;
  const headers = [];
  const server = http.createServer(async (req, res) => {
    headers.push(req.headers.authorization || "");
    for await (const _ of req) {}
    if (headers.length === 1) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "rotated" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await listen(server);
  try {
    const result = await callAgentResult({
      id: "pool-agent",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      credentialPoolId: "model-rotation",
      model: "synthetic-model",
      retry: { maxRetries: 0 }
    }, [{ role: "user", content: "Question" }], { timeoutMs: 2000, allowUnsafePrivateNetwork: true });
    assert.equal(result.text, "rotated");
    assert.deepEqual(headers, ["Bearer synthetic-denied", "Bearer synthetic-accepted"]);
    assert.equal(result.credential.source, "credential_pool");
    assert.equal(result.credential.poolId, "model-rotation");
    assert.notEqual(result.credential.fingerprint, "synthetic-accepted");
  } finally {
    if (previousPath === undefined) delete process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH;
    else process.env.AI_COUNCIL_CREDENTIAL_VAULT_PATH = previousPath;
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
