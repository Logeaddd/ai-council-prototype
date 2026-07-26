import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicMessagesPayload, buildOpenAiCompatiblePayload, callAgent, callAgentResult } from "../src/modelClient.js";
import { nativeToolDefinitions } from "../src/nativeToolProtocol.js";

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
    }, [{ role: "user", content: "Question" }], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true
    });

    assert.equal(requestCount, 2);
    assert.match(text, /Recovered/);
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible client rejects unsafe metadata and private API base URLs", async () => {
  await assert.rejects(() => callAgent({
    id: "metadata-agent",
    provider: "openai-compatible",
    apiBaseUrl: "http://169.254.169.254/latest",
    apiKey: "secret-test-key",
    model: "runtime-model"
  }, [{ role: "user", content: "Question" }], { timeoutMs: 1000 }), /Blocked unsafe API base URL/);

  await assert.rejects(() => callAgent({
    id: "private-agent",
    provider: "openai-compatible",
    apiBaseUrl: "http://192.168.1.10/v1",
    apiKey: "secret-test-key",
    model: "runtime-model"
  }, [{ role: "user", content: "Question" }], { timeoutMs: 1000 }), /Blocked unsafe API base URL/);
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
    }, [{ role: "user", content: "Question" }], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true
    }), /HTTP 400/);

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
    allowUnsafePrivateNetwork: true,
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
  assert.equal(payload.max_tokens, undefined);
});

test("OpenAI-compatible payload includes configurable max_tokens for Claude-style proxies", () => {
  const payload = buildOpenAiCompatiblePayload({ maxTokens: 1234 }, {
    model: "runtime-model",
    messages: [{ role: "user", content: "Question" }]
  });

  assert.equal(payload.max_tokens, 1234);
});

test("provider payloads do not clamp explicit output limits to 64k", () => {
  const openai = buildOpenAiCompatiblePayload({ maxTokens: 250000 }, {
    model: "runtime-model",
    messages: [{ role: "user", content: "Question" }]
  });
  const anthropic = buildAnthropicMessagesPayload({ maxTokens: 250000 }, {
    model: "claude-test-model",
    messages: [{ role: "user", content: "Question" }]
  });

  assert.equal(openai.max_tokens, 250000);
  assert.equal(anthropic.max_tokens, 250000);
});

test("OpenAI-compatible payload sends reasoning effort only for known OpenAI reasoning models", () => {
  const supported = buildOpenAiCompatiblePayload({
    providerPreset: "openai",
    apiBaseUrl: "https://api.openai.com/v1",
    reasoningEffort: "high"
  }, {
    model: "o3-mini",
    messages: [{ role: "user", content: "Question" }]
  });
  const unsupported = buildOpenAiCompatiblePayload({
    providerPreset: "custom",
    apiBaseUrl: "https://code-plan.site/v1",
    reasoningEffort: "high"
  }, {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Question" }]
  });

  assert.equal(supported.reasoning_effort, "high");
  assert.equal(unsupported.reasoning_effort, undefined);
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
    ], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true
    });

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
    ], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true
    });

    assert.equal(requestBody.messages[1].content[0].text, "Question: Build it.");
    assert.deepEqual(requestBody.messages[1].content[0].cache_control, { type: "ephemeral" });
  } finally {
    await close(server);
  }
});

test("Anthropic official client uses Messages API headers and parses text", async () => {
  let requestBody;
  let requestHeaders;
  let requestUrl;
  const server = http.createServer(async (req, res) => {
    requestUrl = req.url;
    requestHeaders = req.headers;
    requestBody = JSON.parse(await readRequestBody(req));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ status: "skip", reason: "Claude accepted." }) }]
    }));
  });
  await listen(server);
  const address = server.address();

  try {
    const text = await callAgent({
      id: "claude-agent",
      provider: "anthropic-messages",
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "anthropic-test-key",
      model: "claude-test-model"
    }, [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Question: Build it." }
    ], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true
    });

    assert.equal(requestUrl, "/v1/messages");
    assert.equal(requestHeaders["x-api-key"], "anthropic-test-key");
    assert.equal(requestHeaders["anthropic-version"], "2023-06-01");
    assert.equal(requestBody.model, "claude-test-model");
    assert.equal(requestBody.system, "Return JSON only.");
    assert.deepEqual(requestBody.messages, [{ role: "user", content: "Question: Build it." }]);
    assert.match(text, /Claude accepted/);
  } finally {
    await close(server);
  }
});

test("Anthropic payload separates system from user messages", () => {
  const payload = buildAnthropicMessagesPayload({ maxTokens: 123 }, {
    model: "claude-test-model",
    messages: [
      { role: "system", content: "System A" },
      { role: "system", content: "System B" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Question" }
    ]
  });

  assert.equal(payload.model, "claude-test-model");
  assert.equal(payload.system, "System A\n\nSystem B");
  assert.equal(payload.max_tokens, 123);
  assert.deepEqual(payload.messages, [
    { role: "assistant", content: "Previous answer" },
    { role: "user", content: "Question" }
  ]);
});

test("Anthropic payload sends thinking only for supported official Claude models", () => {
  const supported = buildAnthropicMessagesPayload({
    providerPreset: "anthropic",
    apiBaseUrl: "https://api.anthropic.com/v1",
    reasoningEffort: "medium",
    maxTokens: 5000
  }, {
    model: "claude-4-sonnet-20260701",
    messages: [{ role: "user", content: "Question" }]
  });
  const unsupported = buildAnthropicMessagesPayload({
    providerPreset: "custom",
    apiBaseUrl: "https://code-plan.site/v1",
    reasoningEffort: "medium",
    maxTokens: 5000
  }, {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Question" }]
  });

  assert.deepEqual(supported.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(unsupported.thinking, undefined);
});

test("provider payloads include native tool definitions only when requested", () => {
  const nativeTools = nativeToolDefinitions("full");
  const openai = buildOpenAiCompatiblePayload({}, {
    model: "runtime-model",
    messages: [{ role: "user", content: "Question" }],
    nativeTools
  });
  const anthropic = buildAnthropicMessagesPayload({}, {
    model: "claude-test-model",
    messages: [{ role: "user", content: "Question" }],
    nativeTools
  });
  assert.equal(openai.tools.some((item) => item.function.name === "workspace_edit"), true);
  assert.equal(openai.tool_choice, "auto");
  assert.equal(anthropic.tools.some((item) => item.name === "workspace_edit"), true);
  assert.equal(openai.tools.find((item) => item.function.name === "workspace_edit").function.parameters.additionalProperties, false);
});

test("provider payloads continue a native tool exchange in provider order", () => {
  const nativeToolConversation = {
    baseMessageCount: 2,
    turns: [{
      text: "I will create the source file.",
      toolCalls: [{
        id: "call_write",
        name: "workspace_edit",
        arguments: JSON.stringify({ action: "write", path: "shared/app.js", code: "export const value = 1;\n", reason: "Create the source" })
      }],
      toolResults: [{
        id: "call_write",
        tool: "workspace_edit",
        status: "completed",
        result: { ok: true, bytesWritten: 24 }
      }]
    }]
  };
  const messages = [
    { role: "system", content: "System contract" },
    { role: "user", content: "Create the source" },
    { role: "user", content: "Continue from the result." }
  ];
  const openai = buildOpenAiCompatiblePayload({}, {
    model: "runtime-model",
    messages,
    nativeToolConversation
  });
  const anthropic = buildAnthropicMessagesPayload({}, {
    model: "claude-test-model",
    messages,
    nativeToolConversation
  });

  assert.deepEqual(openai.messages.map((item) => item.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal(openai.messages[2].tool_calls[0].function.name, "workspace_edit");
  assert.equal(openai.messages[3].tool_call_id, "call_write");
  assert.match(openai.messages[3].content, /bytesWritten/);
  assert.equal(anthropic.system, "System contract");
  assert.deepEqual(anthropic.messages.map((item) => item.role), ["user", "assistant", "user", "user"]);
  assert.equal(anthropic.messages[1].content[0].type, "text");
  assert.equal(anthropic.messages[1].content[1].type, "tool_use");
  assert.equal(anthropic.messages[2].content[0].type, "tool_result");
  assert.equal(anthropic.messages[2].content[0].tool_use_id, "call_write");
});

test("structured recovery can require a real native tool call", () => {
  const nativeTools = nativeToolDefinitions("full");
  const openai = buildOpenAiCompatiblePayload({}, {
    model: "runtime-model",
    messages: [{ role: "user", content: "Recover with a tool." }],
    nativeTools,
    nativeToolChoice: "required"
  });
  const anthropic = buildAnthropicMessagesPayload({}, {
    model: "claude-test-model",
    messages: [{ role: "user", content: "Recover with a tool." }],
    nativeTools,
    nativeToolChoice: "required"
  });

  assert.equal(openai.tool_choice, "required");
  assert.deepEqual(anthropic.tool_choice, { type: "any" });
});

test("OpenAI-compatible client reconstructs fragmented native tool calls", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_native", function: { name: "ai_council_tool", arguments: '{"tool":"workspace_' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'edit","action":"mkdir","path":"shared/project","reason":"Create folder"}' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await listen(server);
  try {
    const result = await callAgentResult({
      id: "native-openai",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test-key",
      model: "test-model"
    }, [{ role: "user", content: "Create it" }], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true,
      nativeTools: nativeToolDefinitions("full")
    });
    assert.equal(result.text, "");
    assert.equal(result.nativeToolCalls[0].id, "call_native");
    assert.equal(result.nativeToolCalls[0].name, "ai_council_tool");
    assert.match(result.nativeToolCalls[0].arguments, /workspace_edit/);
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
  } finally {
    await close(server);
  }
});

test("OpenAI-compatible client falls back to JSON protocol when tools are rejected", async () => {
  let calls = 0;
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    calls += 1;
    bodies.push(JSON.parse(await readRequestBody(req)));
    if (calls === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tools are not supported" } }));
      return;
    }
    writeOpenAiStream(res, JSON.stringify({ status: "skip", reason: "JSON fallback" }));
  });
  await listen(server);
  try {
    const result = await callAgentResult({
      id: "native-fallback",
      provider: "openai-compatible",
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 }
    }, [{ role: "user", content: "Question" }], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true,
      nativeTools: nativeToolDefinitions("full")
    });
    assert.equal(calls, 2);
    assert.ok(bodies[0].tools);
    assert.equal(bodies[1].tools, undefined);
    assert.match(result.text, /JSON fallback/);
  } finally {
    await close(server);
  }
});

test("Anthropic client returns native tool_use blocks", async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 20, output_tokens: 4 }, content: [{
      type: "tool_use",
      id: "toolu_1",
      name: "ai_council_tool",
      input: { tool: "read_file", path: "README.md", reason: "Inspect project" }
    }] }));
  });
  await listen(server);
  try {
    const result = await callAgentResult({
      id: "native-anthropic",
      provider: "anthropic-messages",
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test-key",
      model: "claude-test"
    }, [{ role: "user", content: "Inspect it" }], {
      timeoutMs: 1000,
      allowUnsafePrivateNetwork: true,
      nativeTools: nativeToolDefinitions("tool")
    });
    assert.equal(result.text, "");
    assert.deepEqual(result.nativeToolCalls[0], {
      id: "toolu_1",
      name: "ai_council_tool",
      input: { tool: "read_file", path: "README.md", reason: "Inspect project" }
    });
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 4, total_tokens: 24 });
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
