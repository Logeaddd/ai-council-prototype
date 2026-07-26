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

test("unknown output capacity does not create an application speech limit or reservation", () => {
  const limits = resolveEffectiveLimits({});

  assert.equal(limits.effectiveOutputLimit, 0);
  assert.equal(limits.reservedOutputTokens, 0);
  assert.equal(limits.contextWindow, undefined);
  assert.equal(limits.effectiveInputLimit, undefined);
  assert.equal(limits.inputLimitKnown, false);
  assert.equal(limits.inputLimitSource, "unknown");
  assert.equal(hasCoreOverflow(1_000_000, limits), false);
});

test("observed provider calibration only adjusts estimates and does not invent a context window", () => {
  // 72 ASCII characters yield an integral uncalibrated base estimate, so the
  // assertion does not accidentally compare different rounding stages.
  const raw = "a".repeat(72);
  const baseline = estimateTokens(raw, { safetyMargin: 0 });
  const calibrated = estimateTokens(raw, { safetyMargin: 0, calibrationMultiplier: 1.6 });
  const limits = resolveEffectiveLimits({}, {}, {
    provider: "openai-compatible",
    model: "example-model",
    sampleCount: 3,
    freshestAt: "2026-07-27T10:00:00.000Z",
    inputEstimateMultiplier: 1.6
  });

  assert.equal(calibrated, Math.ceil(baseline * 1.6));
  assert.equal(limits.inputEstimateMultiplier, 1.6);
  assert.equal(limits.inputEstimateCalibration.status, "observed");
  assert.equal(limits.contextWindow, undefined);
  assert.equal(limits.effectiveInputLimit, undefined);
});

test("explicit member output settings are preserved without an application ceiling", () => {
  const limits = resolveEffectiveLimits({
    providerLimits: { contextWindow: 500000 },
    tokenLimits: { maxOutputTokensPerCall: 250000 }
  });

  assert.equal(limits.effectiveOutputLimit, 250000);
  assert.equal(limits.reservedOutputTokens, 250000);
  assert.equal(limits.effectiveInputLimit, 250000);
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
