import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Keep the previous complete document readable if a process is closed mid-save.
export function writeTextFileAtomically(filePath, content, encoding = "utf8") {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, encoding);
    fs.renameSync(temporaryPath, absolutePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
  return absolutePath;
}
