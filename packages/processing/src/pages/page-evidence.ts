import { isDeepStrictEqual } from "node:util";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { verifyBytes } from "@crawl-automation/platform";
import {
  PageTablesSchema,
  PreparedPageRecordSchema,
  TextDocumentSchema,
  observationIdentity,
  type ArtifactRef,
  type PagePrepareInput,
  type PagePrepareOutcome,
  type PreparedPageRecord,
} from "@crawl-automation/v3-contracts";
import { claimedPublish } from "../publication/claimed-publication.js";
import { decodeJson, encodeJson, hashString } from "../results/result-record.js";
import { keepAndRecordReview, type ReviewLedger } from "../step/kept-review.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import { pageFailure } from "./page-errors.js";
import { checkedPageInput, pageCompletionKey, pagePolicy } from "./page-input.js";

export interface PageEvidenceDeps {
  local: ObjectStore;
  remote: ObjectStore;
  reviews: ReviewLedger;
}

const KEPT_CODE = /^(PAGE|PROCESSING|ARTIFACT|INPUT|RUNTIME)\.[A-Z_]+$/;
const COMPLETION_LIMIT = 65_536;

/** A prepared page's evidence: its captured source, its output files and its Reviews. It never parses. */
export class PageEvidence {
  constructor(readonly deps: PageEvidenceDeps) {}

  /** The captured page, exactly as referenced. */
  async source(input: PagePrepareInput, signal: AbortSignal): Promise<Uint8Array> {
    const bytes = await this.deps.remote.read(input.page.objectKey, pagePolicy.maxBytes, signal);
    if (!bytes) {
      throw pageFailure("PAGE.SOURCE_NOT_DURABLE");
    }
    verifyBytes(input.page, bytes, pagePolicy.maxBytes);
    return bytes;
  }

  /** The durable record of a prepared page, every file checked; null when it was never completed. */
  async inspect(raw: unknown, signal: AbortSignal): Promise<PreparedPageRecord | null> {
    const input = checkedPageInput(raw);
    const bytes = await this.deps.remote.read(pageCompletionKey(input), COMPLETION_LIMIT, signal);
    if (!bytes) {
      return null;
    }
    const record = PreparedPageRecordSchema.parse(decodeJson(bytes));
    if (!isDeepStrictEqual(record.input, input)) {
      throw pageFailure("PAGE.IDENTITY_CONFLICT");
    }
    await this.source(input, signal);
    const document = TextDocumentSchema.parse(
      await this.output(input, { name: "document", ref: record.document }, signal),
    );
    PageTablesSchema.parse(
      await this.output(input, { name: "tables", ref: record.tables }, signal),
    );
    const own =
      isDeepStrictEqual(observationIdentity(document), observationIdentity(input)) &&
      isDeepStrictEqual(document.source, input.page) &&
      document.producer === "page.prepare" &&
      document.pageIndex === null &&
      document.text.length === record.textLength;
    if (!own) {
      throw pageFailure("PAGE.IDENTITY_CONFLICT");
    }
    return record;
  }

  /** Publishes one prepared file to R2 behind a one-shot claim (see claimedPublish). */
  async publish(key: string, value: unknown, entry: { limit: number; signal: AbortSignal }) {
    const bytes = encodeJson(value);
    if (bytes.length > entry.limit) {
      throw pageFailure("PAGE.OUTPUT_LIMIT");
    }
    await claimedPublish(
      this.deps,
      { key, bytes, limit: entry.limit, markerPrefix: "page-publications" },
      {
        signal: entry.signal,
        mismatch: () => pageFailure("PAGE.HANDOFF_UNVERIFIED"),
        pending: () => pageFailure("PAGE.HANDOFF_PENDING"),
        localUnverified: () => pageFailure("PAGE.LOCAL_UNVERIFIED"),
      },
    );
  }

  /** The Review of a page that could not be prepared or turned into a text task, kept locally first. */
  async review(
    input: PagePrepareInput,
    stage: "page.prepare" | "page.text-input",
    error: unknown,
  ): Promise<Extract<PagePrepareOutcome, { status: "review" }>> {
    const raw = errorCodeOf(error);
    const code = raw && KEPT_CODE.test(raw) ? raw : "PAGE.UNRESOLVED";
    const reviewId = newReviewId("page");
    const evidenceKey = `page-reviews/${reviewId}.json`;
    const record = buildStepReview({
      reviewId,
      task: input,
      observation: observationIdentity(input),
      stage,
      category: "PROCESSING",
      code,
      fact: "unknown",
      evidenceKey,
      blockedBy: null,
      error: { name: "PageFailure", details: { input } },
      candidate: null,
      inspection: { kind: "none" },
    });
    const unverified = () => pageFailure("PAGE.REVIEW_UNVERIFIED");
    const place = { local: this.deps.local, key: evidenceKey, reviews: this.deps.reviews };
    await keepAndRecordReview(record, place, {
      localUnverified: unverified,
      reviewUnverified: unverified,
    });
    return {
      status: "review",
      operationId: input.operationId,
      reviewId,
      evidenceKey,
      code,
      automaticRetry: false,
    };
  }

  /** One of the page's output files: named by the task, and byte-exact in R2. */
  private async output(
    input: PagePrepareInput,
    file: { name: "document" | "tables"; ref: ArtifactRef },
    signal: AbortSignal,
  ) {
    const { name, ref } = file;
    const own =
      ref.objectKey === `v3/pages/${input.operationId}/${name}.json` &&
      ref.artifactId === `page-${name}-${hashString(input.operationId)}`;
    if (!own) {
      throw pageFailure("PAGE.IDENTITY_CONFLICT");
    }
    const data = await this.deps.remote.read(ref.objectKey, pagePolicy.maxOutputBytes, signal);
    if (!data) {
      throw pageFailure("PAGE.NOT_DURABLE");
    }
    verifyBytes(ref, data, pagePolicy.maxOutputBytes);
    return decodeJson(data);
  }
}
