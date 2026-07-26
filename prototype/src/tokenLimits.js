const DEFAULT_WARNING_THRESHOLD = 0.6;
const DEFAULT_COMPRESSION_THRESHOLD = 0.75;
const DEFAULT_HARD_STOP_THRESHOLD = 0.9;
const DEFAULT_SAFETY_MARGIN = 0.15;

export function estimateTokens(text, options = {}) {
  const value = String(text ?? "");
  if (!value) return 0;

  const safetyMargin = numberOr(options.safetyMargin, DEFAULT_SAFETY_MARGIN);
  const calibration = calibrationMultiplier(options.calibrationMultiplier);
  const base = estimateBaseTokens(value, options.contentType);
  return Math.ceil(base * (1 + safetyMargin) * calibration);
}

export function estimateMessagesTokens(messages, options = {}) {
  const messageOverhead = numberOr(options.messageOverhead, 4);
  const base = (messages || []).reduce((sum, message) => {
    return sum
      + estimateTokens(message?.role || "", options)
      + estimateTokens(message?.content || "", options)
      + messageOverhead;
  }, 0);
  return Math.ceil(base);
}

export function resolveEffectiveLimits(agent = {}, groupSettings = {}, providerUsageCalibration = undefined) {
  const provider = agent.providerLimits || {};
  const soft = {
    ...(groupSettings.tokenLimits || {}),
    ...(agent.tokenLimits || {})
  };

  const providerContextWindow = positiveNumber(provider.contextWindow);
  const providerMaxOutput = positiveNumber(provider.maxOutputTokens);
  const softMaxOutput = positiveNumber(soft.maxOutputTokensPerCall);
  const effectiveOutputLimit = minKnown(providerMaxOutput, softMaxOutput) ?? 0;
  const requestedReserved = positiveNumber(soft.reservedOutputTokens) ?? 0;
  const reservedOutputTokens = Math.max(requestedReserved, effectiveOutputLimit);
  const providerInputLimit = providerContextWindow
    ? Math.max(1, providerContextWindow - reservedOutputTokens)
    : undefined;
  const softInputLimit = positiveNumber(soft.maxInputTokensPerCall);
  const effectiveInputLimit = minKnown(providerInputLimit, softInputLimit);
  const inputLimitSource = effectiveInputLimit === undefined
    ? "unknown"
    : providerInputLimit !== undefined && effectiveInputLimit === providerInputLimit
      ? "provider_context_window"
      : "configured_input_cap";
  const inputEstimateMultiplier = calibrationMultiplier(providerUsageCalibration?.inputEstimateMultiplier);

  return {
    contextWindow: providerContextWindow,
    effectiveInputLimit,
    inputLimitSource,
    inputLimitKnown: effectiveInputLimit !== undefined,
    effectiveOutputLimit,
    reservedOutputTokens,
    inputEstimateMultiplier,
    inputEstimateCalibration: normalizeCalibration(providerUsageCalibration),
    warningThreshold: clampRatio(soft.warningThreshold, DEFAULT_WARNING_THRESHOLD),
    compressionThreshold: clampRatio(soft.compressionThreshold, DEFAULT_COMPRESSION_THRESHOLD),
    hardStopThreshold: clampRatio(soft.hardStopThreshold, DEFAULT_HARD_STOP_THRESHOLD),
    tokenBudget: minKnown(provider.remainingTokens, soft.maxTokensPerSession),
    costBudget: minKnown(provider.remainingBalance, soft.maxCostPerSession),
    rpmLimit: minKnown(provider.requestsPerMinute, soft.requestsPerMinute),
    tpmLimit: minKnown(provider.tokensPerMinute, soft.tokensPerMinute)
  };
}

export function assessSizeUsage(estimatedInputTokens, limits) {
  return assessRatio(estimatedInputTokens, limits.effectiveInputLimit, {
    warningThreshold: limits.warningThreshold,
    compressionThreshold: limits.compressionThreshold,
    hardStopThreshold: limits.hardStopThreshold,
    normal: "normal",
    warning: "warning",
    compress: "compress",
    stop: "stop"
  });
}

export function assessBudgetUsage(value, budget, thresholds = {}) {
  if (!positiveNumber(budget)) {
    return { status: "unknown", ratio: undefined };
  }
  return assessRatio(value, budget, {
    warningThreshold: clampRatio(thresholds.warningThreshold, DEFAULT_WARNING_THRESHOLD),
    compressionThreshold: clampRatio(thresholds.confirmThreshold, DEFAULT_COMPRESSION_THRESHOLD),
    hardStopThreshold: clampRatio(thresholds.hardStopThreshold, DEFAULT_HARD_STOP_THRESHOLD),
    normal: "normal",
    warning: "warning",
    compress: "confirm",
    stop: "pause"
  });
}

export function hasCoreOverflow(coreTokens, limits) {
  const limit = positiveNumber(limits?.effectiveInputLimit);
  return limit !== undefined && coreTokens > limit;
}

function estimateBaseTokens(value, contentType) {
  if (contentType === "code" || looksLikeCodeOrJson(value)) return value.length / 2 * 1.3;
  const cjk = countCjk(value);
  const nonWhitespace = value.replace(/\s/g, "").length;
  if (nonWhitespace === 0) return 0;
  const cjkRatio = cjk / nonWhitespace;
  if (cjkRatio > 0.6) return value.length * 1.8;
  if (cjkRatio > 0.15) return value.length * 1.3;
  return value.length / 3 * 1.25;
}

function looksLikeCodeOrJson(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) return true;
  return /\b(function|class|const|let|var|return|import|export)\b/.test(value);
}

function countCjk(value) {
  const matches = value.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

function assessRatio(value, limit, labels) {
  const denominator = positiveNumber(limit);
  if (!denominator) return { status: "unknown", ratio: undefined };
  const ratio = Math.max(0, numberOr(value, 0) / denominator);
  if (ratio >= labels.hardStopThreshold) return { status: labels.stop, ratio };
  if (ratio >= labels.compressionThreshold) return { status: labels.compress, ratio };
  if (ratio >= labels.warningThreshold) return { status: labels.warning, ratio };
  return { status: labels.normal, ratio };
}

function minKnown(...values) {
  const known = values.map(positiveNumber).filter((value) => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampRatio(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0.01, Math.min(0.99, value));
}

function calibrationMultiplier(value) {
  const numeric = positiveNumber(value);
  // Never make the existing safety estimate less conservative merely because
  // one provider sample happened to tokenize more efficiently.
  return numeric === undefined ? 1 : Math.max(1, numeric);
}

function normalizeCalibration(value) {
  if (!value || typeof value !== "object") return { status: "unavailable", sampleCount: 0 };
  const sampleCount = Math.max(0, Math.floor(Number(value.sampleCount) || 0));
  return {
    status: sampleCount ? "observed" : "unavailable",
    sampleCount,
    freshestAt: typeof value.freshestAt === "string" ? value.freshestAt : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    model: typeof value.model === "string" ? value.model : ""
  };
}
