import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeToolRequests } from "../src/toolRequests.js";
import { verifyCampaignDeliverable } from "../src/realUserHarness.js";

// This is a real local tool-path probe, not a model or real-user acceptance
// run. It intentionally uses a disposable workspace and a public package.
const result = await runDocumentPhysiologyProbe().catch((error) => ({
  ok: false,
  probe: "document_physiology",
  error: String(error?.message || error)
}));

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;

export async function runDocumentPhysiologyProbe() {
  const groupPath = fs.mkdtempSync(path.join(os.tmpdir(), "ai-council-document-physiology-"));
  try {
    const agent = { id: "document-physiology", name: "Document Physiology" };
    const installed = await executeToolRequests({
      permissionTier: "full",
      groupPath,
      agent,
      round: 1,
      requests: [{
        tool: "install_package",
        manager: "pip",
        packageName: "reportlab",
        reason: "Acquire a public document-generation package for a real illustrated PDF."
      }]
    });
    const install = installed.results[0];
    assertToolSuccess(install, "package installation");

    const generated = await executeToolRequests({
      permissionTier: "full",
      groupPath,
      agent,
      round: 2,
      previousResults: installed.results,
      requests: [{
        tool: "run_code",
        language: "python",
        code: pdfGeneratorCode(),
        reason: "Use the acquired document package to create a real multi-page PDF with a raster illustration."
      }]
    });
    const generation = generated.results[0];
    assertToolSuccess(generation, "PDF generation");

    const verification = await verifyCampaignDeliverable({
      kind: "pdf_document",
      file: "deliverables/document-physiology.pdf",
      minimumPages: 2,
      requiresImages: true,
      requiresAcquisition: true
    }, groupPath);
    if (!verification.passed) throw new Error(`PDF verification failed: ${JSON.stringify(verification.checks)}`);

    return {
      ok: true,
      probe: "document_physiology",
      scope: "real_local_tool_path_without_provider",
      package: {
        manager: install.result?.manager,
        name: install.result?.packageName,
        capabilityReferences: install.result?.capabilityReferences || []
      },
      capabilityUsage: generation.capabilityUsage || [],
      verification: verification.checks
    };
  } finally {
    fs.rmSync(groupPath, { recursive: true, force: true });
  }
}

function assertToolSuccess(item, action) {
  if (item?.status === "completed" && item?.result?.ok !== false) return;
  const detail = item?.result?.stderr || item?.result?.error || item?.error || "unknown tool failure";
  throw new Error(`${action} failed: ${detail}`);
}

function pdfGeneratorCode() {
  return [
    "from pathlib import Path",
    "from PIL import Image",
    "from reportlab.pdfgen import canvas",
    "output = Path('deliverables/document-physiology.pdf')",
    "output.parent.mkdir(parents=True, exist_ok=True)",
    "image_path = Path('deliverables/document-physiology-raster.png')",
    "Image.new('RGB', (64, 48), (27, 63, 95)).save(image_path)",
    "pdf = canvas.Canvas(str(output))",
    "pdf.drawString(72, 720, 'AI Council document physiology probe')",
    "pdf.drawImage(str(image_path), 72, 520, width=192, height=144)",
    "pdf.showPage()",
    "pdf.drawString(72, 720, 'Second verified page')",
    "pdf.save()",
    "print(output)"
  ].join("\n");
}
