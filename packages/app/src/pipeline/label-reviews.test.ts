import type { LabelPlanInput } from "@crawl-automation/processing";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { describe, expect, it, vi } from "vitest";
import { LabelReviews } from "./label-reviews.js";

const input: LabelPlanInput = {
  operationId: "label-operation",
  owner: {
    schemaVersion: 1,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
  },
  plan: { operationId: "plan", sourceOperationId: "capture", input: {} },
  text: {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/3",
    policyVersion: "label-text/4",
    resultSchemaVersion: 3,
    configFingerprint: "a".repeat(64),
  },
  visionConfigFingerprint: "b".repeat(64),
};
const request = {
  input,
  code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
  states: [{ id: "page", status: "unresolved" }],
};

function setup() {
  const rows = new Map<string, ReviewRecord>();
  const reviews = {
    read: vi.fn(async (id: string) => rows.get(id) ?? null),
    append: vi.fn(async (record: ReviewRecord) => {
      rows.set(record.reviewId, record);
    }),
  };
  const evidence = { publish: vi.fn(async () => undefined) };
  return { rows, reviews, evidence, service: new LabelReviews({ reviews, evidence }) };
}

describe("LabelReviews.review durability and refusal cases", () => {
  it.each(["CHANNEL.LABEL_PREPARATION_UNVERIFIED", "CHANNEL.DEPENDENCY_UNAVAILABLE"])(
    "archives %s before appending and verifies the stored review",
    async (code) => {
      const fake = setup();
      const signal = new AbortController().signal;
      const result = await fake.service.review({ ...request, code }, signal);
      const record = fake.rows.get(result.reviewId);
      expect(record?.failure).toMatchObject({
        code,
        stage: "channel.label-input",
        automaticRetry: false,
      });
      expect(record?.rawError.details).toEqual({ input, states: request.states });
      expect(fake.evidence.publish).toHaveBeenCalledExactlyOnceWith(
        result.evidenceKey,
        Buffer.from(JSON.stringify(record)),
        "application/json",
        signal,
      );
      expect(fake.evidence.publish.mock.invocationCallOrder[0]).toBeLessThan(
        fake.reviews.append.mock.invocationCallOrder[0] ?? 0,
      );
      expect(fake.reviews.read.mock.calls).toEqual([[result.reviewId], [result.reviewId]]);
      expect(result).toMatchObject({
        status: "review",
        automaticRetry: false,
        code,
        operationId: input.operationId,
      });
    },
  );

  it("returns a prior review's original code without publishing or appending again", async () => {
    const fake = setup();
    const first = await fake.service.review(request, AbortSignal.abort());
    expect(
      await fake.service.review(
        { ...request, code: "CHANNEL.DEPENDENCY_UNAVAILABLE" },
        AbortSignal.abort(),
      ),
    ).toEqual(first);
    expect(fake.evidence.publish).toHaveBeenCalledOnce();
    expect(fake.reviews.append).toHaveBeenCalledOnce();
  });

  it("accepts an uncertain append only when read-back proves the write", async () => {
    const fake = setup();
    fake.reviews.append.mockImplementation(async (record) => {
      fake.rows.set(record.reviewId, record);
      throw new Error("acknowledgement lost");
    });
    await expect(fake.service.review(request, new AbortController().signal)).resolves.toMatchObject(
      { status: "review" },
    );
    expect(fake.reviews.append).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "refuses an unreadable review after append (append throws=%s)",
    async (throws) => {
      const fake = setup();
      fake.reviews.append.mockImplementation(async () => {
        if (throws) {
          throw new Error("write failed");
        }
      });
      await expect(
        fake.service.review(request, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "PIPELINE.REVIEW_UNVERIFIED",
        details: { reviewId: expect.stringMatching(/^chl-review-/) },
      });
      expect(fake.evidence.publish).toHaveBeenCalledOnce();
      expect(fake.reviews.append).toHaveBeenCalledOnce();
    },
  );

  it("never appends or retries when archive publication fails", async () => {
    const fake = setup();
    const failure = new Error("archive unverified");
    fake.evidence.publish.mockRejectedValue(failure);
    await expect(fake.service.review(request, new AbortController().signal)).rejects.toBe(failure);
    expect(fake.reviews.append).not.toHaveBeenCalled();
    expect(fake.evidence.publish).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("propagates failure of ledger read %d", async (readNumber) => {
    const fake = setup();
    const failure = new Error("ledger offline");
    if (readNumber === 2) {
      fake.reviews.read.mockResolvedValueOnce(null);
    }
    fake.reviews.read.mockRejectedValueOnce(failure);
    await expect(fake.service.review(request, new AbortController().signal)).rejects.toBe(failure);
    expect(fake.reviews.append).toHaveBeenCalledTimes(readNumber - 1);
  });

  it.each([
    { ...request, code: "UNSUPPORTED" },
    { ...request, states: new Array(101).fill(null) },
    { ...request, failures: [{ sourceId: "page" }] },
    { ...request, input: {} },
    { ...request, input: { ...input, operationId: input.plan.operationId } },
  ])("rejects invalid input before writing: %j", async (raw) => {
    const fake = setup();
    await expect(fake.service.review(raw, new AbortController().signal)).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(fake.reviews.read).not.toHaveBeenCalled();
    expect(fake.evidence.publish).not.toHaveBeenCalled();
  });
});
