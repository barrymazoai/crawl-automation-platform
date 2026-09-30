import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sha256, verifyBytes, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import {
  PdfCompletionSchema,
  observationIdentity,
  type PdfActivityOutcome,
  type PdfCompletion,
  type PdfInput,
} from "@crawl-automation/v3-contracts";
import { claimOnce } from "../publication/claim-once.js";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { pdfFailure } from "./pdf-errors.js";
import { PdfEvidence, recordPdfReview, type PdfEvidenceDeps } from "./pdf-evidence.js";
import {
  checkedPdfInput,
  pdfAttemptKey,
  pdfCompletionKey,
  pdfPolicy,
  type PdfEngine,
  type PdfPrepared,
} from "./pdf-input.js";
import { assertPdfOutput } from "./pdf-output.js";

const RETENTION_MS = 10_000;
const RECORD_LIMIT = 65_536;

interface Attempt {
  input: PdfInput;
  computed: PdfPrepared | null;
  attemptId: string | null;
}

/**
 * Runs the PDF engine once for one task: claims the task in R2, runs the engine on the durable PDF, keeps the result
 * locally, then publishes it. Any failure becomes a Review; the engine is never run twice.
 */
export class PdfStep extends PdfEvidence {
  constructor(
    deps: PdfEvidenceDeps,
    private readonly engine: PdfEngine,
  ) {
    super(deps);
  }

  async run(raw: unknown, signal: AbortSignal): Promise<PdfActivityOutcome> {
    const attempt: Attempt = { input: checkedPdfInput(raw), computed: null, attemptId: null };
    const { input } = attempt;
    try {
      const prior = await this.inspect(input, signal);
      return durable(input, prior ?? (await this.execute(attempt, signal)));
    } catch (error) {
      const finished = await this.finishedMeanwhile(input);
      if (finished) {
        return durable(input, finished);
      }
      return recordPdfReview(this.deps, {
        input,
        error,
        computed: attempt.computed,
        attemptId: attempt.attemptId,
      });
    }
  }

  private async execute(attempt: Attempt, signal: AbortSignal): Promise<PdfCompletion> {
    const { input } = attempt;
    // The shared intent is permanent: a fresh node never takes over unknown work after a timeout or restart.
    const intent = encodeJson({ schemaVersion: 1, input, nonce: randomUUID() });
    await claimOnce(
      this.deps.remote,
      { key: `pdf-intents/${input.operationId}.json`, bytes: intent },
      {
        signal,
        createFailed: () => pdfFailure("PDF.INTENT_UNKNOWN"),
        exists: () => pdfFailure("PDF.EXECUTION_UNKNOWN"),
        unverified: () => pdfFailure("PDF.INTENT_UNKNOWN"),
      },
    );
    const source = await this.durableSource(input, signal);
    const onAttempt = (attemptId: string) => this.recordAttempt(attempt, attemptId, signal);
    attempt.computed = await this.engine.run({ input, source, onAttempt }, signal);
    const record = PdfCompletionSchema.parse({
      schemaVersion: 1,
      codec: "pdf-completion/1",
      input,
      manifest: attempt.computed.manifest,
      artifact: attempt.computed.artifact,
    });
    if (!isDeepStrictEqual(attempt.computed.input, input)) {
      throw pdfFailure("PDF.RESULT_INTEGRITY");
    }
    assertPdfOutput(record, attempt.computed.bytes);
    await this.publish(record, attempt.computed.bytes, signal);
    const published = await this.inspect(input, signal);
    if (!published) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    return published;
  }

  /** The PDF must already be durable in R2; local bytes alone cannot prove a handoff between nodes. */
  private async durableSource(input: PdfInput, signal: AbortSignal): Promise<Uint8Array> {
    const source = await this.deps.remote.read(input.pdf.objectKey, input.pdf.byteSize, signal);
    if (!source) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    verifyBytes(input.pdf, source, pdfPolicy.maxInputBytes);
    return source;
  }

  /** The engine's attempt is recorded locally before it runs; an attempt already recorded means it may have run. */
  private async recordAttempt(
    attempt: Attempt,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    attempt.attemptId = attemptId;
    const key = pdfAttemptKey(attempt.input);
    const bytes = encodeJson({ schemaVersion: 1, input: attempt.input, attemptId });
    if ((await this.deps.journal.create(key, bytes, "application/json", signal)) !== "created") {
      throw pdfFailure("PDF.EXECUTION_UNKNOWN");
    }
    const saved = await this.deps.journal.read(key, RECORD_LIMIT, signal);
    if (!saved || sha256(saved) !== sha256(bytes)) {
      throw pdfFailure("PDF.ATTEMPT_UNVERIFIED");
    }
  }

  /** Kept locally (even after a late cancellation), then the output and the record are published once. */
  private async publish(
    record: PdfCompletion,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const retained = encodeJson(record);
    if (retained.length > RECORD_LIMIT) {
      throw pdfFailure("PDF.OUTPUT_LIMIT");
    }
    const key = pdfCompletionKey(record.input);
    const keep = AbortSignal.timeout(RETENTION_MS);
    await writeOnce(
      this.deps.journal,
      { key, bytes: retained },
      { signal: keep, mismatch: () => pdfFailure("PDF.RESULT_INTEGRITY") },
    );
    const resolver = new ArtifactResolver(this.deps.copies, this.deps.remote);
    await resolver.publish(record.artifact, observationIdentity(record.input), bytes, signal);
    try {
      await this.deps.remote.create(key, retained, "application/json", signal);
    } catch {
      // The inspection that follows decides; never a second write.
    }
  }

  private async finishedMeanwhile(input: PdfInput): Promise<PdfCompletion | null> {
    try {
      return await this.inspect(input, AbortSignal.timeout(RETENTION_MS));
    } catch {
      // Whether it finished cannot be shown now; the failure is recorded as a Review instead.
      return null;
    }
  }
}

function durable(input: PdfInput, record: PdfCompletion): PdfActivityOutcome {
  return {
    status: "durable",
    operationId: input.operationId,
    artifact: record.artifact,
    evidenceKey: pdfCompletionKey(input),
  };
}
