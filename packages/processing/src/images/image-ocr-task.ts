import { isDeepStrictEqual } from "node:util";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import {
  ImageOcrPrepareInputSchema,
  OcrInputSchema,
  ReviewRecordSchema,
  fingerprintOcrInput,
  observationIdentity,
  type AcquiredFileRecord,
  type FileAcquireInput,
  type FileAcquireOutcome,
  type FileOcrPlan,
  type ImageOcrPrepareOutcome,
} from "@crawl-automation/v3-contracts";
import { publishOnce } from "../results/publish-once.js";
import { encodeJson, hashString } from "../results/result-record.js";
import type { ReviewLedger } from "../step/kept-review.js";
import { imageFailure } from "./image-errors.js";
import { imageReview } from "./image-review.js";

/** The download step's verified records, read through its own rules (processing never downloads). */
export interface DownloadedFiles {
  /** The verified download record of a file task, or null when there is none. */
  inspect(input: FileAcquireInput, signal: AbortSignal): Promise<AcquiredFileRecord | null>;
  /** Where the download record is kept. */
  evidenceKey(input: FileAcquireInput): string;
  /** The image ID a download of this operation gets. */
  imageId(operationId: string): string;
}

export interface ImageOcrTaskDeps {
  downloads: DownloadedFiles;
  local: ObjectStore;
  remote: ObjectStore;
  reviews: ReviewLedger;
}

const MAX_TASK_BYTES = 65_536;
type Receipt = FileAcquireOutcome | null;

/**
 * Prepares one downloaded image's OCR task and publishes it as evidence. It never downloads, resizes or runs OCR; a
 * failure becomes a Review.
 */
export class ImageOcrTask {
  constructor(private readonly deps: ImageOcrTaskDeps) {}

  async run(raw: unknown, signal: AbortSignal): Promise<ImageOcrPrepareOutcome> {
    const { plan, receipt } = ImageOcrPrepareInputSchema.parse(raw);
    try {
      this.assertSameImage(plan, receipt);
      if (receipt?.status === "review") {
        await this.assertDownloadReview(plan.acquire, receipt);
        return receipt;
      }
      return await this.prepare(plan, receipt, signal);
    } catch (error) {
      return imageReview({ deps: this.deps, input: plan.acquire, plan }, errorCodeOf(error));
    }
  }

  private assertSameImage(plan: FileOcrPlan, receipt: Receipt): void {
    const sameImage = plan.imageId === this.deps.downloads.imageId(plan.acquire.operationId);
    if (!sameImage || (receipt && receipt.operationId !== plan.acquire.operationId)) {
      throw imageFailure("IMAGE.IDENTITY_CONFLICT");
    }
  }

  /** A download Review passes through unchanged, once it is confirmed to be this download's. */
  private async assertDownloadReview(
    input: FileAcquireInput,
    receipt: Extract<FileAcquireOutcome, { status: "review" }>,
  ): Promise<void> {
    const stored = await this.deps.reviews.read(receipt.reviewId);
    if (!stored) {
      throw imageFailure("ACQUIRE.REVIEW_UNVERIFIED");
    }
    const { failure, observation } = ReviewRecordSchema.parse(stored);
    const own =
      failure.operationId === input.operationId &&
      failure.inputFingerprint === input.inputFingerprint &&
      failure.stage === "file.acquire" &&
      failure.code === receipt.code &&
      failure.evidenceKey === receipt.evidenceKey &&
      isDeepStrictEqual(observation, observationIdentity(input));
    if (!own) {
      throw imageFailure("IMAGE.IDENTITY_CONFLICT");
    }
  }

  private async prepare(plan: FileOcrPlan, receipt: Receipt, signal: AbortSignal) {
    const input = plan.acquire;
    const { downloads } = this.deps;
    const record = await downloads.inspect(input, signal);
    if (!record) {
      throw imageFailure("ACQUIRE.NOT_DURABLE");
    }
    const differs =
      receipt?.status === "durable" &&
      (!isDeepStrictEqual(receipt.file, record.file) ||
        receipt.evidenceKey !== downloads.evidenceKey(input));
    if (differs) {
      throw imageFailure("IMAGE.IDENTITY_CONFLICT");
    }
    if (record.file.kind !== "source-image") {
      throw imageFailure("IMAGE.PDF_ROUTE_REQUIRED");
    }
    const unsigned = {
      ...observationIdentity(input),
      ...plan.ocr,
      operationId: plan.ocrOperationId,
      file: record.file,
    };
    const task = OcrInputSchema.parse({
      ...unsigned,
      inputFingerprint: fingerprintOcrInput(unsigned, hashString),
    });
    const evidenceKey = `v3/acquisition/${input.operationId}/ocr-${plan.ocrOperationId}.json`;
    await this.publish(
      evidenceKey,
      { schemaVersion: 1, codec: "image-ocr-input/1", plan, acquisition: record, task },
      signal,
    );
    return { status: "prepared" as const, task, evidenceKey };
  }

  private async publish(key: string, value: unknown, signal: AbortSignal): Promise<void> {
    const bytes = encodeJson(value);
    if (bytes.length > MAX_TASK_BYTES) {
      throw imageFailure("ACQUIRE.OUTPUT_LIMIT");
    }
    await publishOnce(
      this.deps,
      { key, bytes, limit: MAX_TASK_BYTES },
      {
        signal,
        mismatch: () => imageFailure("ACQUIRE.HANDOFF_UNVERIFIED"),
        pending: () => imageFailure("ACQUIRE.HANDOFF_PENDING"),
      },
    );
  }
}
