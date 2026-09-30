import { recordRecovery, verifyBytes } from "@crawl-automation/platform";
import {
  AcquiredFileRecordSchema,
  type AcquiredFileRecord,
  type FileAcquireInput,
} from "@crawl-automation/v3-contracts";
import { fileErrors } from "./file-errors.js";
import {
  acquisitionKey,
  acquiredImageId,
  checkedFileInput,
  fileHash,
  FILE_POLICY,
} from "./file-policy.js";
import { recordFileReview, type FileEvidenceStores } from "./file-review.js";

export const equalFileJson = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

function verifyHandoff(actual: Uint8Array | null, expected: Uint8Array) {
  if (!actual || fileHash(actual) !== fileHash(expected)) {
    throw fileErrors.create("ACQUIRE.HANDOFF_UNVERIFIED");
  }
}

/** Shared read/publication mechanics with no download capability. */
export class FileEvidence {
  constructor(readonly deps: FileEvidenceStores) {}

  async inspect(raw: FileAcquireInput, signal: AbortSignal): Promise<AcquiredFileRecord | null> {
    const input = checkedFileInput(raw);
    const bytes = await this.deps.remote.read(acquisitionKey(input), 65536, signal);
    if (!bytes) {
      return null;
    }
    const record = AcquiredFileRecordSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
    if (
      !equalFileJson(record.input, input) ||
      record.file.artifactId !== acquiredImageId(input.operationId) ||
      record.file.objectKey !== `v3/${input.observationId}/${input.operationId}/source` ||
      (input.expectedSha256 !== null && input.expectedSha256 !== record.file.sha256)
    ) {
      throw fileErrors.create("ACQUIRE.EVIDENCE_CONFLICT");
    }
    const content = await this.deps.remote.read(
      record.file.objectKey,
      record.file.byteSize,
      signal,
    );
    if (!content) {
      throw fileErrors.create("ACQUIRE.NOT_DURABLE");
    }
    verifyBytes(record.file, content, FILE_POLICY.maxBytes);
    return record;
  }

  async publish(key: string, value: unknown, signal: AbortSignal) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 65536) {
      throw fileErrors.create("ACQUIRE.OUTPUT_LIMIT");
    }
    const prior = await this.deps.remote.read(key, 65536, signal);
    if (prior) {
      verifyHandoff(prior, bytes);
      return;
    }
    if (await this.deps.local.read(key, 65536, signal)) {
      throw fileErrors.create("ACQUIRE.HANDOFF_PENDING");
    }
    await this.deps.local.create(key, bytes, "application/json", signal);
    verifyHandoff(await this.deps.local.read(key, 65536, signal), bytes);
    try {
      await this.deps.remote.create(key, bytes, "application/json", signal);
    } catch (error) {
      recordRecovery(error, { operation: "file.publish", key });
    }
    // GET only, even after a lost acknowledgement; never a second PUT.
    verifyHandoff(await this.deps.remote.read(key, 65536, signal), bytes);
  }

  review(failure: Parameters<typeof recordFileReview>[1]) {
    return recordFileReview(this.deps, failure);
  }
}
