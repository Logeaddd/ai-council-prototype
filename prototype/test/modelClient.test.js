import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAiCompatiblePayload, callAgent } from "../src/modelClient.js";

test("OpenAI-compatible client retries retryable rate-limit responses", async () => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    if (requestCount === 1) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Recovered." }));
  });
  await listen(server);
  const address = server.address();

  try {
    const text = await callAgent({
      id: "retry-agent",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "secret-test-key",
      model: "runtime-model",
      retry: { maxRetries: 1, backoffMs: 0 }
    }, [{ role: "user", content: "Question" }], { timeoutMs: 1000 });

    assert.equal(requestCount, 2);
    assert.match(text, /Recovered/);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible client does not retry non-retryable errors", async () => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad request" } }));
  });
  await listen(server);
  const address = server.address();

  try {
    await assert.rejects(() => callAgent({
      id: "bad-agent",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "secret-test-key",
      model: "runtime-model",
      retry: { maxRetries: 2, backoffMs: 0 }
    }, [{ role: "user", content: "Question" }], { timeoutMs: 1000 }), /HTTP 400/);

    assert.equal(requestCount, 1);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible client schedules requests through rate limits", async () => {
  let requestCount = 0;
  let clock = 0;
  const waits = [];
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    for await (const _ of req) {
      // Drain request body.
    }
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: `call ${requestCount}` }));
  });
  await listen(server);
  const address = server.address();
  const agent = {
    id: "limited-agent",
    provider: "openai-compatible",
    apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "secret-test-key",
    model: "runtime-model",
    rateLimit: { requestsPerMinute: 1, key: "model-client-rate-test" }
  };
  const options = {
    timeoutMs: 1000,
    rateWindowMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    }
  };

  try {
    await callAgent(agent, [{ role: "user", content: "Question 1" }], options);
    await callAgent(agent, [{ role: "user", content: "Question 2" }], options);

    assert.equal(requestCount, 2);
    assert.deepEqual(waits, [100]);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible payload does not add provider cache metadata by default", () => {
  const messages = [
    { role: "system", content: "Return JSON only." },
    { role: "user", content: "Question: Build it.\n\nRound: 1\n\nMember context:\nStable" }
  ];
  const payload = buildOpenAiCompatiblePayload({}, { model: "runtime-model", messages });

  assert.equal(payload.messages, messages);
  assert.equal(typeof payload.messages[1].content, "string");
});

test("OpenAI-compatible payload can add explicit provider prompt cache block after question", () => {
  const payload = buildOpenAiCompatiblePayload({
    providerPromptCache: {
      enabled: true,
      mode: "content-block-cache-control",
      type: "ephemeral"
    }
  }, {
    model: "runtime-model",
    messages: [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Question: Build it.\n\nRound: 1\n\nMember context:\nVolatile transcript" }
    ]
  });

  assert.equal(payload.messages[0].content, "Return JSON only.");
  assert.equal(payload.messages[1].content[0].text, "Question: Build it.");
  assert.deepEqual(payload.messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.match(payload.messages[1].content[1].text, /^Round: 1/);
});

test("OpenAI-compatible HTTP request keeps default message content as plain string", async () => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = JSON.parse(await readRequestBody(req));
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Plain request accepted." }));
  });
  await listen(server);
  const address = server.address();

  try {
    await callAgent({
      id: "plain-agent",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "secret-test-key",
      model: "runtime-model"
    }, [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Question: Build it.\n\nRound: 1\n\nMember context:\nPlain" }
    ], { timeoutMs: 1000 });

    assert.equal(typeof requestBody.messages[1].content, "string");
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible HTTP request sends cache metadata only when explicitly enabled", async () => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = JSON.parse(await readRequestBody(req));
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "Cached request accepted." }));
  });
  await listen(server);
  const address = server.address();

  try {
    await callAgent({
      id: "cache-agent",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "secret-test-key",
      model: "runtime-model",
      providerPromptCache: {
        enabled: true,
        mode: "content-block-cache-control"
      }
    }, [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Question: Build it.\n\nRound: 1\n\nMember context:\nVolatile" }
    ], { timeoutMs: 1000 });

    assert.equal(requestBody.messages[1].content[0].text, "Question: Build it.");
    assert.deepEqual(requestBody.messages[1].content[0].cache_control, { type: "ephemeral" });
  } finally {
    await close(server);
  }
});

function writeOpenAiStream(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readRequestBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}
