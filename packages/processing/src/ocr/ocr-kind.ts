import {
  CompletionSchema,
  OcrOutputSchema,
  OcrRegistrationSchema,
  assertProcessingResultMatches,
  parseOcrInput,
  processingIdentity,
  type ArtifactRef,
  type OcrInput,
  type OcrOutput,
  type OcrRegistration,
} from "@crawl-automation/v3-contracts";
import type { RecordCodec, ResultFailureReason, ResultKind } from "../results/result-kind.js";
import { hashString } from "../results/result-record.js";
import { ocrFailure, type OcrErrorCode } from "./ocr-errors.js";

/** Size limits of stored OCR results. */
export const ocrLimits = {
  /** One OCR result file: larger answers are refused before they are stored. */
  resultBytes: 1_048_576,
  completionBytes: 65_536,
  /** The image, and any stored file read back from R2. */
  sourceBytes: 33_554_432,
  intentBytes: 65_536,
} as const;

/** Where an OCR task's files live, locally and in R2. */
export const ocrKeys = {
  prefix: (input: OcrInput) => `operations/${input.operationId}/${input.inputFingerprint}`,
  journal: (input: OcrInput) => `ocr-completions/${input.operationId}.json`,
  intent: (task: { operationId: string }) => `ocr-intents/${task.operationId}.json`,
};

const failureCodes: Record<ResultFailureReason, OcrErrorCode> = {
  conflict: "RESULT.CONFLICT",
  integrity: "RESULT.INTEGRITY",
  incomplete: "RESULT.INCOMPLETE",
  notYetDurable: "RESULT.NOT_DURABLE",
  unknown: "RESULT.REGISTRATION_UNKNOWN",
  registeredNotDurable: "RESULT.NOT_DURABLE",
  sourceNotDurable: "RESULT.NOT_DURABLE",
  registryUnavailable: "RESULT.REGISTRY_UNAVAILABLE",
  outputLimit: "OCR.OUTPUT_LIMIT",
};

/** An OCR task, checked against its schema and its own fingerprint. */
export const parseOcrTask = (raw: unknown): OcrInput => parseOcrInput(raw, hashString);

/** OCR records in the ledger: schema, the task's fingerprint and size bounds; anything else is an integrity failure. */
export const ocrRecordCodec: RecordCodec<OcrRegistration> = {
  parseRecord: (raw) =>
    guarded(() => {
      const record = OcrRegistrationSchema.parse(raw);
      parseOcrTask(record.input);
      const refs = [record.input.file, record.result, record.completion];
      if (refs.some((ref) => ref.byteSize > ocrLimits.sourceBytes)) {
        throw ocrFailure("RESULT.INTEGRITY");
      }
      return record;
    }),
  fail: (reason, fact) => ocrFailure(failureCodes[reason], fact),
};

/** An OCR result: stored under `operations/`, owned by its task, computed from one image already in R2. */
export const ocrResultKind: ResultKind<OcrInput, OcrOutput, OcrRegistration> = {
  ...ocrRecordCodec,
  keys: {
    prefix: ocrKeys.prefix,
    journal: ocrKeys.journal,
    artifactId: (input, file) => `${file}-${hashString(input.operationId)}`,
  },
  limits: ocrLimits,
  parseInput: parseOcrTask,
  parseOutput: (input, raw) =>
    guarded(() => {
      const output = OcrOutputSchema.parse(raw);
      assertProcessingResultMatches(input, output, "output");
      return output;
    }),
  manifest: ocrManifest,
  evidence: async (input) => ({ refs: [input.file], check: () => undefined }),
};

function ocrManifest(input: OcrInput, result: ArtifactRef) {
  return CompletionSchema.parse({
    ...processingIdentity(input),
    resultKey: result.objectKey,
    resultSha256: result.sha256,
    resultByteSize: result.byteSize,
    complete: true,
  });
}

function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw ocrFailure("RESULT.INTEGRITY", "unknown", error);
  }
}
