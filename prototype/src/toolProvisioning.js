import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executeCommandTool } from "./commandTools.js";
import { extractArchiveTool } from "./archiveTools.js";
import { assertSafePublicUrl } from "./webTools.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MANIFEST_FILE = ".provisioning.json";
const KNOWN_TOOLS = {
  "7zip": { command: "7z", winget: "7zip.7zip", choco: "7zip", brew: "sevenzip", apt: "p7zip-full" },
  git: { command: "git", winget: "Git.Git", choco: "git", brew: "git", apt: "git" },
  gradle: { command: "gradle", choco: "gradle", scoop: "gradle", brew: "gradle", apt: "gradle" },
  jdk17: { command: "java", winget: "EclipseAdoptium.Temurin.17.JDK", choco: "temurin17", brew: "openjdk@17", apt: "openjdk-17-jdk" },
  libreoffice: { command: "soffice", winget: "TheDocumentFoundation.LibreOffice", choco: "libreoffice-fresh", brew: "--cask libreoffice", apt: "libreoffice" },
  node: { command: "node", winget: "OpenJS.NodeJS.LTS", choco: "nodejs-lts", brew: "node", apt: "nodejs" },
  pandoc: { command: "pandoc", winget: "JohnMacFarlane.Pandoc", choco: "pandoc", brew: "pandoc", apt: "pandoc" },
  python: { command: "python", winget: "Python.Python.3.12", choco: "python312", brew: "python", apt: "python3" }
};

export async function provisionTool(request, options = {}) {
  const groupRoot = resolveGroupRoot(options.groupPath);
  const name = requiredText(request.name || request.toolName || request.query, "tool name");
  const key = normalizeKey(name);
  const known = KNOWN_TOOLS[key] || {};
  const command = requiredText(request.commandName || request.executable || known.command || name, "command name");
  const managedRoot = path.join(groupRoot, "shared", "tools");
  const installRoot = path.join(managedRoot, safeSegment(key || command));
  fs.mkdirSync(installRoot, { recursive: true });
  const prior = readProvisionManifest(installRoot);
  const commandOptions = {
    ...options,
    groupPath: groupRoot,
    commandTimeoutMs: request.timeoutMs || options.toolProvisionTimeoutMs || DEFAULT_TIMEOUT_MS,
    managedToolRoots: [...new Set([managedRoot, ...(options.managedToolRoots || [])])]
  };

  const before = await probeCommand(
    command,
    request.verifyCommand || prior?.verification?.command,
    commandOptions,
    request.executablePath || prior?.executablePath,
    installRoot
  );
  if (before.ok) {
    return provisionResult({
      name,
      command,
      status: "already_available",
      probe: before,
      provenance: prior?.provenance || systemPathProvenance(command)
    });
  }

  const strategy = chooseStrategy(request, known, installRoot);
  if (!strategy.type || strategy.type === "unavailable") {
    throw toolError("tool_source_required", `No automatic source is known for ${name}. Provide manager/packageId, installCommand, or downloadUrl.`);
  }

  let installed;
  let archive;
  if (strategy.type === "download") {
    installed = await downloadArtifact(strategy, commandOptions);
    if (!installed.ok) {
      return provisionResult({ name, command, status: "install_failed", strategy, install: installed, provenance: installed.provenance, ok: false });
    }
    if (strategy.isZip) {
      try {
        archive = extractArchiveTool({
          path: strategy.archiveWorkspacePath,
          destination: strategy.destinationWorkspacePath,
          overwrite: true
        }, { groupPath: groupRoot });
      } catch (error) {
        return provisionResult({
          name,
          command,
          status: "install_failed",
          strategy,
          install: {
            ...installed,
            ok: false,
            code: error.code || "archive_extract_failed",
            error: error.message
          },
          provenance: installed.provenance,
          ok: false
        });
      }
    }
  } else {
    installed = await executeCommandTool({
      tool: "execute_command",
      command: strategy.command,
      cwd: ".",
      shell: strategy.shell,
      timeoutMs: request.timeoutMs || options.toolProvisionTimeoutMs || DEFAULT_TIMEOUT_MS,
      maxOutputBytes: request.maxOutputBytes || options.maxToolProvisionOutputBytes
    }, commandOptions);
    if (!installed.ok) {
      return provisionResult({ name, command, status: "install_failed", strategy, install: installed, provenance: strategy.provenance, ok: false });
    }
  }

  const after = await probeCommand(command, request.verifyCommand, commandOptions, request.executablePath, installRoot);
  const provenance = installed.provenance || strategy.provenance;
  if (after.ok) {
    writeProvisionManifest(installRoot, {
      name,
      command,
      executablePath: request.executablePath || "",
      provenance,
      verification: { command: safeVerificationCommand(request.verifyCommand), verifiedAt: new Date().toISOString() }
    });
  }
  return provisionResult({
    name,
    command,
    status: after.ok ? "installed" : "verification_failed",
    strategy,
    install: installed,
    archive,
    probe: after,
    provenance,
    ok: after.ok
  });
}

function chooseStrategy(request, known, installRoot) {
  if (request.installCommand) {
    return {
      type: "custom_command",
      command: String(request.installCommand),
      shell: request.shell,
      provenance: {
        type: "custom_command",
        integrity: { status: "unverified", reason: "Custom installation commands do not carry a downloadable artifact checksum." }
      }
    };
  }
  if (request.downloadUrl) return downloadStrategy(request, installRoot);
  const manager = normalizeManager(request.manager || preferredManager(known));
  const packageId = String(request.packageId || request.package || known[manager] || "").trim();
  if (!manager || !packageId) return { type: "unavailable" };
  return {
    type: "system_package_manager",
    manager,
    packageId,
    command: managerCommand(manager, packageId),
    shell: platformShell(),
    provenance: {
      type: "system_package_manager",
      manager,
      packageId,
      integrity: { status: "manager_managed", reason: "The platform package manager performed package integrity handling." }
    }
  };
}

function downloadStrategy(request, installRoot) {
  const url = requiredText(request.downloadUrl, "downloadUrl");
  const archiveName = safeSegment(request.fileName || downloadFileName(url) || "tool-download");
  const workspaceRoot = path.resolve(installRoot, "../../..");
  const archivePath = path.join(installRoot, archiveName);
  return {
    type: "download",
    url,
    archiveName,
    archivePath,
    archiveWorkspacePath: path.relative(workspaceRoot, archivePath).replaceAll("\\", "/"),
    destinationWorkspacePath: path.relative(workspaceRoot, installRoot).replaceAll("\\", "/"),
    isZip: /\.zip$/i.test(archiveName),
    expectedSha256: normalizeChecksum(request.sha256 || request.expectedSha256 || request.checksum),
    maxDownloadBytes: clampNumber(request.maxDownloadBytes, DEFAULT_MAX_DOWNLOAD_BYTES, 1024, MAX_DOWNLOAD_BYTES)
  };
}

function downloadFileName(value) {
  try {
    return path.basename(new URL(value).pathname);
  } catch {
    throw toolError("unsafe_download_url", "Download URL is invalid.");
  }
}

async function downloadArtifact(strategy, options) {
  const startedAt = Date.now();
  let currentUrl;
  const redirects = [];
  try {
    currentUrl = await assertSafeDownloadUrl(strategy.url);
    for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
      const pending = beginDownload(currentUrl, options, options.commandTimeoutMs || DEFAULT_TIMEOUT_MS);
      try {
        const response = await pending.response;
        if (isRedirect(response.status) && response.headers.get("location")) {
          if (count >= MAX_REDIRECTS) throw toolError("download_redirect_limit", `Download exceeded ${MAX_REDIRECTS} redirects.`);
          const next = new URL(response.headers.get("location"), currentUrl).toString();
          redirects.push(safeProvenanceUrl(next));
          currentUrl = await assertSafeDownloadUrl(next);
          continue;
        }
        if (!response.ok) throw toolError("download_http_error", `Download returned HTTP ${response.status}.`);
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(contentLength) && contentLength > strategy.maxDownloadBytes) {
          throw toolError("download_too_large", `Download declares ${contentLength} bytes, above the ${strategy.maxDownloadBytes} byte limit.`);
        }
        const written = await writeDownloadedBody(response, strategy.archivePath, strategy.maxDownloadBytes);
        const actualSha256 = written.sha256;
        const integrity = strategy.expectedSha256
          ? actualSha256 === strategy.expectedSha256
            ? { status: "verified", algorithm: "sha256", expected: strategy.expectedSha256, actual: actualSha256 }
            : { status: "mismatch", algorithm: "sha256", expected: strategy.expectedSha256, actual: actualSha256 }
          : { status: "unverified", algorithm: "sha256", actual: actualSha256, reason: "No expected SHA-256 was supplied for this download." };
        const provenance = {
          type: "download",
          requestedUrl: safeProvenanceUrl(strategy.url),
          finalUrl: safeProvenanceUrl(currentUrl),
          redirects,
          transport: new URL(currentUrl).protocol.replace(":", ""),
          contentType: String(response.headers.get("content-type") || ""),
          bytes: written.bytes,
          integrity
        };
        if (integrity.status === "mismatch") {
          safeUnlink(strategy.archivePath);
          return {
            ok: false,
            code: "checksum_mismatch",
            error: "Downloaded SHA-256 does not match the supplied expected SHA-256.",
            durationMs: Date.now() - startedAt,
            provenance
          };
        }
        return {
          ok: true,
          source: "managed_tool_download",
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          archivePath: strategy.archivePath,
          workspaceChanges: { source: "download", status: "completed", complete: true },
          provenance
        };
      } finally {
        pending.dispose();
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: error.code || (error.name === "AbortError" ? "download_timeout" : "download_failed"),
      error: error.name === "AbortError" ? `Download exceeded ${options.commandTimeoutMs || DEFAULT_TIMEOUT_MS}ms.` : (error.message || "Download failed."),
      durationMs: Date.now() - startedAt,
      provenance: {
        type: "download",
        requestedUrl: safeProvenanceUrl(strategy.url),
        finalUrl: currentUrl ? safeProvenanceUrl(currentUrl) : "",
        redirects,
        integrity: { status: "not_downloaded" }
      }
    };
  }
}

function beginDownload(url, options, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    response: fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "AI-Council/0.2 managed-tool-provisioner" }
    }),
    dispose() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

async function writeDownloadedBody(response, targetPath, maxBytes) {
  const temporaryPath = `${targetPath}.part-${process.pid}-${Date.now()}`;
  let handle;
  let bytes = 0;
  const hash = crypto.createHash("sha256");
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    handle = await fs.promises.open(temporaryPath, "w");
    const reader = response.body?.getReader();
    if (!reader) throw toolError("download_empty_body", "Download response has no readable body.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw toolError("download_too_large", `Download exceeded the ${maxBytes} byte limit.`);
      }
      hash.update(value);
      await handle.write(value);
    }
    await handle.close();
    handle = undefined;
    safeUnlink(targetPath);
    fs.renameSync(temporaryPath, targetPath);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (handle) await handle.close();
    safeUnlink(temporaryPath);
    throw error;
  }
}

async function assertSafeDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw toolError("unsafe_download_url", "Download URL is invalid.");
  }
  if (parsed.username || parsed.password) throw toolError("unsafe_download_url", "Download URL credentials are not allowed.");
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed.toString();
  if (parsed.protocol !== "https:") {
    throw toolError("unsafe_download_url", "Tool downloads require HTTPS, except for loopback test servers.");
  }
  try {
    return await assertSafePublicUrl(parsed.toString());
  } catch (error) {
    throw toolError("unsafe_download_url", error.message || "Download URL is not a safe public HTTPS address.");
  }
}

function isLoopbackHost(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function safeProvenanceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeChecksum(value) {
  const checksum = String(value || "").trim().toLowerCase();
  if (!checksum) return "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw toolError("invalid_checksum", "sha256 must be a 64-character hexadecimal digest.");
  return checksum;
}

function writeProvisionManifest(installRoot, value) {
  const manifest = {
    schema: "ai-council.managed-tool-provision.v1",
    updatedAt: new Date().toISOString(),
    name: String(value.name || ""),
    command: String(value.command || ""),
    executablePath: String(value.executablePath || ""),
    provenance: safeProvenance(value.provenance),
    verification: {
      command: safeVerificationCommand(value.verification?.command),
      verifiedAt: String(value.verification?.verifiedAt || "")
    }
  };
  fs.writeFileSync(path.join(installRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function readProvisionManifest(installRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(installRoot, MANIFEST_FILE), "utf8"));
    if (parsed?.schema !== "ai-council.managed-tool-provision.v1") return null;
    return {
      executablePath: String(parsed.executablePath || ""),
      provenance: safeProvenance(parsed.provenance),
      verification: {
        command: safeVerificationCommand(parsed.verification?.command),
        verifiedAt: String(parsed.verification?.verifiedAt || "")
      }
    };
  } catch {
    return null;
  }
}

function safeProvenance(value) {
  const source = value && typeof value === "object" ? value : {};
  const integrity = source.integrity && typeof source.integrity === "object" ? source.integrity : {};
  return {
    type: String(source.type || ""),
    manager: String(source.manager || ""),
    packageId: String(source.packageId || ""),
    requestedUrl: safeProvenanceUrl(source.requestedUrl),
    finalUrl: safeProvenanceUrl(source.finalUrl),
    redirects: Array.isArray(source.redirects) ? source.redirects.map(safeProvenanceUrl).filter(Boolean).slice(0, MAX_REDIRECTS) : [],
    transport: String(source.transport || ""),
    contentType: String(source.contentType || "").slice(0, 240),
    bytes: Math.max(0, Number(source.bytes || 0)),
    integrity: {
      status: String(integrity.status || "unverified"),
      algorithm: String(integrity.algorithm || ""),
      expected: /^[a-f0-9]{64}$/i.test(String(integrity.expected || "")) ? String(integrity.expected).toLowerCase() : "",
      actual: /^[a-f0-9]{64}$/i.test(String(integrity.actual || "")) ? String(integrity.actual).toLowerCase() : "",
      reason: String(integrity.reason || "").slice(0, 400)
    }
  };
}

function systemPathProvenance(command) {
  return { type: "system_path", integrity: { status: "not_applicable", reason: `The ${command} executable was already available on PATH.` } };
}

function safeVerificationCommand(value) {
  return String(value || "").slice(0, 4096);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // A missing partial artifact is already the intended state.
  }
}

async function probeCommand(command, verifyCommand, options, executablePath, installRoot) {
  const explicit = executablePath ? resolveManagedExecutable(installRoot, executablePath) : "";
  const target = explicit || command;
  const check = verifyCommand || (process.platform === "win32"
    ? `& ${quoteCommand(target)} --version`
    : `${quoteCommand(target)} --version`);
  const result = await executeCommandTool({
    tool: "execute_command",
    command: check,
    cwd: ".",
    shell: platformShell(),
    timeoutMs: Math.min(60_000, options.commandTimeoutMs || DEFAULT_TIMEOUT_MS),
    maxOutputBytes: 64 * 1024
  }, options);
  return {
    ok: result.ok,
    command: check,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    error: result.error
  };
}

function preferredManager(known) {
  const order = process.platform === "win32" ? ["winget", "choco", "scoop"] : process.platform === "darwin" ? ["brew"] : ["apt", "brew"];
  return order.find((manager) => known[manager]) || "";
}

function normalizeManager(value) {
  const manager = String(value || "").trim().toLowerCase();
  return ["winget", "choco", "scoop", "brew", "apt"].includes(manager) ? manager : "";
}

function managerCommand(manager, packageId) {
  const id = quoteCommand(packageId);
  if (manager === "winget") return `winget install --id ${id} --exact --silent --accept-package-agreements --accept-source-agreements`;
  if (manager === "choco") return `choco install ${id} -y --no-progress`;
  if (manager === "scoop") return `scoop install ${id}`;
  if (manager === "brew") return `brew install ${packageId}`;
  if (manager === "apt") return `sudo apt-get update && sudo apt-get install -y ${id}`;
  return "";
}

function provisionResult({ name, command, status, strategy, install, archive, probe, provenance, ok = true }) {
  return {
    ok,
    source: "managed_tool_provisioner",
    name,
    command,
    status,
    strategy: strategy ? { type: strategy.type, manager: strategy.manager, packageId: strategy.packageId, url: safeProvenanceUrl(strategy.url) } : undefined,
    provenance: safeProvenance(provenance || strategy?.provenance),
    install: install ? {
      ok: install.ok,
      exitCode: install.exitCode,
      durationMs: install.durationMs,
      stdout: install.stdout,
      stderr: install.stderr,
      code: install.code,
      error: install.error,
      workspaceChanges: install.workspaceChanges
    } : undefined,
    archive: archive ? {
      archivePath: archive.archivePath,
      destinationPath: archive.destinationPath,
      entries: archive.entries,
      extracted: archive.extracted,
      skipped: archive.skipped,
      totalBytes: archive.totalBytes
    } : undefined,
    verification: probe
  };
}

function resolveManagedExecutable(root, value) {
  const candidate = path.resolve(root, String(value || ""));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw toolError("path_escape_denied", "executablePath must stay inside the managed tool directory.");
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync.native(candidate);
    const realRelative = path.relative(root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw toolError("path_escape_denied", "executablePath resolves outside the managed tool directory.");
  }
  return candidate;
}

function resolveGroupRoot(groupPath) {
  if (!groupPath || !fs.existsSync(groupPath)) throw toolError("missing_workspace", "provision_tool requires a group workspace.");
  return fs.realpathSync.native(groupPath);
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function safeSegment(value) {
  return String(value || "tool").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "tool";
}

function platformShell() {
  return process.platform === "win32" ? "powershell" : "sh";
}

function quoteCommand(value) {
  const text = String(value || "");
  return process.platform === "win32" ? `"${text.replace(/"/g, '\\"')}"` : `'${shQuote(text)}'`;
}

function shQuote(value) {
  return String(value || "").replace(/'/g, "'\\''");
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw toolError("missing_value", `provision_tool requires ${name}.`);
  return text;
}

function toolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
