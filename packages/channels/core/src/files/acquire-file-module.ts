import { ArtifactResolver, recordRecovery } from "@crawl-automation/platform";
import {
  AcquiredFileRecordSchema,
  FileAcquireInputSchema,
  observationIdentity,
  type AcquiredFileRecord,
  type FileAcquireInput,
  type FileAcquireOutcome,
} from "@crawl-automation/v3-contracts";
import { acquireFile, type FileSource } from "./acquire-file.js";
import { FileEvidence } from "./file-evidence.js";
import { fileErrors } from "./file-errors.js";
import { claimFile } from "./file-intent.js";
import { acquisitionKey, checkedFileInput } from "./file-policy.js";

function receipt(record: AcquiredFileRecord): FileAcquireOutcome {
  return {
    status: "durable",
    operationId: record.input.operationId,
    file: record.file,
    evidenceKey: acquisitionKey(record.input),
  };
}

/** Acquires once, retains the original, verifies its R2 publication, then publishes the completion. */
export class AcquireFileModule {
  constructor(
    private readonly evidence: FileEvidence,
    private readonly source: FileSource,
  ) {}

  async run(raw: unknown, signal: AbortSignal): Promise<FileAcquireOutcome> {
    const input = FileAcquireInputSchema.parse(raw);
    let record: AcquiredFileRecord | null = null;
    try {
      checkedFileInput(input);
      const prior = await this.evidence.inspect(input, signal);
      if (prior) {
        return receipt(prior);
      }
      await claimFile(this.evidence.deps.remote, input, signal);
      const acquired = await acquireFile(input, this.source, signal);
      record = AcquiredFileRecordSchema.parse({
        schemaVersion: 1,
        codec: "acquired-file/1",
        input,
        file: acquired.file,
        dimensions: acquired.dimensions,
        redirects: acquired.redirects,
      });
      await this.publish(record, acquired.bytes, signal);
      const verified = await this.evidence.inspect(input, signal);
      if (!verified) {
        throw fileErrors.create("ACQUIRE.NOT_DURABLE");
      }
      return receipt(verified);
    } catch (error) {
      const verified = await this.completedDespite(input);
      return verified
        ? receipt(verified)
        : this.evidence.review({ input, stage: "file.acquire", error, candidate: record });
    }
  }

  private async publish(record: AcquiredFileRecord, bytes: Uint8Array, signal: AbortSignal) {
    const { copies, remote } = this.evidence.deps;
    // Retain accepted bytes even after late cancellation; no remote writes in this retention step.
    await copies.retain(record.file, bytes, AbortSignal.timeout(10000));
    await new ArtifactResolver(copies, remote).publish(
      record.file,
      observationIdentity(record.input),
      bytes,
      signal,
    );
    await this.evidence.publish(acquisitionKey(record.input), record, signal);
  }

  private async completedDespite(input: FileAcquireInput) {
    try {
      return await this.evidence.inspect(input, AbortSignal.timeout(10000));
    } catch (error) {
      recordRecovery(error, { operation: "file.inspect", operationId: input.operationId });
      return null;
    }
  }
}

/** Read-only receipt verification; no source port, download, PUT or Review mutation. */
export class ResolveAcquiredFile {
  constructor(private readonly evidence: Pick<FileEvidence, "inspect">) {}
  async run(raw: unknown, signal: AbortSignal): Promise<FileAcquireOutcome> {
    const input = FileAcquireInputSchema.parse(raw);
    signal.throwIfAborted();
    const record = await this.evidence.inspect(input, signal);
    signal.throwIfAborted();
    if (!record) {
      throw fileErrors.create("ACQUIRE.NOT_DURABLE");
    }
    return receipt(record);
  }
}
