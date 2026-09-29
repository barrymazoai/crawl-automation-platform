import { isDeepStrictEqual } from "node:util";
import {
  PageTextPrepareInputSchema,
  ReviewRecordSchema,
  TextInputSchema,
  observationIdentity,
  textFingerprint,
  type PagePrepareInput,
  type PagePrepareOutcome,
  type PageTextPrepareInput,
  type PreparedPageRecord,
} from "@crawl-automation/v3-contracts";
import { encodeJson, hashString } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { pageFailure } from "./page-errors.js";
import type { PageEvidence } from "./page-evidence.js";
import { checkedPageInput } from "./page-input.js";

type Plan = PageTextPrepareInput["plan"];
type PageReview = Extract<PagePrepareOutcome, { status: "review" }>;

const TASK_LIMIT = 65_536;

export const pageTextInputKey = (plan: Plan) => `v3/page-text-inputs/${plan.textOperationId}.json`;

/** The signed text task over a prepared page's full text. It never parses; the page must already be durable. */
export function pageTextTask(plan: Plan, record: PreparedPageRecord) {
  const unsigned = {
    ...observationIdentity(plan.page),
    ...plan.text,
    operationId: plan.textOperationId,
    source: { kind: "prepared" as const, document: record.document },
    range: { start: 0, end: record.textLength },
  };
  return TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashString),
  });
}

/** Turns a prepared page into its text task and publishes the task as evidence; a page Review passes through. */
export class PageTextPreparation {
  constructor(private readonly evidence: PageEvidence) {}

  async run(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PageTextPrepareInputSchema.parse(raw);
    const input = plan.page;
    try {
      checkedPageInput(input);
      if (receipt?.status === "review") {
        await this.assertPageReview(input, receipt);
        return receipt;
      }
      const record = await this.evidence.inspect(input, signal);
      if (!record) {
        throw pageFailure("PAGE.NOT_DURABLE");
      }
      if (receipt && !isDeepStrictEqual(receipt.record, record)) {
        throw pageFailure("PAGE.IDENTITY_CONFLICT");
      }
      const task = pageTextTask(plan, record);
      await this.publish(pageTextInputKey(plan), { plan, record, task }, signal);
      return { status: "prepared" as const, task };
    } catch (error) {
      return this.evidence.review(input, "page.text-input", error);
    }
  }

  private async publish(key: string, candidate: unknown, signal: AbortSignal): Promise<void> {
    const mismatch = () => pageFailure("PAGE.IDENTITY_CONFLICT");
    await writeOnce(
      this.evidence.deps.local,
      { key, bytes: encodeJson(candidate) },
      { signal, mismatch },
    );
    await this.evidence.publish(key, candidate, { limit: TASK_LIMIT, signal });
  }

  /** The page Review must be exactly this page's. */
  private async assertPageReview(input: PagePrepareInput, receipt: PageReview): Promise<void> {
    const saved = await this.evidence.deps.reviews.read(receipt.reviewId);
    if (!saved) {
      throw pageFailure("PAGE.REVIEW_UNVERIFIED");
    }
    const review = ReviewRecordSchema.parse(saved);
    const { failure } = review;
    const own =
      receipt.operationId === input.operationId &&
      review.reviewId === receipt.reviewId &&
      failure.operationId === input.operationId &&
      failure.inputFingerprint === input.inputFingerprint &&
      failure.stage === "page.prepare" &&
      failure.code === receipt.code &&
      failure.evidenceKey === receipt.evidenceKey &&
      isDeepStrictEqual(review.observation, observationIdentity(input));
    if (!own) {
      throw pageFailure("PAGE.IDENTITY_CONFLICT");
    }
  }
}
