import test from "node:test";
import assert from "node:assert/strict";
import {
  assessBudgetUsage,
  assessSizeUsage,
  estimateMessagesTokens,
  estimateTokens,
  hasCoreOverflow,
  resolveEffectiveLimits
} from "../src/tokenLimits.js";

test("effective limits cap provider hard limits by platform and member soft limits", () => {
  const limits = resolveEffectiveLimits({
    providerLimits: {
      contextWindow: 10000,
      maxOutputTokens: 3000,
      requestsPerMinute: 50,
      tokensPerMinute: 100000,
      remainingTokens: 90000
    },
    tokenLimits: {
      maxInputTokensPerCall: 4000,
      maxOutputTokensPerCall: 1200,
      reservedOutputTokens: 600,
      requestsPerMinute: 10
    }
  }, {
    tokenLimits: {
      maxInputTokensPerCall: 8000,
      maxOutputTokensPerCall: 2000,
      maxTokensPerSession: 20000,
      tokensPerMinute: 20000
    }
  });

  assert.equal(limits.effectiveOutputLimit, 1200);
  assert.equal(limits.reservedOutputTokens, 1200);
  assert.equal(limits.effectiveInputLimit, 4000);
  assert.equal(limits.tokenBudget, 20000);
  assert.equal(limits.rpmLimit, 10);
  assert.equal(limits.tpmLimit, 20000);
});

test("unknown provider quota and balance do not participate in min", () => {
  const limits = resolveEffectiveLimits({}, {
    tokenLimits: {
      maxTokensPerSession: 5000,
      maxCostPerSession: 2.5
    }
  });

  assert.equal(limits.tokenBudget, 5000);
  assert.equal(limits.costBudget, 2.5);
});

test("reserved output is always at least the effective output limit", () => {
  const limits = resolveEffectiveLimits({
    providerLimits: { contextWindow: 4096, maxOutputTokens: 1024 },
    tokenLimits: { maxOutputTokensPerCall: 900, reservedOutputTokens: 128 }
  });

  assert.equal(limits.effectiveOutputLimit, 900);
  assert.equal(limits.reservedOutputTokens, 900);
  assert.equal(limits.effectiveInputLimit, 3196);
});

test("CJK fallback token estimation errs high", () => {
  const text = "这是一个用于估算上下文长度的中文句子";
  const estimated = estimateTokens(text, { safetyMargin: 0 });
  assert.ok(estimated >= Math.ceil(text.length * 1.5));
});

test("message token estimation includes content and per-message overhead", () => {
  const estimated = estimateMessagesTokens([
    { role: "system", content: "Return JSON only." },
    { role: "user", content: "请总结这个方案。" }
  ], { safetyMargin: 0, messageOverhead: 4 });

  assert.ok(estimated > 8);
});

test("size thresholds and budget thresholds use separate statuses", () => {
  const limits = resolveEffectiveLimits({
    providerLimits: { contextWindow: 1000, maxOutputTokens: 100 },
    tokenLimits: {
      maxInputTokensPerCall: 900,
      warningThreshold: 0.6,
      compressionThreshold: 0.75,
      hardStopThreshold: 0.9
    }
  });

  assert.equal(assessSizeUsage(100, limits).status, "normal");
  assert.equal(assessSizeUsage(600, limits).status, "warning");
  assert.equal(assessSizeUsage(760, limits).status, "compress");
  assert.equal(assessSizeUsage(900, limits).status, "stop");
  assert.equal(assessBudgetUsage(8, 10).status, "confirm");
  assert.equal(assessBudgetUsage(9, 10).status, "pause");
});

test("non-compressible core overflow is explicit", () => {
  const limits = resolveEffectiveLimits({
    providerLimits: { contextWindow: 1000, maxOutputTokens: 100 },
    tokenLimits: { maxInputTokensPerCall: 500 }
  });

  assert.equal(hasCoreOverflow(499, limits), false);
  assert.equal(hasCoreOverflow(501, limits), true);
});
