import { assertSafePublicUrl } from "./webTools.js";

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

export async function apiRequestTool(request, options = {}) {
  const method = normalizeMethod(request.method);
  const url = await assertSafePublicUrl(request.url, {
    allowHttp: Boolean(options.allowHttp),
    allowUnsafePrivateNetwork: Boolean(options.allowUnsafePrivateNetwork)
  });
  const headers = normalizeHeaders(request.headers);
  const body = buildBody(request, headers);
  const timeoutMs = normalizeTimeoutMs(request.timeoutMs || options.apiRequestTimeoutMs || options.timeoutMs);
  const maxBytes = normalizeMaxBytes(request.maxBytes || options.maxApiResponseBytes);
  const startedAt = Date.now();

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: controller.signal
    });
    const { text, truncated, bytes } = method === "HEAD"
      ? { text: "", truncated: false, bytes: 0 }
      : await readLimitedText(response, maxBytes);
    return {
      ok: response.ok,
      source: "real_api_response",
      method,
      url: safeUrl(url),
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") || "",
      responseHeaders: safeResponseHeaders(response.headers),
      requestHeaders: safeHeaders(headers),
      requestBodyBytes: body ? Buffer.byteLength(String(body), "utf8") : 0,
      durationMs: Date.now() - startedAt,
      bytes,
      truncated,
      text: redactSecrets(text),
      code: response.ok ? undefined : "http_error",
      error: response.ok ? "" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      source: "real_api_response",
      method,
      url: safeUrl(url),
      requestHeaders: safeHeaders(headers),
      requestBodyBytes: body ? Buffer.byteLength(String(body), "utf8") : 0,
      durationMs: Date.now() - startedAt,
      code: error.name === "AbortError" ? "api_request_timeout" : (error.code || "api_request_failed"),
      error: error.name === "AbortError" ? `API request exceeded ${timeoutMs}ms.` : (error.message || "API request failed.")
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function buildBody(request, headers) {
  if (request.json !== undefined && request.json !== "") {
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
    const body = typeof request.json === "string" ? request.json : JSON.stringify(request.json);
    assertBodySize(body);
    return body;
  }
  if (request.body !== undefined && request.body !== "") {
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    assertBodySize(body);
    return body;
  }
  return undefined;
}

function normalizeMethod(value) {
  const method = String(value || "GET").trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw toolError("unsupported_http_method", `Unsupported HTTP method: ${method}`);
  return method;
}

function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!name || /[\r\n:]/.test(name)) continue;
    const val = String(rawValue ?? "");
    if (/[\r\n]/.test(val)) continue;
    headers[name] = val;
  }
  return headers;
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: Buffer.byteLength(text, "utf8") > maxBytes,
      bytes: Buffer.byteLength(text, "utf8")
    };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const allowed = Math.max(0, value.byteLength - (total - maxBytes));
      if (allowed > 0) chunks.push(value.subarray(0, allowed));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), truncated, bytes: total };
}

function safeResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value.slice(0, 500);
  }
  return result;
}

function safeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = /authorization|api[-_]?key|token|secret|cookie/i.test(key) ? "[redacted]" : String(value).slice(0, 500);
  }
  return result;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function assertBodySize(body) {
  if (Buffer.byteLength(String(body), "utf8") > MAX_BODY_BYTES) {
    throw toolError("request_body_too_large", "API request body is too large.");
  }
}

function normalizeTimeoutMs(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(10 * 60 * 1000, Math.floor(count)));
}

function normalizeMaxBytes(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return MAX_RESPONSE_BYTES;
  return Math.max(1024, Math.min(MAX_RESPONSE_BYTES, Math.floor(count)));
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[redacted]")
    .replace(/(token\s*[:=]\s*)[^\s'"]+/gi, "$1[redacted]");
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
