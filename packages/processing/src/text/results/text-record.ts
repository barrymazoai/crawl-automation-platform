import {
  TextOutputSchema,
  TextRecordSchema,
  parseTextInput,
  textIdentity,
  type ArtifactRef,
  type TextInput,
  type TextOutput,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { textFailure } from "../errors.js";
import { textLimits } from "../limits.js";

export const MAX_RESULT_BYTES = textLimits.resultBytes;
export const MAX_COMPLETION_BYTES = textLimits.completionBytes;

export const hashText = (value: string) => sha256(Buffer.from(value));
export const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value));
export const decodeJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** A stored text record, checked against its schema and its task's own fingerprint. */
export function textRecord(raw: unknown): TextRecord {
  const record = TextRecordSchema.parse(raw);
  parseTextInput(record.input, hashText);
  return record;
}

export const hashRecord = (record: unknown) => sha256(encodeJson(textRecord(record)));

/** Where a task's result files live, locally and in R2. */
export const textKeys = {
  journal: (input: TextInput) => `text-completions/${input.operationId}.json`,
  response: (input: TextInput) => `text-responses/${input.operationId}.json`,
  intent: (input: TextInput) => `text-intents/${input.operationId}.json`,
  prefix: (input: TextInput) => `text-operations/${input.operationId}/${input.inputFingerprint}`,
};

/** The output's identity fields are exactly the task's. */
export function isOwnOutput(input: TextInput, output: TextOutput): boolean {
  const identity = textIdentity(input);
  return (Object.keys(identity) as (keyof typeof identity)[]).every(
    (key) => output[key] === identity[key],
  );
}

/** Refuses an output that belongs to another task. */
export function assertOwnOutput(input: TextInput, output: TextOutput): void {
  if (!isOwnOutput(input, output)) {
    throw textFailure("TEXT.RESULT_INTEGRITY", "executed");
  }
}

export interface PreparedRecord {
  record: TextRecord;
  bytes: Buffer;
  manifest: Buffer;
}

/** The record for an output: the result file, its completion manifest, and their references. */
export function prepareRecord(
  input: TextInput,
  output: TextOutput,
  storageId: string,
): PreparedRecord {
  const bytes = encodeJson(TextOutputSchema.parse(output));
  if (bytes.length > MAX_RESULT_BYTES) {
    throw textFailure("TEXT.OUTPUT_LIMIT", "executed");
  }
  const result = artifactRef(input, "result", bytes);
  const manifest = encodeJson(completionManifest(input, result));
  const completion = artifactRef(input, "completion", manifest);
  const record = textRecord({ schemaVersion: 1, storageId, input, result, completion });
  return { record, bytes, manifest };
}

export function completionManifest(input: TextInput, result: ArtifactRef) {
  return {
    ...textIdentity(input),
    resultKey: result.objectKey,
    resultSha256: result.sha256,
    resultByteSize: result.byteSize,
    complete: true,
  };
}

function artifactRef(input: TextInput, suffix: string, data: Uint8Array): ArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: `text-${suffix}-${hashText(input.operationId)}`,
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    kind: "result-json",
    mediaType: "application/json",
    sha256: sha256(data),
    byteSize: data.length,
    objectKey: `${textKeys.prefix(input)}/${suffix}.json`,
    producer: {
      operationId: input.operationId,
      module: input.module,
      implementationVersion: input.implementationVersion,
    },
  };
}
