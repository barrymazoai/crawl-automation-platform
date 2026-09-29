import { isDeepStrictEqual } from "node:util";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import {
  PdfDataSchema,
  assertArtifactBelongsTo,
  observationIdentity,
  type PdfCompletion,
  type PdfData,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { pdfFailure } from "./pdf-errors.js";
import { pdfPolicy } from "./pdf-input.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const TEXT = /[^ \t\r\n\f\v\u00a0]/u;

/** Throws an integrity failure unless every check holds. */
function assertAll(checks: boolean[]): void {
  if (!checks.every(Boolean)) {
    throw pdfFailure("PDF.RESULT_INTEGRITY");
  }
}

/** A PDF result checked without the engine: its manifest, its file and, for data, its content. */
export function assertPdfOutput(record: PdfCompletion, bytes: Uint8Array): void {
  assertManifest(record);
  verifyBytes(record.artifact, bytes, pdfPolicy.maxOutputBytes);
  if (record.input.module === "pdf.render") {
    assertRenderedPage(record, bytes);
  } else {
    assertData(record, bytes);
  }
}

/** The manifest and the artifact are this task's, from this engine, at the file name the module writes. */
function assertManifest(record: PdfCompletion): void {
  const { input, manifest, artifact } = record;
  const render = input.module === "pdf.render";
  assertArtifactBelongsTo(artifact, observationIdentity(input));
  const objectKey = `v3/${input.observationId}/${input.operationId}/${input.inputFingerprint}/${manifest.filename}`;
  const producer = {
    operationId: input.operationId,
    module: input.module,
    implementationVersion: input.implementationVersion,
  };
  assertAll([
    manifest.operationId === input.operationId,
    manifest.inputFingerprint === input.inputFingerprint,
    manifest.sourceSha256 === input.pdf.sha256,
    manifest.module === input.module,
    manifest.pageIndex === (input.module === "pdf.inspect" ? null : input.pageIndex),
    manifest.scale === (input.module === "pdf.render" ? input.scale : null),
    manifest.filename === (render ? "output.png" : "output.json"),
    manifest.engine.pypdfium2 === pdfPolicy.pypdfium2,
    manifest.engine.pdfium === pdfPolicy.pdfium,
    manifest.engine.pillow === pdfPolicy.pillow,
    artifact.sha256 === manifest.sha256,
    artifact.byteSize === manifest.byteSize,
    artifact.artifactId === `pdf-${input.inputFingerprint}`,
    artifact.objectKey === objectKey,
    isDeepStrictEqual(artifact.producer, producer),
  ]);
}

/** A rendered page is exactly the PNG the manifest describes, within the pixel limit. */
function assertRenderedPage(record: PdfCompletion, bytes: Uint8Array): void {
  const { input, manifest, artifact } = record;
  const png = Buffer.from(bytes);
  const { width, height } = manifest;
  const page = artifact.kind === "pdf-page" ? artifact : null;
  const pageIndex = input.module === "pdf.render" ? input.pageIndex : null;
  assertAll([
    page?.mediaType === "image/png",
    page?.parentArtifactId === input.pdf.artifactId,
    page?.pageIndex === pageIndex,
    width !== null && height !== null && width * height <= pdfPolicy.maxPixels,
    png.length >= 33,
  ]);
  assertAll([
    png.subarray(0, 8).toString("hex") === PNG_SIGNATURE,
    png.readUInt32BE(8) === 13,
    png.toString("ascii", 12, 16) === "IHDR",
    png.readUInt32BE(16) === width,
    png.readUInt32BE(20) === height,
  ]);
}

/** Inspection data lists every page in order; text data is this page's, with a truthful `hasText`, within limits. */
function assertData(record: PdfCompletion, bytes: Uint8Array): void {
  const { input, manifest, artifact } = record;
  assertAll([artifact.kind === "result-json", manifest.width === null, manifest.height === null]);
  const data = PdfDataSchema.parse(decodeJson(bytes));
  if (input.module === "pdf.inspect") {
    assertAll([data.kind === "inspect" && everyPageInOrder(data)]);
    return;
  }
  const pageIndex = input.module === "pdf.text" ? input.pageIndex : null;
  assertAll([data.kind === "text" && truthfulText(data, pageIndex)]);
}

function everyPageInOrder(data: Extract<PdfData, { kind: "inspect" }>): boolean {
  return (
    data.pages.length === data.pageCount &&
    data.pages.every((page, index) => page.pageIndex === index)
  );
}

function truthfulText(data: Extract<PdfData, { kind: "text" }>, pageIndex: number | null): boolean {
  return [
    data.pageIndex === pageIndex,
    data.hasText === TEXT.test(data.text),
    Buffer.byteLength(data.text) <= pdfPolicy.maxTextBytes,
    [...data.text].length <= pdfPolicy.maxTextChars,
  ].every(Boolean);
}
