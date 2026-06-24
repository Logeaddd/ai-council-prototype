import { estimateMessagesTokens } from "./tokenLimits.js";

const limiters = new Map();

export async function scheduleProviderCall(agent, messages, fn, options = {}) {
  const limits = resolveRateLimits(agent, options);
  if (!limits.rpmLimit && !limits.tpmLimit) return await fn();

  const key = providerRateKey(agent, options);
  const limiter = getLimiter(key, limits, options);
  return await limiter.schedule({
    estimatedTokens: estimateMessagesTokens(messages || []) + Number(options.reservedOutputTokens || agent.tokenLimits?.reservedOutputTokens || 0),
    signal: options.signal,
    fn
  });
}

export function resetRateLimiters() {
  limiters.clear();
}

export function resolveRateLimits(agent = {}, options = {}) {
  const rpmLimit = positiveNumber(agent.rateLimit?.requestsPerMinute)
    ?? positiveNumber(agent.tokenLimits?.requestsPerMinute)
    ?? positiveNumber(agent.providerLimits?.requestsPerMinute)
    ?? positiveNumber(options.requestsPerMinute);
  const tpmLimit = positiveNumber(agent.rateLimit?.tokensPerMinute)
    ?? positiveNumber(agent.tokenLimits?.tokensPerMinute)
    ?? positiveNumber(agent.providerLimits?.tokensPerMinute)
    ?? positiveNumber(options.tokensPerMinute);
  return { rpmLimit, tpmLimit };
}

function getLimiter(key, limits, options) {
  const windowMs = positiveNumber(options.rateWindowMs) ?? positiveNumber(options.windowMs) ?? 60000;
  const now = options.now || (() => Date.now());
  const sleepFn = options.sleep || sleep;
  const existing = limiters.get(key);
  if (existing && existing.compatible(limits, windowMs)) return existing;
  const limiter = new RateLimiter({ ...limits, windowMs, now, sleep: sleepFn });
  limiters.set(key, limiter);
  return limiter;
}

function providerRateKey(agent, options) {
  return options.rateLimitKey
    || agent.rateLimit?.key
    || `${agent.provider || "provider"}:${agent.apiBaseUrl || ""}:${agent.model || ""}:${agent.apiKeyEnv || (agent.apiKey ? "direct-key" : "")}`;
}

class RateLimiter {
  constructor({ rpmLimit, tpmLimit, windowMs, now, sleep }) {
    this.rpmLimit = rpmLimit;
    this.tpmLimit = tpmLimit;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.events = [];
    this.queue = Promise.resolve();
  }

  compatible(limits, windowMs) {
    return this.rpmLimit === limits.rpmLimit
      && this.tpmLimit === limits.tpmLimit
      && this.windowMs === windowMs;
  }

  async schedule(job) {
    const run = this.queue.then(() => this.run(job));
    this.queue = run.catch(() => {});
    return await run;
  }

  async run(job) {
    throwIfAborted(job.signal);
    const waitMs = this.nextWaitMs(job.estimatedTokens);
    if (waitMs > 0) await this.sleep(waitMs, job.signal);
    throwIfAborted(job.signal);
    this.record(job.estimatedTokens);
    return await job.fn();
  }

  nextWaitMs(estimatedTokens) {
    this.prune();
    const waits = [];
    if (this.rpmLimit && this.events.length >= this.rpmLimit) {
      waits.push(this.events[0].time + this.windowMs - this.now());
    }
    if (this.tpmLimit) {
      let tokens = this.events.reduce((sum, event) => sum + event.tokens, 0);
      if (tokens + estimatedTokens > this.tpmLimit) {
        for (const event of this.events) {
          tokens -= event.tokens;
          if (tokens + estimatedTokens <= this.tpmLimit) {
            waits.push(event.time + this.windowMs - this.now());
            break;
          }
        }
        if (tokens + estimatedTokens > this.tpmLimit && this.events.length) {
          waits.push(this.events.at(-1).time + this.windowMs - this.now());
        }
      }
    }
    return Math.max(0, ...waits.filter((value) => Number.isFinite(value)));
  }

  record(estimatedTokens) {
    this.prune();
    this.events.push({ time: this.now(), tokens: Math.max(0, Number(estimatedTokens) || 0) });
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    this.events = this.events.filter((event) => event.time > cutoff);
  }
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
