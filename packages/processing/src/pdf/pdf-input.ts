import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  PdfInputSchema,
  pdfFingerprintMaterial,
  type ArtifactRef,
  type PdfData,
  type PdfInput,
  type PdfManifest,
} from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import policy from "./pdf-policy.json" with { type: "json" };
import { pdfFailure } from "./pdf-errors.js";

/** The PDF engine's limits and versions. Part of the engine setup's fingerprint: changing one is a new setup. */
export const pdfPolicy = policy;
export const pdfConfigFingerprint: string = sha256(Buffer.from(JSON.stringify(policy)));
export const fingerprintPdfInput = (input: PdfInput): string =>
  hashString(pdfFingerprintMaterial(input));

export const pdfCompletionKey = (input: PdfInput) => `v3/pdf/${input.operationId}/completion.json`;
export const pdfAttemptKey = (input: PdfInput) => `pdf-attempts/${input.operationId}.json`;

/** What the PDF engine returns for one task. */
export interface PdfPrepared {
  input: PdfInput;
  attemptId: string;
  manifest: PdfManifest;
  artifact: ArtifactRef;
  bytes: Uint8Array;
  data?: PdfData | null;
}

/** The PDF engine (the Python worker, run as a bounded local process). Never retried automatically. */
export interface PdfEngine {
  run(
    request: {
      input: PdfInput;
      source: Uint8Array;
      onAttempt: (attemptId: string) => Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<PdfPrepared>;
}

/** The PDF task, for exactly this engine setup and signed by its own fingerprint. */
export function checkedPdfInput(raw: unknown): PdfInput {
  const parsed = PdfInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw pdfFailure("PDF.INVALID_INPUT", parsed.error);
  }
  const input = parsed.data;
  const setup =
    input.implementationVersion === "1" &&
    input.policyVersion === "1" &&
    input.configFingerprint === pdfConfigFingerprint;
  if (!setup) {
    throw pdfFailure("PDF.ENGINE_MISMATCH");
  }
  if (fingerprintPdfInput(input) !== input.inputFingerprint) {
    throw pdfFailure("PDF.INVALID_INPUT");
  }
  if (input.pdf.byteSize > policy.maxInputBytes) {
    throw pdfFailure("PDF.INPUT_INTEGRITY");
  }
  return input;
}
