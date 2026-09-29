import { isDeepStrictEqual } from "node:util";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import {
  OcrInputSchema,
  PdfDataSchema,
  PdfOcrPrepareInputSchema,
  PdfPageOcrPlanSchema,
  PdfPagesPrepareInputSchema,
  ReviewRecordSchema,
  fingerprintOcrInput,
  observationIdentity,
  type PdfActivityOutcome,
  type PdfCompletion,
  type PdfInput,
  type PdfProductPlan,
} from "@crawl-automation/v3-contracts";
import { publishOnce } from "../results/publish-once.js";
import { decodeJson, encodeJson, hashString } from "../results/result-record.js";
import { pdfFailure } from "./pdf-errors.js";
import { PdfEvidence, recordPdfReview, type PdfEvidenceDeps } from "./pdf-evidence.js";
import { checkedPdfInput, fingerprintPdfInput, pdfCompletionKey } from "./pdf-input.js";

const PLAN_LIMIT = 4 * 1024 * 1024;
const RESULT_LIMIT = 32 * 1024 * 1024;
const MAX_PRODUCT_PAGES = 100;

/** Builds page render plans and page OCR tasks from verified PDF results. No engine, OCR or model. */
export class PdfPreparation {
  private readonly evidence: PdfEvidence;

  constructor(private readonly deps: PdfEvidenceDeps) {
    this.evidence = new PdfEvidence(deps);
  }

  /** One render-and-OCR plan per page of an inspected PDF. */
  async pages(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfPagesPrepareInputSchema.parse(raw);
    const input = plan.inspection;
    try {
      const record = await this.resolve(input, receipt, signal);
      if ("status" in record) {
        return record;
      }
      const pages = pagePlans(plan, await this.pageCount(record, signal));
      const clash = pages.some((page) =>
        [page.render.operationId, page.ocrOperationId].includes(input.operationId),
      );
      if (input.operationId === plan.operationId || clash) {
        throw pdfFailure("PDF.IDENTITY_CONFLICT");
      }
      const evidenceKey = `v3/pdf-preparation/${plan.operationId}/pages.json`;
      await this.publish(
        evidenceKey,
        { schemaVersion: 1, plan, inspection: record, pages },
        signal,
      );
      return { status: "planned" as const, pages, evidenceKey };
    } catch (error) {
      return recordPdfReview(this.deps, { input, error });
    }
  }

  /** The OCR task of one rendered page. */
  async ocr(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfOcrPrepareInputSchema.parse(raw);
    const input = plan.render;
    try {
      const record = await this.resolve(input, receipt, signal);
      if ("status" in record) {
        return record;
      }
      if (record.artifact.kind !== "pdf-page" || record.artifact.artifactId !== plan.imageId) {
        throw pdfFailure("PDF.IDENTITY_CONFLICT");
      }
      const unsigned = {
        ...observationIdentity(input),
        ...plan.ocr,
        operationId: plan.ocrOperationId,
        file: record.artifact,
      };
      const task = OcrInputSchema.parse({
        ...unsigned,
        inputFingerprint: fingerprintOcrInput(unsigned, hashString),
      });
      const evidenceKey = `v3/pdf-preparation/${plan.ocrOperationId}/input.json`;
      await this.publish(evidenceKey, { schemaVersion: 1, plan, render: record, task }, signal);
      return { status: "prepared" as const, task, evidenceKey };
    } catch (error) {
      return recordPdfReview(this.deps, { input, error });
    }
  }

  /** The step's receipt: its own verified Review passes through; a result must be durable and match. */
  private async resolve(input: PdfInput, receipt: PdfActivityOutcome | null, signal: AbortSignal) {
    checkedPdfInput(input);
    if (receipt && receipt.operationId !== input.operationId) {
      throw pdfFailure("PDF.IDENTITY_CONFLICT");
    }
    if (receipt?.status === "review") {
      await assertStepReview(this.deps, { input, receipt });
      return receipt;
    }
    const record = await this.evidence.inspect(input, signal);
    if (!record) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    const differs =
      receipt &&
      (receipt.evidenceKey !== pdfCompletionKey(input) ||
        !isDeepStrictEqual(receipt.artifact, record.artifact));
    if (differs) {
      throw pdfFailure("PDF.IDENTITY_CONFLICT");
    }
    return record;
  }

  private async pageCount(record: PdfCompletion, signal: AbortSignal): Promise<number> {
    const bytes = await this.deps.remote.read(
      record.artifact.objectKey,
      record.artifact.byteSize,
      signal,
    );
    if (!bytes) {
      throw pdfFailure("PDF.NOT_DURABLE");
    }
    verifyBytes(record.artifact, bytes, RESULT_LIMIT);
    const data = PdfDataSchema.parse(decodeJson(bytes));
    const pages = data.kind === "inspect" ? data.pages : [];
    if (
      data.kind !== "inspect" ||
      pages.length !== data.pageCount ||
      pages.some((page, index) => page.pageIndex !== index)
    ) {
      throw pdfFailure("PDF.RESULT_INTEGRITY");
    }
    if (data.pageCount > MAX_PRODUCT_PAGES) {
      throw pdfFailure("PDF.PRODUCT_PAGE_LIMIT");
    }
    return data.pageCount;
  }

  private async publish(key: string, value: unknown, signal: AbortSignal): Promise<void> {
    const bytes = encodeJson(value);
    if (bytes.length > PLAN_LIMIT) {
      throw pdfFailure("PDF.OUTPUT_LIMIT");
    }
    await publishOnce(
      { local: this.deps.journal, remote: this.deps.remote },
      { key, bytes, limit: PLAN_LIMIT },
      {
        signal,
        mismatch: () => pdfFailure("PDF.PLAN_CONFLICT"),
        pending: () => pdfFailure("PDF.HANDOFF_PENDING"),
      },
    );
  }
}

function pagePlans(plan: PdfProductPlan, pageCount: number) {
  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const unsigned: PdfInput = {
      ...plan.inspection,
      module: "pdf.render",
      operationId: `${plan.operationId}-render-${pageIndex}`,
      pageIndex,
      scale: plan.scale,
    };
    const render = { ...unsigned, inputFingerprint: fingerprintPdfInput(unsigned) };
    const imageId = `pdf-${render.inputFingerprint}`;
    return PdfPageOcrPlanSchema.parse({
      imageId,
      render,
      ocrOperationId: `${plan.operationId}-ocr-${pageIndex}`,
      ocr: plan.ocr,
    });
  });
}

/** A PDF step Review of exactly this task, at the step's own stage. */
export async function assertStepReview(
  deps: PdfEvidenceDeps,
  at: {
    input: PdfInput;
    receipt: Extract<PdfActivityOutcome, { status: "review" }>;
    stage?: string;
  },
): Promise<void> {
  const { input, receipt } = at;
  const raw = await deps.reviews.read(receipt.reviewId);
  if (!raw) {
    throw pdfFailure("PDF.REVIEW_UNVERIFIED");
  }
  const review = ReviewRecordSchema.parse(raw);
  const { failure } = review;
  const own =
    review.reviewId === receipt.reviewId &&
    failure.code === receipt.code &&
    failure.evidenceKey === receipt.evidenceKey &&
    failure.operationId === input.operationId &&
    failure.inputFingerprint === input.inputFingerprint &&
    failure.stage === (at.stage ?? input.module) &&
    isDeepStrictEqual(review.observation, observationIdentity(input));
  if (!own) {
    throw pdfFailure("PDF.IDENTITY_CONFLICT");
  }
}
