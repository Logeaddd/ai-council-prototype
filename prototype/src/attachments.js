export const MAX_FILE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 768 * 1024;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function normalizeFileAttachments(value, options = {}) {
  const files = Array.isArray(value) ? value : [];
  const maxFiles = Number(options.maxFiles || MAX_FILE_ATTACHMENTS);
  const maxFileBytes = Number(options.maxFileBytes || MAX_ATTACHMENT_BYTES);
  const maxTotalBytes = Number(options.maxTotalBytes || MAX_TOTAL_ATTACHMENT_BYTES);

  if (files.length > maxFiles) {
    throw new Error(`Too many attached files: ${files.length}/${maxFiles}`);
  }

  let totalBytes = 0;
  const normalized = files.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid attached file at index ${index}`);
    }

    const name = cleanFileName(item.name || item.path || `attachment-${index + 1}`);
    const type = String(item.type || "text/plain").slice(0, 120);
    const content = String(item.content ?? "");
    const localPath = String(item.localPath || item.local_path || "").trim();
    const contentBytes = byteLength(content);
    const declaredBytes = Number(item.sizeBytes || item.size || contentBytes);
    const sizeBytes = Math.max(contentBytes, Number.isFinite(declaredBytes) ? declaredBytes : 0);

    if (!name) throw new Error(`Attached file ${index + 1} has no name`);
    if (CONTROL_CHARS.test(content)) {
      throw new Error(`Attached file ${name} looks like binary data; only text files are supported`);
    }
    if (sizeBytes > maxFileBytes) {
      throw new Error(`Attached file ${name} is too large: ${sizeBytes}/${maxFileBytes} bytes`);
    }

    totalBytes += sizeBytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Attached files are too large in total: ${totalBytes}/${maxTotalBytes} bytes`);
    }

    return {
      name,
      type,
      sizeBytes,
      content,
      truncated: Boolean(item.truncated),
      ...(localPath ? { localPath } : {})
    };
  });

  return normalized;
}

export function formatFileAttachmentsForPrompt(files = []) {
  const normalized = normalizeFileAttachments(files);
  if (!normalized.length) return "";
  return normalized.map((file, index) => {
    const header = [
      `File ${index + 1}: ${file.name}`,
      `Type: ${file.type || "text/plain"}`,
      `Size: ${file.sizeBytes} bytes`,
      file.localPath ? `Local path: ${file.localPath}` : "",
      file.truncated ? "Status: truncated before sending" : "Status: complete text content"
    ].filter(Boolean).join("\n");
    return `${header}\nContent:\n${file.content}`;
  }).join("\n\n---\n\n");
}

function cleanFileName(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim()
    .slice(0, 180);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}
