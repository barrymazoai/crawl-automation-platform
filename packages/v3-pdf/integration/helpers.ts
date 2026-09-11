import { sha256 } from "@crawl-automation/v3-artifacts";
import type { PdfInput } from "@crawl-automation/v3-contracts";
import { fingerprintPdfInput, pdfConfigFingerprint } from "../src/index.js";

export function inputFor(bytes: Uint8Array, module: PdfInput["module"], id = "test", pageIndex = 0, scale = 1): PdfInput {
  const base = { schemaVersion: 1 as const, requestId: "request", observationId: "observation", brandId: "brand", sourceId: "source", listingId: "listing", variantId: null,
    operationId: id, implementationVersion: "1", policyVersion: "1", configFingerprint: pdfConfigFingerprint, inputFingerprint: "0".repeat(64),
    pdf: { schemaVersion: 1 as const, artifactId: "source-file", observationId: "observation", sourceId: "source", listingId: "listing", variantId: null,
      kind: "source-pdf" as const, mediaType: "application/pdf" as const, sha256: sha256(bytes), byteSize: bytes.length, objectKey: "tests/source.pdf",
      producer: { operationId: "acquisition", module: "file.acquire", implementationVersion: "1" } } };
  const input: PdfInput = module === "pdf.inspect" ? { ...base, module } : module === "pdf.text" ? { ...base, module, pageIndex } : { ...base, module, pageIndex, scale };
  input.inputFingerprint = fingerprintPdfInput(input);
  return input;
}

/** Small valid PDF with xref; no external fonts, downloads, or customer content. */
export function nutritionPdf(pageCount = 1, contentOverride?: string): Buffer {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 501) throw Error("Invalid fixture page count");
  const content = contentOverride ?? "BT /F1 24 Tf 40 340 Td (SYNTHETIC TEST - NOT A PRODUCT) Tj 0 -50 Td /F1 18 Tf (Supplement Facts) Tj 0 -35 Td /F1 12 Tf (Serving size: 1 capsule) Tj 0 -25 Td (Vitamin C: 100 mg) Tj 0 -25 Td (Ingredients: ascorbic acid, cellulose.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, n) => `${n + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /Font << /F1 ${pageCount + 3} 0 R >> >> /Contents ${pageCount + 4} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [n, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${n + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
