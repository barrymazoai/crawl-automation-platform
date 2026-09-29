import { isDeepStrictEqual } from "node:util";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { verifyBytes, type LocalCopies } from "@crawl-automation/v3-artifacts";
import {
  PdfCompletionSchema,
  observationIdentity,
  type PdfActivityOutcome,
  type PdfCompletion,
  type PdfInput,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { keepAndRecordReview, type ReviewLedger } from "../step/kept-review.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import { pdfFailure } from "./pdf-errors.js";
import { checkedPdfInput, pdfCompletionKey, pdfPolicy, type PdfPrepared } from "./pdf-input.js";
import { assertPdfOutput } from "./pdf-output.js";

export interface PdfEvidenceDeps {
  remote: ObjectStore;
  /** This worker's local store: attempts, kept results and Reviews. */
  journal: ObjectStore;
  copies: LocalCopies;
  reviews: ReviewLedger;
}

export type PdfReviewOutcome = Extract<PdfActivityOutcome, { status: "review" }>;

const COMPLETION_LIMIT = 65_536;
const KEPT_CODE = /^(PDF|ARTIFACT)\.[A-Z_]+$/;

/** A PDF result's durable record, checked without the engine, its original node or that node's attempt path. */
export class PdfEvidence {
  constructor(readonly deps: PdfEvidenceDeps) {}

  async inspect(raw: unknown, signal: AbortSignal): Promise<PdfCompletion | null> {
    const input = checkedPdfInput(raw);
    const bytes = await this.deps.remote.read(pdfCompletionKey(input), COMPLETION_LIMIT, signal);
    if (!bytes) {
      return null;
    }
    const record = PdfCompletionSchema.parse(decodeJson(bytes));
    if (!isDeepStrictEqual(record.input, input)) {
      throw pdfFailure("PDF.RESULT_INTEGRITY");
    }
    const source = await this.deps.remote.read(input.pdf.objectKey, input.pdf.byteSize, signal);
    if (!source) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    verifyBytes(input.pdf, source, pdfPolicy.maxInputBytes);
    const limit = Math.min(record.artifact.byteSize, pdfPolicy.maxOutputBytes);
    const result = await this.deps.remote.read(record.artifact.objectKey, limit, signal);
    if (!result) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    assertPdfOutput(record, result);
    return record;
  }
}

export interface PdfReviewCase {
  input: PdfInput;
  error: unknown;
  computed?: PdfPrepared | null;
  attemptId?: string | null;
  /** Set when the text-task preparation failed rather than the engine step. */
  preparation?: { stage: "pdf.text-input"; plan: unknown };
}

/** The Review of a PDF step, kept locally first, with the engine's computed result as its candidate. */
export async function recordPdfReview(
  deps: PdfEvidenceDeps,
  failure: PdfReviewCase,
): Promise<PdfReviewOutcome> {
  const { input } = failure;
  const raw = errorCodeOf(failure.error);
  const code = raw && KEPT_CODE.test(raw) ? raw : "PDF.UNRESOLVED";
  const reviewId = newReviewId("pdf");
  const key = `pdf-reviews/${reviewId}.json`;
  const review = pdfReviewRecord(failure, { reviewId, key, code });
  const unverified = () => pdfFailure("PDF.REVIEW_UNVERIFIED");
  const place = { local: deps.journal, key, reviews: deps.reviews };
  await keepAndRecordReview(review, place, {
    localUnverified: unverified,
    reviewUnverified: unverified,
  });
  const operationId = input.operationId;
  return { status: "review", operationId, code, reviewId, evidenceKey: key, automaticRetry: false };
}

function pdfReviewRecord(
  failure: PdfReviewCase,
  at: { reviewId: string; key: string; code: string },
) {
  const { input, computed, preparation } = failure;
  const attemptId = failure.attemptId ?? null;
  const candidate = computed
    ? {
        input,
        manifest: computed.manifest,
        artifact: computed.artifact,
        attemptId: computed.attemptId,
      }
    : null;
  const plan = preparation ? { plan: preparation.plan } : {};
  return buildStepReview({
    reviewId: at.reviewId,
    task: input,
    observation: observationIdentity(input),
    stage: preparation?.stage ?? input.module,
    category: "ARTIFACT",
    code: at.code,
    fact: "unknown",
    evidenceKey: at.key,
    blockedBy: null,
    error: { name: "PdfFailure", details: { input, attemptId, ...plan } },
    candidate: candidate ? { schema: "pdf-completion/1", value: candidate } : null,
    inspection: { kind: "none" },
  });
}
