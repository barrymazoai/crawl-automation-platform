import { recordRecovery, sha256 } from "@crawl-automation/platform";
import {
  enrichmentErrors,
  enrichmentHash,
  enrichmentInput,
  enrichmentModelRequest,
  type EnrichmentContent,
} from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  type ReviewRecord,
  type EnrichmentRequest,
  type SharedEnrichmentOutcome,
  type SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";
import { enrichmentRecord } from "./record.js";
import type { EnrichmentDependencies, EnrichmentSource } from "./ports.js";
import { enrichmentReview } from "./review.js";
import { enrichmentAnswer } from "./stored-answer.js";
import { enrichmentKey } from "./evidence.js";

type Prepared = EnrichmentSource & EnrichmentContent;
type PublicationEntry = { inputHash: string; name: "input" | "prompt" | "record"; value: unknown };
type Attempt = {
  executionFact: "not_executed" | "executed" | "unknown";
  candidate: ReviewRecord["candidate"];
  inputKey: string | null;
};

/** Only enrichment changes: a Review never updates or removes a collected formula. */
export class EnrichmentService {
  constructor(private readonly deps: EnrichmentDependencies) {}

  async run(raw: EnrichmentRequest, signal: AbortSignal): Promise<SharedEnrichmentOutcome> {
    const request = EnrichmentRequestSchema.parse(raw);
    const source = await this.source(request, signal);
    const prepared = {
      ...source,
      request,
      ...enrichmentInput(source.collection, source.subject.title, source.subject.websiteVariant),
    };
    const { inputHash, subject } = prepared;
    const attempt: Attempt = { executionFact: "not_executed", candidate: null, inputKey: null };
    try {
      const prior = await this.deps.repository.read(inputHash);
      if (prior) {
        return await this.reuse(prepared, prior, signal);
      }
      const review = await this.deps.reviews.read(`enrich-${inputHash}`);
      if (review) {
        return { status: "review", reviewId: review.reviewId, code: review.failure.code };
      }
      if (!(await this.deps.repository.claim(inputHash, subject))) {
        return {
          status: "pending",
          enrichmentId: inputHash,
          code: enrichmentErrors.code("ENRICH.EXECUTION_PENDING"),
        };
      }
      await this.publish({ inputHash, name: "input", value: prepared }, signal);
      attempt.inputKey = enrichmentKey(inputHash, "input.json");
      signal.throwIfAborted();
      return await this.execute(prepared, signal, attempt);
    } catch (error) {
      return enrichmentReview(this.deps, { subject, inputHash, error, ...attempt });
    }
  }

  /** Infrastructure failures after collection are separate enrichment Reviews as well. */
  async review(request: EnrichmentRequest, error: unknown) {
    const source = await this.source(request, AbortSignal.timeout(20_000));
    const { inputHash } = enrichmentInput(
      source.collection,
      source.subject.title,
      source.subject.websiteVariant,
    );
    return enrichmentReview(this.deps, {
      subject: source.subject,
      inputHash,
      error,
      executionFact: "unknown",
      candidate: null,
      inputKey: null,
    });
  }

  private async source(request: EnrichmentRequest, signal: AbortSignal) {
    const source = await this.deps.repository.source(request);
    if (this.deps.titles) {
      source.subject = await this.deps.titles.read(request, source.subject, signal);
    }
    return source;
  }

  private async execute(prepared: Prepared, signal: AbortSignal, attempt: Attempt) {
    const { inputHash, subject } = prepared;
    const request = enrichmentModelRequest(prepared);
    await this.publish({ inputHash, name: "prompt", value: request }, signal);
    attempt.executionFact = "unknown";
    const response = await this.deps.model.interpret(request, signal);
    attempt.executionFact = "executed";
    // Even invalid output is retained byte-for-byte before decoding.
    const bytes = Buffer.from(response);
    await this.deps.publication.publish(
      enrichmentKey(inputHash, "response.txt"),
      bytes,
      "text/plain",
      signal,
    );
    attempt.candidate = enrichmentAnswer(response);
    const record = enrichmentRecord(prepared, {
      provider: this.deps.model.provider,
      prompt: request.prompt,
      response,
    });
    await this.publish({ inputHash, name: "record", value: record }, signal);
    try {
      await this.deps.repository.register(record);
    } catch (error) {
      recordRecovery(error, { operation: "enrichment.register-readback" });
    }
    const saved = await this.deps.repository.read(inputHash);
    if (enrichmentHash(saved) !== enrichmentHash(record)) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
    await this.deps.repository.attach(subject, inputHash);
    return registered(record, false);
  }

  private async reuse(prepared: Prepared, record: SharedEnrichmentRecord, signal: AbortSignal) {
    const bytes = await this.deps.remote.read(record.evidenceKey, 256_000, signal);
    if (
      !bytes ||
      enrichmentHash(JSON.parse(Buffer.from(bytes).toString())) !== enrichmentHash(record) ||
      record.inputHash !== prepared.inputHash ||
      record.formulaHash !== prepared.formulaHash
    ) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
    await this.verifyResponse(record, signal);
    await this.deps.repository.attach(prepared.subject, prepared.inputHash);
    return registered(record, true);
  }

  private async verifyResponse(record: SharedEnrichmentRecord, signal: AbortSignal) {
    const [response, promptBytes] = await Promise.all([
      this.deps.remote.read(enrichmentKey(record.inputHash, "response.txt"), 65_536, signal),
      this.deps.remote.read(
        enrichmentKey(record.inputHash, "prompt.json"),
        8 * 1024 * 1024,
        signal,
      ),
    ]);
    const prompt = promptBytes ? JSON.parse(Buffer.from(promptBytes).toString()).prompt : null;
    if (
      !response ||
      sha256(response) !== record.responseSha256 ||
      typeof prompt !== "string" ||
      sha256(Buffer.from(prompt)) !== record.promptSha256
    ) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
  }

  private publish(entry: PublicationEntry, signal: AbortSignal) {
    return this.deps.publication.publish(
      enrichmentKey(entry.inputHash, `${entry.name}.json`),
      Buffer.from(JSON.stringify(entry.value)),
      "application/json",
      signal,
    );
  }
}

function registered(record: SharedEnrichmentRecord, reused: boolean): SharedEnrichmentOutcome {
  const { enrichmentId, candidate, variantCode, evidenceKey } = record;
  return { status: "registered", enrichmentId, candidate, variantCode, evidenceKey, reused };
}
