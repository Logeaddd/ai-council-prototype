import dns from "node:dns/promises";
import net from "node:net";

const LOCAL_AI_PORTS = new Set([11434, 1234, 8000]);

export async function assertSafeApiBaseUrl(value, options = {}) {
  const parsed = parseApiBaseUrl(value);
  const protocol = parsed.protocol;
  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || (protocol === "https:" ? 443 : 80));

  if (parsed.username || parsed.password) {
    throw unsafeUrlError("credentials are not allowed in API base URLs");
  }
  if (!["https:", "http:"].includes(protocol)) {
    throw unsafeUrlError("only http and https API base URLs are supported");
  }

  const localAllowed =
    isLoopbackHost(hostname) &&
    (options.allowUnsafePrivateNetwork || LOCAL_AI_PORTS.has(port));
  if (protocol === "http:" && !localAllowed) {
    throw unsafeUrlError("plain http is only allowed for approved local model ports");
  }

  if (localAllowed) return trimTrailingSlash(parsed.toString());
  if (options.allowUnsafePrivateNetwork) return trimTrailingSlash(parsed.toString());

  if (isIpLiteral(hostname)) {
    assertPublicAddress(hostname);
    return trimTrailingSlash(parsed.toString());
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const item of addresses) {
    assertPublicAddress(item.address);
  }
  return trimTrailingSlash(parsed.toString());
}

function parseApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw unsafeUrlError("missing API base URL");
  try {
    return new URL(raw);
  } catch {
    throw unsafeUrlError("invalid API base URL");
  }
}

function assertPublicAddress(address) {
  if (isPrivateOrSpecialAddress(address)) {
    throw unsafeUrlError("private, loopback, link-local, and metadata addresses are blocked");
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
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
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
  if (!normalized.startsWith("::ffff:")) return "";
  return normalized.slice("::ffff:".length);
}

function isIpLiteral(hostname) {
  return net.isIP(hostname) !== 0 || Boolean(ipv4FromMappedIpv6(hostname));
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function unsafeUrlError(reason) {
  return new Error(`Blocked unsafe API base URL: ${reason}.`);
}
