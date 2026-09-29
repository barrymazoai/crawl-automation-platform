import { verifyBytes } from "@crawl-automation/v3-artifacts";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/platform";
import type { ProcessingInput, ResultEvidence, ResultKind, StoredRecord } from "./result-kind.js";
import { decodeJson } from "./result-record.js";

type Kind<TInput extends ProcessingInput, TOutput> = ResultKind<
  TInput,
  TOutput,
  StoredRecord<TInput>
>;

export interface StoredCheck<TInput extends ProcessingInput, TOutput> {
  store: ObjectStore;
  input: TInput;
  record: StoredRecord<TInput>;
  evidence: ResultEvidence<TOutput>;
}

/**
 * Whether the store holds this record's result and completion, byte-exact, for this task and its evidence.
 * False when either file is missing; an error when they exist but do not match.
 */
export async function holdsVerifiedRecord<TInput extends ProcessingInput, TOutput>(
  kind: Kind<TInput, TOutput>,
  check: StoredCheck<TInput, TOutput>,
  signal: AbortSignal,
): Promise<boolean> {
  const { store, input, record } = check;
  const [result, completion] = await Promise.all([
    store.read(record.result.objectKey, kind.limits.resultBytes, signal),
    store.read(record.completion.objectKey, kind.limits.completionBytes, signal),
  ]);
  if (!result || !completion) {
    return false;
  }
  verifyRef(kind, { ref: record.result, bytes: result, limit: kind.limits.resultBytes });
  verifyRef(kind, {
    ref: record.completion,
    bytes: completion,
    limit: kind.limits.completionBytes,
  });
  check.evidence.check(kind.parseOutput(input, decodeJson(result)));
  const expected = JSON.stringify(kind.manifest(input, record.result));
  if (JSON.stringify(decodeJson(completion)) !== expected) {
    throw kind.fail("integrity");
  }
  return true;
}

/** Every artifact is in R2 with exactly its recorded bytes. Checks all, so a damaged one is always reported. */
export async function allDurable<TInput extends ProcessingInput, TOutput>(
  kind: Kind<TInput, TOutput>,
  sources: { remote: ObjectStore; refs: readonly ArtifactRef[] },
  signal: AbortSignal,
): Promise<boolean> {
  let durable = true;
  for (const ref of sources.refs) {
    const limit = kind.limits.sourceBytes;
    const bytes = await sources.remote.read(ref.objectKey, Math.min(ref.byteSize, limit), signal);
    if (bytes) {
      verifyRef(kind, { ref, bytes, limit });
    } else {
      durable = false;
    }
  }
  return durable;
}

/** Bytes that do not match their reference are an integrity failure of this kind. */
function verifyRef<TInput extends ProcessingInput, TOutput>(
  kind: Kind<TInput, TOutput>,
  stored: { ref: ArtifactRef; bytes: Uint8Array; limit: number },
): void {
  try {
    verifyBytes(stored.ref, stored.bytes, stored.limit);
  } catch {
    throw kind.fail("integrity");
  }
}
