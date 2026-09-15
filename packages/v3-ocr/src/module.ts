import { randomUUID } from "node:crypto";
import { parseOcrInput, assertOcrCompatibility, observationIdentity, processingIdentity, OcrOutputSchema, ReviewRecordSchema,
  ReviewCodeSchema, type OcrInput, type OcrOutput, type OcrActivityOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, type ArtifactResolver } from "@crawl-automation/v3-artifacts";
import type { OcrResultHandoff, ResultFacts } from "@crawl-automation/v3-results";
import { inspectRegistration, type ReviewWriter, type PrivateReviewReader } from "@crawl-automation/v3-review";
import { OcrIntents } from "./intent.js";
import { OcrError, type OcrProvider } from "./ports.js";

const hash = (text: string) => sha256(Buffer.from(text));
export interface OcrDependencies {
  provider: OcrProvider;
  artifacts: Pick<ArtifactResolver, "resolve">;
  intents: OcrIntents;
  results: Pick<OcrResultHandoff, "inspect" | "capture" | "uploadMissing" | "register">;
  reviews: ReviewWriter & PrivateReviewReader;
  /** "register" (default): this worker writes the ledger. "upload-only": cloud mode, evidence is retained
   * locally and remotely and the Mini receipt step registers it. Reviews then go to a remote store too. */
  mode?: "register" | "upload-only";
}
function registered(input: OcrInput, facts: ResultFacts): OcrActivityOutcome | null {
  if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) return null;
  return { status: "registered", operationId: input.operationId, result: facts.record.result,
    completion: facts.record.completion, resultRegistered: true };
}
function uploaded(input: OcrInput, facts: ResultFacts): OcrActivityOutcome | null {
  if (!facts.artifactDurable || !facts.record) return null;
  return { status: "uploaded", operationId: input.operationId, result: facts.record.result,
    completion: facts.record.completion, resultRegistered: false };
}
export class OcrFileModule {
  constructor(private readonly deps: OcrDependencies) {}
  private get uploadOnly() { return this.deps.mode === "upload-only"; }
  private settled(input: OcrInput, facts: ResultFacts): OcrActivityOutcome | null {
    return registered(input, facts) ?? (this.uploadOnly ? uploaded(input, facts) : null);
  }
  async run(raw: unknown, signal: AbortSignal): Promise<OcrActivityOutcome> {
    let input: OcrInput;
    try { input = parseOcrInput(raw, hash); assertOcrCompatibility(input, this.deps.provider.supported);
      if (input.resultSchemaVersion !== 2) throw new OcrError("OCR.INVALID_INPUT", "not_executed"); }
    catch { throw new OcrError("OCR.INVALID_INPUT", "not_executed"); }
    let fact: "not_executed" | "executed" | "unknown" = "not_executed";
    let output: OcrOutput | null = null;
    try {
      signal.throwIfAborted();
      const prior = await this.deps.results.inspect(input, signal);
      const done = this.settled(input, prior);
      if (done) return done;
      if (prior.record) throw new OcrError("OCR.HANDOFF_INCOMPLETE", "executed");
      const source = await this.deps.artifacts.resolve(input.file, observationIdentity(input), signal);
      const claim = await this.deps.intents.acquire(input, signal);
      fact = "unknown";
      if (!claim.fresh) throw new OcrError("OCR.EXECUTION_UNKNOWN");
      signal.throwIfAborted();
      const rawResponse = await this.deps.provider.recognize(input.file, source.bytes, signal);
      fact = "executed";
      output = OcrOutputSchema.parse({ ...processingIdentity(input), text: rawResponse.text, rawResponse, provider: this.deps.provider.provider });
      // Keep accepted results small enough for a complete passive Review candidate as well.
      if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) {
        output = null;
        throw new OcrError("OCR.OUTPUT_LIMIT", "executed");
      }
      // A late cancellation must not discard an already received result.
      await this.deps.results.capture(input, output, AbortSignal.timeout(10000));
      signal.throwIfAborted();
      const durable = await this.deps.results.uploadMissing(input, signal);
      if (this.uploadOnly) {
        const done = uploaded(input, durable);
        if (!done) throw new OcrError("OCR.HANDOFF_INCOMPLETE", "executed");
        return done;
      }
      const after = await this.deps.results.register(input, signal);
      const success = registered(input, after);
      if (!success) throw new OcrError("OCR.HANDOFF_INCOMPLETE", "executed");
      return success;
    } catch (error) {
      // One read-only reconciliation. Never reacquire, re-upload, re-register or call OCR in this path.
      try {
        const facts = await this.deps.results.inspect(input, AbortSignal.timeout(10000));
        const done = this.settled(input, facts);
        if (done) return done;
      } catch { /* unavailable evidence is not proof of absence */ }
      const code = error instanceof OcrError ? error.code : signal.aborted ? "OCR.CANCELLED" :
        error instanceof Error && "code" in error && ReviewCodeSchema.safeParse(error.code).success ? String(error.code) : "OCR.UNCLASSIFIED";
      if (error instanceof OcrError) fact = error.executionFact;
      const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `ocr-${randomUUID()}`, occurredAt: new Date().toISOString(),
        failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
          inputFingerprint: input.inputFingerprint, stage: "ocr.file", category: code.startsWith("ARTIFACT.") ? "ARTIFACT" : "PROCESSING",
          code, executionFact: fact, evidenceKey: this.deps.intents.key(input), blockedBy: null, automaticRetry: false },
        observation: observationIdentity(input),
        rawError: { name: "OcrStageFailure", message: code, stack: null, details: { code, executionFact: fact } },
        candidate: output ? { schema: `ocr-output/${output.resultSchemaVersion}`, value: output } : null,
        inspection: { kind: "ocr-result", input } });
      await this.appendReview(review);
      return { status: "review", operationId: input.operationId, reviewId: review.reviewId, code,
        evidenceKey: review.failure.evidenceKey, automaticRetry: false };
    }
  }
  private async appendReview(review: ReviewRecord): Promise<void> {
    try { await this.deps.reviews.append(review); }
    catch {
      if (!(await inspectRegistration(this.deps.reviews, review)).registered) throw new OcrError("OCR.REVIEW_UNKNOWN");
    }
    // Confirm even a nominally successful writer via an independent read-only check.
    if (!(await inspectRegistration(this.deps.reviews, review)).registered) throw new OcrError("OCR.REVIEW_UNKNOWN");
  }
}
