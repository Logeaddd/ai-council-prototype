import test from "node:test";
import assert from "node:assert/strict";
import { resetRateLimiters, scheduleProviderCall } from "../src/rateLimiter.js";

test("rate limiter queues calls when RPM limit is reached", async () => {
  resetRateLimiters();
  let clock = 0;
  const waits = [];
  const calls = [];
  const agent = {
    provider: "openai-compatible",
    apiBaseUrl: "mock://rate",
    model: "model",
    rateLimit: { requestsPerMinute: 1, key: "rpm-test" }
  };
  const options = {
    rateWindowMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    }
  };

  await scheduleProviderCall(agent, [{ role: "user", content: "one" }], async () => {
    calls.push(clock);
    return "one";
  }, options);
  await scheduleProviderCall(agent, [{ role: "user", content: "two" }], async () => {
    calls.push(clock);
    return "two";
  }, options);

  assert.deepEqual(calls, [0, 100]);
  assert.deepEqual(waits, [100]);
});

test("rate limiter queues calls when TPM limit is reached", async () => {
  resetRateLimiters();
  let clock = 0;
  const waits = [];
  const calls = [];
  const agent = {
    provider: "openai-compatible",
    apiBaseUrl: "mock://rate",
    model: "model",
    rateLimit: { tokensPerMinute: 10, key: "tpm-test" }
  };
  const options = {
    rateWindowMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    }
  };
  const messages = [{ role: "user", content: "这是一些中文 token" }];

  await scheduleProviderCall(agent, messages, async () => {
    calls.push(clock);
    return "one";
  }, options);
  await scheduleProviderCall(agent, messages, async () => {
    calls.push(clock);
    return "two";
  }, options);

  assert.deepEqual(calls, [0, 100]);
  assert.deepEqual(waits, [100]);
});

test("rate limiter aborts while waiting", async () => {
  resetRateLimiters();
  let clock = 0;
  const controller = new AbortController();
  const agent = {
    provider: "openai-compatible",
    apiBaseUrl: "mock://rate",
    model: "model",
    rateLimit: { requestsPerMinute: 1, key: "abort-test" }
  };
  const options = {
    rateWindowMs: 100,
    now: () => clock,
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
      throw abortError();
    }
  };

  await scheduleProviderCall(agent, [{ role: "user", content: "one" }], async () => "one", options);
  await assert.rejects(() => scheduleProviderCall(agent, [{ role: "user", content: "two" }], async () => "two", options), /aborted/);
});

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
