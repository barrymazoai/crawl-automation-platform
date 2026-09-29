import { sha256 } from "@crawl-automation/v3-artifacts";
import type {
  ArtifactRef,
  PdfInput,
  PdfTextPlan,
  ReviewRecord,
} from "@crawl-automation/v3-contracts";
import {
  fingerprintPdfInput,
  pdfConfigFingerprint,
  pdfPolicy,
  type PdfEngine,
  type PdfPrepared,
} from "../pdf/pdf-input.js";
import { encodeJson } from "../results/result-record.js";
import { MemoryReviews } from "./memory-ledgers.js";
import { MemoryStore } from "./memory-store.js";

export const PDF_BYTES = Buffer.from("%PDF-1.7\nsynthetic fixture\n%%EOF\n");
export const signal = () => AbortSignal.timeout(10_000);

/** A signed PDF task for the fixture PDF. */
export function pdfTask(module: PdfInput["module"], operationId = "test", pageIndex = 0): PdfInput {
  const base = {
    schemaVersion: 1 as const,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
    operationId,
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: pdfConfigFingerprint,
    inputFingerprint: "0".repeat(64),
    pdf: {
      schemaVersion: 1 as const,
      artifactId: "source-file",
      observationId: "observation",
      sourceId: "source",
      listingId: "listing",
      variantId: null,
      kind: "source-pdf" as const,
      mediaType: "application/pdf" as const,
      sha256: sha256(PDF_BYTES),
      byteSize: PDF_BYTES.length,
      objectKey: "tests/source.pdf",
      producer: { operationId: "acquisition", module: "file.acquire", implementationVersion: "1" },
    },
  };
  const input: PdfInput =
    module === "pdf.inspect"
      ? { ...base, module }
      : module === "pdf.text"
        ? { ...base, module, pageIndex }
        : { ...base, module, pageIndex, scale: 1 };
  return { ...input, inputFingerprint: fingerprintPdfInput(input) };
}

/** A PNG header of the given size: signature and IHDR, enough for the result checks. */
function pngOf(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

/** What a real engine run would write for this task. */
function engineOutput(
  input: PdfInput,
  options: { pages: number; text: string },
): { bytes: Buffer; json: boolean } {
  if (input.module === "pdf.render") {
    return { bytes: pngOf(600, 400), json: false };
  }
  const data =
    input.module === "pdf.inspect"
      ? {
          kind: "inspect",
          pageCount: options.pages,
          pages: Array.from({ length: options.pages }, (_, pageIndex) => ({
            pageIndex,
            widthPoints: 600,
            heightPoints: 400,
          })),
        }
      : {
          kind: "text",
          pageIndex: input.pageIndex,
          text: options.text,
          hasText: /\S/u.test(options.text),
        };
  return { bytes: encodeJson(data), json: true };
}

/** The manifest a real engine run writes beside its output. */
function engineManifest(input: PdfInput, output: { bytes: Buffer; json: boolean }) {
  const render = input.module === "pdf.render";
  return {
    protocolVersion: 1 as const,
    operationId: input.operationId,
    inputFingerprint: input.inputFingerprint,
    sourceSha256: input.pdf.sha256,
    module: input.module,
    pageIndex: input.module === "pdf.inspect" ? null : input.pageIndex,
    scale: input.module === "pdf.render" ? input.scale : null,
    filename: output.json ? ("output.json" as const) : ("output.png" as const),
    sha256: sha256(output.bytes),
    byteSize: output.bytes.length,
    width: render ? 600 : null,
    height: render ? 400 : null,
    engine: { pypdfium2: pdfPolicy.pypdfium2, pdfium: pdfPolicy.pdfium, pillow: pdfPolicy.pillow },
    process: { pid: 1, platform: "test", hardAddressSpaceLimit: false, cpuLimit: false },
    complete: true as const,
  };
}

function prepared(
  input: PdfInput,
  output: { bytes: Buffer; json: boolean },
  attemptId: string,
): PdfPrepared {
  const manifest = engineManifest(input, output);
  const common = {
    schemaVersion: 1 as const,
    artifactId: `pdf-${input.inputFingerprint}`,
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    sha256: manifest.sha256,
    byteSize: manifest.byteSize,
    objectKey: `v3/${input.observationId}/${input.operationId}/${input.inputFingerprint}/${manifest.filename}`,
    producer: {
      operationId: input.operationId,
      module: input.module,
      implementationVersion: input.implementationVersion,
    },
  };
  const page =
    input.module === "pdf.render"
      ? { parentArtifactId: input.pdf.artifactId, pageIndex: input.pageIndex }
      : null;
  const artifact: ArtifactRef = page
    ? { ...common, kind: "pdf-page", mediaType: "image/png", ...page }
    : { ...common, kind: "result-json", mediaType: "application/json" };
  return { input, attemptId, manifest, artifact, bytes: output.bytes };
}

/** A PDF engine stand-in: records its attempt first, then returns well-formed output; counts its runs. */
export function fakePdfEngine(options: { pages?: number; text?: string; failure?: unknown } = {}) {
  const engine = {
    runs: 0,
    async run(request: Parameters<PdfEngine["run"]>[0]): Promise<PdfPrepared> {
      engine.runs++;
      const attemptId = `pdf-attempt${engine.runs}`;
      await request.onAttempt(attemptId);
      if (options.failure) {
        throw options.failure;
      }
      const output = engineOutput(request.input, {
        pages: options.pages ?? 2,
        text: options.text ?? "Supplement Facts\nVitamin C 100 mg",
      });
      return prepared(request.input, output, attemptId);
    },
  };
  return engine;
}

/** PDF evidence stores: R2 with the fixture PDF, a local journal, local copies and a Review ledger. */
export function pdfStores() {
  const remote = new MemoryStore();
  remote.data.set("tests/source.pdf", PDF_BYTES);
  const copies = { read: async () => null, retain: async () => undefined };
  return { remote, journal: new MemoryStore(), copies, reviews: new MemoryReviews() };
}

export function pdfTextPlan(extraction: PdfInput): PdfTextPlan {
  const text = {
    schemaVersion: 1 as const,
    module: "codex.text" as const,
    implementationVersion: "text/1",
    policyVersion: "policy/1",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
  };
  return { extraction, textOperationId: "interpret", text } as PdfTextPlan;
}

export type PdfStores = ReturnType<typeof pdfStores>;
export type { ReviewRecord };
