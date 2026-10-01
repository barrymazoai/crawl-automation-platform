import { z } from "zod";
import {
  Sha256Schema,
  VisionInputSchema,
  VisionRecordSchema,
  type ArtifactRef,
  type VisionRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/platform";
import type { RecordCodec, ResultFailureReason } from "../results/result-kind.js";
import { encodeJson, hashString } from "../results/result-record.js";
import { visionFailure, type VisionErrorCode } from "./vision-errors.js";

/**
 * A vision task's files. In R2: the intent, the model's raw answer (`response.json`) and the completion. Locally: the
 * same answer first, the ledger record (`registration.json`) and a failed call's facts (`failure.json`).
 */
export const visionKeys = {
  prefix: (task: VisionTask) => `v3/vision/${task.input.operationId}`,
  intent: (task: VisionTask) => `${visionKeys.prefix(task)}/intent.json`,
  response: (task: VisionTask) => `${visionKeys.prefix(task)}/response.json`,
  registration: (task: VisionTask) => `${visionKeys.prefix(task)}/registration.json`,
  failure: (task: VisionTask) => `${visionKeys.prefix(task)}/failure.json`,
};

export const visionLimits = {
  intentBytes: 1024 * 1024,
  responseBytes: 2 * 1024 * 1024,
  completionBytes: 1024 * 1024,
  failureBytes: 8192,
  imageBytes: 16 * 1024 * 1024,
} as const;

/** One task on one vision setup: its input with the setup's fingerprint. */
export const visionTaskFingerprint = (task: VisionTask) =>
  hashString(JSON.stringify(["vision-input/1", task.input, task.configFingerprint]));

export const VisionIntentSchema = z.strictObject({
  fingerprint: Sha256Schema,
  nonce: z.uuid(),
  input: VisionInputSchema,
});
export const VisionResponseSchema = z.strictObject({
  fingerprint: Sha256Schema,
  raw: z.string().max(250_000),
  sha256: Sha256Schema,
});
export type VisionResponse = z.infer<typeof VisionResponseSchema>;
// `detail` is optional so failure facts written before it existed still read.
export const VisionFailureFileSchema = z.strictObject({
  fingerprint: z.string(),
  code: z.string().regex(/^VISION\.[A-Z_]+$/),
  executionFact: z.enum(["not_executed", "executed", "unknown"]),
  detail: z.string().max(600).optional(),
});

/** The stored answer: the raw model text, its hash, and the task it belongs to. */
export const visionResponse = (task: VisionTask, raw: string): VisionResponse => ({
  fingerprint: visionTaskFingerprint(task),
  raw,
  sha256: hashString(raw),
});

export interface PreparedVisionRecord {
  record: VisionRecord;
  completion: Buffer;
}

/** The ledger record and completion for an accepted answer; everything derives from the task and the answer. */
export function prepareVisionRecord(
  task: VisionTask,
  answer: { bytes: Uint8Array; status: "candidate" | "partial" },
  storageId: string,
): PreparedVisionRecord {
  const version = task.input.extractionProtocol ? 2 : 1;
  const result = visionRef(task, { name: "response", data: answer.bytes });
  const completion = encodeJson({
    schemaVersion: version,
    codec: `vision-completion/${version}`,
    ...task,
    status: answer.status,
    result,
    complete: true,
  });
  const record = VisionRecordSchema.parse({
    schemaVersion: version,
    codec: `vision-result/${version}`,
    storageId,
    ...task,
    status: answer.status,
    result,
    completion: visionRef(task, { name: "completion", data: completion }),
  });
  return { record, completion };
}

export function visionRef(task: VisionTask, file: { name: string; data: Uint8Array }): ArtifactRef {
  const owner = task.input.selection.observation;
  const version = task.input.extractionProtocol ? 2 : 1;
  return {
    schemaVersion: 1,
    artifactId: `vision-${file.name}-${hashString(task.input.operationId)}`,
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: owner.variantId,
    kind: "result-json",
    mediaType: "application/json",
    objectKey: `${visionKeys.prefix(task)}/${file.name}.json`,
    sha256: sha256(file.data),
    byteSize: file.data.length,
    producer: {
      operationId: task.input.operationId,
      module: "codex.vision",
      implementationVersion: `vision/${version}`,
    },
  };
}

const failureCodes: Record<ResultFailureReason, VisionErrorCode> = {
  conflict: "VISION.RESULT_CONFLICT",
  integrity: "VISION.RESULT_INTEGRITY",
  incomplete: "VISION.HANDOFF_PENDING",
  notYetDurable: "VISION.HANDOFF_PENDING",
  unknown: "VISION.HANDOFF_UNKNOWN",
  registeredNotDurable: "VISION.RESULT_NOT_DURABLE",
  sourceNotDurable: "VISION.SOURCE_NOT_DURABLE",
  registryUnavailable: "VISION.REGISTRY_UNAVAILABLE",
  outputLimit: "VISION.OUTPUT_LIMIT",
};

/** Vision records in the shared `processing_result` ledger. */
export const visionRecordCodec: RecordCodec<VisionRecord> = {
  parseRecord: (raw) => {
    try {
      return VisionRecordSchema.parse(raw);
    } catch (error) {
      throw visionFailure("VISION.RESULT_INTEGRITY", "unknown", error);
    }
  },
  fail: (reason, fact) => visionFailure(failureCodes[reason], fact),
};
