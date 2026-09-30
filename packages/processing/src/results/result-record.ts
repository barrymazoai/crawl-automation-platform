import { withCause } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { ProcessingInput, RecordCodec, ResultKind, StoredRecord } from "./result-kind.js";

/** The SHA-256 of a string's UTF-8 bytes (task fingerprints, IDs, text digests). */
export const hashString = (value: string) => sha256(Buffer.from(value));

export const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value));
export const decodeJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** A stored record's bytes, parsed; unreadable JSON is an integrity failure like any other damage. */
export function decodeRecord<TRecord>(codec: RecordCodec<TRecord>, bytes: Uint8Array): TRecord {
  let raw: unknown;
  try {
    raw = decodeJson(bytes);
  } catch (error) {
    throw withCause(codec.fail("integrity"), error);
  }
  return codec.parseRecord(raw);
}

/** The hash stored beside a record in the ledger: of its schema-checked JSON. */
export function recordHash(kind: { parseRecord(raw: unknown): unknown }, record: unknown): string {
  return sha256(encodeJson(kind.parseRecord(record)));
}

export interface PreparedRecord<TRecord> {
  record: TRecord;
  bytes: Buffer;
  manifest: Buffer;
}

/** The record for an output: the result file, its completion manifest, and their references. */
export function prepareRecord<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
>(
  kind: ResultKind<TInput, TOutput, TRecord>,
  task: { input: TInput; output: TOutput; storageId: string },
): PreparedRecord<TRecord> {
  const { input, storageId } = task;
  const bytes = encodeJson(kind.parseOutput(input, task.output));
  if (bytes.length > kind.limits.resultBytes) {
    throw kind.fail("outputLimit", "executed");
  }
  const result = artifactRef(kind, { input, file: "result", data: bytes });
  const manifest = encodeJson(kind.manifest(input, result));
  const completion = artifactRef(kind, { input, file: "completion", data: manifest });
  const record = kind.parseRecord({ schemaVersion: 1, storageId, input, result, completion });
  return { record, bytes, manifest };
}

function artifactRef<TInput extends ProcessingInput>(
  kind: Pick<ResultKind<TInput, unknown, StoredRecord<TInput>>, "keys">,
  part: { input: TInput; file: "result" | "completion"; data: Uint8Array },
): ArtifactRef {
  const { input, file, data } = part;
  return {
    schemaVersion: 1,
    artifactId: kind.keys.artifactId(input, file),
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    kind: "result-json",
    mediaType: "application/json",
    sha256: sha256(data),
    byteSize: data.length,
    objectKey: `${kind.keys.prefix(input)}/${file}.json`,
    producer: {
      operationId: input.operationId,
      module: input.module,
      implementationVersion: input.implementationVersion,
    },
  };
}
