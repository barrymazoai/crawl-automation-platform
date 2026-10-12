import { ChannelRegistry } from "@crawl-automation/channels-core";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { ReviewRequestSchema } from "@crawl-automation/workflows";
import { describe, expect, it, vi } from "vitest";
import { ProductReviews } from "./product-reviews.js";

const request = {
  pipeline: {
    codec: "product-pipeline/1",
    runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
    channel: "swanson",
    url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
    brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    operationId: "capture-review-1",
    queues: { activities: "pipeline", plan: "plan", label: "label" },
    resources: { queue: "resources", activities: {} },
  },
  code: "PIPELINE.PRODUCT_UNRESOLVED",
  causeCode: "RESOURCE.WAIT_LIMIT",
};

function fixture() {
  const saved = new Map<string, ReviewRecord>();
  const reviews = {
    read: vi.fn(async (id: string) => saved.get(id) ?? null),
    append: vi.fn(async (record: ReviewRecord) => {
      saved.set(record.reviewId, record);
    }),
  };
  const evidence = { publish: vi.fn(async () => undefined) };
  const registry = new ChannelRegistry([swansonAdapter]);
  return { reviews, evidence, service: new ProductReviews({ reviews, evidence, registry }) };
}

describe("capture execution facts", () => {
  it("keeps wait expiry's code and not_executed fact in evidence and the Review ledger", async () => {
    const { service, reviews, evidence } = fixture();
    const parsed = ReviewRequestSchema.parse({ ...request, executionFact: "not_executed" });
    const receipt = await service.review(parsed, AbortSignal.timeout(5000));

    expect(receipt.code).toBe("RESOURCE.WAIT_LIMIT");
    const record = reviews.append.mock.calls[0]?.[0];
    expect(record?.failure).toMatchObject({
      code: "RESOURCE.WAIT_LIMIT",
      category: "SCHEDULER",
      executionFact: "not_executed",
      automaticRetry: false,
    });
    expect(record?.rawError.details).toMatchObject({ executionFact: "not_executed" });
    expect(evidence.publish).toHaveBeenCalledWith(
      receipt.evidenceKey,
      Buffer.from(JSON.stringify(record)),
      "application/json",
      expect.anything(),
    );
    expect(await service.review(parsed, AbortSignal.timeout(5000))).toEqual(receipt);
    expect(reviews.append).toHaveBeenCalledOnce();
  });

  it("accepts old requests and leaves their execution fact unknown", async () => {
    const { service, reviews } = fixture();
    await service.review(ReviewRequestSchema.parse(request), AbortSignal.timeout(5000));
    expect(reviews.append.mock.calls[0]?.[0]?.failure.executionFact).toBe("unknown");
    expect(reviews.append.mock.calls[0]?.[0]?.rawError.details).not.toHaveProperty("details");
  });

  it("rejects unsupported execution facts at the activity boundary", () => {
    expect(ReviewRequestSchema.safeParse({ ...request, executionFact: "maybe" }).success).toBe(
      false,
    );
  });
});

it.each([
  {
    causeCode: "DTC.VARIANT_EVIDENCE",
    details: {
      variantId: "website-22",
      code: "DTC.VARIANT_EVIDENCE",
      reason: "Own retained materials missing",
      evidenceKeys: ["retained/variant-22.html"],
    },
  },
  {
    causeCode: "DTC.PRODUCT_SCOPE_UNRESOLVED",
    details: { reason: "citation_not_in_retained_field" },
  },
  {
    causeCode: "DTC.CAPTURE_REVIEW",
    details: { reason: "capture_download_failed", flags: ["image_download_failed: facts.png"] },
  },
])(
  "persists bounded $causeCode details in both the ledger and published JSON",
  async (diagnostics) => {
    const { service, reviews, evidence } = fixture();
    const parsed = ReviewRequestSchema.parse({ ...request, ...diagnostics });
    const receipt = await service.review(parsed, AbortSignal.timeout(5000));
    const record = reviews.append.mock.calls[0]?.[0];
    expect(record?.rawError.details).toMatchObject(diagnostics);
    expect(record?.failure).toMatchObject({ code: diagnostics.causeCode, automaticRetry: false });
    expect(evidence.publish).toHaveBeenCalledExactlyOnceWith(
      receipt.evidenceKey,
      Buffer.from(JSON.stringify(record)),
      "application/json",
      expect.anything(),
    );
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(3000);
  },
);

it("rejects oversized or arbitrary diagnostics at the Review request boundary", () => {
  const maximum = {
    variantId: "v".repeat(200),
    reason: "r".repeat(200),
    code: "c".repeat(200),
    verification: "v".repeat(200),
    evidenceKeys: Array(20).fill("e".repeat(200)),
    flags: Array(20).fill("f".repeat(200)),
  };
  expect(ReviewRequestSchema.safeParse({ ...request, details: maximum }).success).toBe(true);
  for (const details of [
    { reason: "r".repeat(201) },
    { variantId: "v".repeat(201) },
    { code: "c".repeat(201) },
    { verification: "v".repeat(201) },
    { evidenceKeys: Array(21).fill("e") },
    { evidenceKeys: ["e".repeat(201)] },
    { flags: Array(21).fill("f") },
    { html: "full capture" },
  ]) {
    expect(ReviewRequestSchema.safeParse({ ...request, details }).success).toBe(false);
  }
});
