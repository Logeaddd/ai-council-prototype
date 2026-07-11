import dns from "node:dns/promises";
import net from "node:net";
import { resolveSearchApiKey } from "./capabilityRegistry.js";

const MAX_FETCH_BYTES = 160 * 1024;
const MAX_SEARCH_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 12_000;

export async function fetchPublicUrl(input, options = {}) {
  const url = await assertSafePublicUrl(input, options);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const response = await fetchWithRedirects(url, { timeoutMs, maxBytes, signal: options.signal });
  const text = response.text;
  return {
    ok: true,
    source: "real_response",
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    title: extractTitle(text),
    text: htmlToText(text).slice(0, maxBytes),
    bytes: Buffer.byteLength(text, "utf8"),
    truncated: response.truncated
  };
}

export async function fetchPublicText(input, options = {}) {
  const url = await assertSafePublicUrl(input, options);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const response = await fetchWithRedirects(url, { timeoutMs, maxBytes, signal: options.signal });
  return {
    ok: true,
    source: "real_response",
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    text: response.text,
    bytes: Buffer.byteLength(response.text, "utf8"),
    truncated: response.truncated
  };
}

export async function fetchPublicBuffer(input, options = {}) {
  const url = await assertSafePublicUrl(input, options);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const response = await fetchWithRedirects(url, { timeoutMs, maxBytes, signal: options.signal, binary: true });
  return {
    ok: true,
    source: "real_response",
    url: response.url,
    status: response.status,
    contentType: response.contentType,
    buffer: response.buffer,
    bytes: response.buffer.length,
    truncated: response.truncated
  };
}

export async function searchWeb(query, options = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("Missing search query");
  const apiKey = String(options.apiKey || resolveSearchApiKey({
    env: options.env || process.env,
    appSettings: options.appSettings,
    searchApiKey: options.searchApiKey
  })).trim();
  if (!apiKey) {
    return searchBingHtml(text, options);
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), normalizeTimeoutMs(options.timeoutMs));
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", text);
    url.searchParams.set("count", String(Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(options.count || 5)))));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey
      }
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        source: "real_response",
        provider: "Brave Search",
        status: response.status,
        error: body.slice(0, 500),
        results: []
      };
    }
    const parsed = JSON.parse(body);
    const results = (parsed.web?.results || [])
      .filter((item) => item && typeof item === "object")
      .slice(0, MAX_SEARCH_RESULTS)
      .map((item) => ({
        title: String(item.title || "").trim(),
        url: String(item.url || "").trim(),
        description: String(item.description || item.snippet || "").trim()
      }))
      .filter((item) => item.title || item.url || item.description);
    return {
      ok: true,
      source: "real_response",
      provider: "Brave Search",
      query: text,
      results
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

async function searchBingHtml(query, options = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), normalizeTimeoutMs(options.timeoutMs));
  try {
    const url = new URL(resolveBuiltInSearchUrl(options));
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(options.count || 5)))));
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 AI-Council/0.2"
      }
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        source: "public_html",
        provider: "Bing Web",
        status: response.status,
        error: body.slice(0, 500),
        results: []
      };
    }
    return {
      ok: true,
      source: "public_html",
      provider: "Bing Web",
      query,
      results: parseBingResults(body).slice(0, Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(options.count || 5))))
    };
  } catch (error) {
    return {
      ok: false,
      source: "public_html",
      provider: "Bing Web",
      error: error.message || "Built-in web search failed.",
      results: []
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

function resolveBuiltInSearchUrl(options = {}) {
  const env = options.env || process.env;
  return String(env.AI_COUNCIL_BUILTIN_SEARCH_URL || "https://www.bing.com/search").trim();
}

function parseBingResults(html) {
  const blocks = String(html || "").match(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/gi) || [];
  return blocks
    .map((block) => {
      const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
        || block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const title = htmlToText(linkMatch?.[2] || "");
      const url = decodeHtml(linkMatch?.[1] || "").trim();
      const description = htmlToText(snippetMatch?.[1] || "");
      return { title, url, description };
    })
    .filter((item) => (item.title || item.url || item.description) && /^https?:\/\//i.test(item.url));
}

export async function assertSafePublicUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Blocked unsafe URL: invalid URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Blocked unsafe URL: credentials are not allowed.");
  }
  if (parsed.protocol !== "https:" && !(options.allowHttp && parsed.protocol === "http:")) {
    throw new Error("Blocked unsafe URL: only https URLs are allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (options.allowUnsafePrivateNetwork) return parsed.toString();
  if (isIpLiteral(hostname)) {
    assertPublicAddress(hostname);
    return parsed.toString();
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const item of addresses) {
    assertPublicAddress(item.address);
  }
  return parsed.toString();
}

async function fetchWithRedirects(url, options, redirectsLeft = 3) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "AI-Council/0.2" }
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get("location")) {
      if (redirectsLeft <= 0) throw new Error("Too many redirects");
      const nextUrl = new URL(response.headers.get("location"), url).toString();
      await assertSafePublicUrl(nextUrl);
      return fetchWithRedirects(nextUrl, options, redirectsLeft - 1);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!options.binary && !isTextLike(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    const { buffer, truncated } = await readLimitedBuffer(response, options.maxBytes);
    return {
      url,
      status: response.status,
      contentType,
      ...(options.binary ? { buffer } : { text: buffer.toString("utf8") }),
      truncated
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeout);
  }
}

async function readLimitedText(response, maxBytes) {
  const result = await readLimitedBuffer(response, maxBytes);
  return { text: result.buffer.toString("utf8"), truncated: result.truncated };
}

async function readLimitedBuffer(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer: buffer.subarray(0, maxBytes), truncated: buffer.length > maxBytes };
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
  return { buffer, truncated };
}

function isTextLike(contentType) {
  const value = String(contentType || "").toLowerCase();
  return !value
    || value.includes("text/")
    || value.includes("json")
    || value.includes("xml")
    || value.includes("html")
    || value.includes("markdown");
}

function htmlToText(value) {
  return decodeHtml(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "))
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function extractTitle(value) {
  const match = String(value || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

function normalizeTimeoutMs(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(60_000, Math.floor(count)));
}

function normalizeMaxBytes(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return MAX_FETCH_BYTES;
  return Math.max(1024, Math.min(MAX_FETCH_BYTES, Math.floor(count)));
}

function assertPublicAddress(address) {
  if (isPrivateOrSpecialAddress(address)) {
    throw new Error("Blocked unsafe URL: private, loopback, link-local, and metadata addresses are blocked.");
  }
}

function isPrivateOrSpecialAddress(address) {
  const mapped = ipv4FromMappedIpv6(address);
  if (mapped) return isPrivateOrSpecialIpv4(mapped);
  if (net.isIP(address) === 4) return isPrivateOrSpecialIpv4(address);
  if (net.isIP(address) === 6) return isPrivateOrSpecialIpv6(address);
  return true;
}

function isPrivateOrSpecialIpv4(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrSpecialIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function ipv4FromMappedIpv6(address) {
  const normalized = address.toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : "";
}

function isIpLiteral(hostname) {
  return net.isIP(hostname) !== 0 || Boolean(ipv4FromMappedIpv6(hostname));
}
