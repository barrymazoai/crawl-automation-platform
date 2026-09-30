import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewEvidence } from "./review-evidence.js";
import { ReviewService } from "./review-service.js";
import { TextAnswerRecheck, type RecheckResult, type RecheckStatus } from "./text-recheck.js";

function record(reviewId = "review-one"): ReviewRecord {
  return {
    schemaVersion: 1,
    reviewId,
    occurredAt: "2026-09-30T10:00:00.000Z",
    observation: null,
    failure: {
      schemaVersion: 1,
      requestId: "request",
      observationId: "observation",
      operationId: "operation",
      inputFingerprint: "a".repeat(64),
      stage: "codex.text",
      category: "PROCESSING",
      code: "TEXT.CITATION_INVALID",
      executionFact: "executed",
      evidenceKey: "evidence/intent.json",
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "TextFailure", message: "invalid citation", stack: null, details: {} },
    candidate: null,
    inspection: { kind: "none" },
  };
}

function answer(reviewId: string, status: RecheckStatus): RecheckResult {
  return {
    reviewId,
    status,
    operationId: "operation",
    recordedCode: "TEXT.CITATION_INVALID",
    code: null,
    reason: null,
  };
}

function setup() {
  const saved = record();
  const reviews = {
    list: vi.fn(async (): Promise<unknown> => ({ items: [{ reviewId: saved.reviewId }] })),
    summary: vi.fn(async () => ({ total: 3, byCode: { "TEXT.CITATION_INVALID": 3 } })),
    find: vi.fn(async () => saved),
    read: vi.fn(async (_reviewId: string): Promise<ReviewRecord | null> => saved),
  };
  const objects = { read: vi.fn(async () => null) };
  const sources = { resolve: vi.fn() };
  const files = new ReviewEvidence({ objects });
  const recheck = new TextAnswerRecheck({ objects, sources });
  const readFiles = vi.spyOn(files, "files").mockResolvedValue([]);
  const check = vi
    .spyOn(recheck, "check")
    .mockImplementation(async (review) => answer(review.reviewId, "passes"));
  const service = new ReviewService({ reviews, evidence: { files, recheck } });
  return { service, saved, reviews, readFiles, check, objects, sources };
}

afterEach(() => vi.useRealTimers());

describe("ReviewService.list and summary", () => {
  it("forwards all list filters and returns the repository page unchanged", async () => {
    const fake = setup();
    const query = {
      limit: 2,
      before: "cursor",
      code: "TEXT.CITATION_INVALID",
      operationId: "operation",
    };
    const page = { items: [], nextCursor: "next" };
    fake.reviews.list.mockResolvedValue(page);
    expect(await fake.service.list(query)).toBe(page);
    expect(fake.reviews.list).toHaveBeenCalledExactlyOnceWith(query);
    expect(fake.reviews.read).not.toHaveBeenCalled();
  });

  it("returns the repository summary unchanged", async () => {
    const fake = setup();
    const summary = { total: 3, byCode: { "TEXT.CITATION_INVALID": 3 } };
    fake.reviews.summary.mockResolvedValue(summary);
    expect(await fake.service.summary()).toBe(summary);
    expect(fake.reviews.summary).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["list", "summary"] as const)("propagates %s errors without retrying", async (method) => {
    const fake = setup();
    const failure = new Error("ledger offline");
    fake.reviews[method].mockRejectedValue(failure);
    const result = method === "list" ? fake.service.list({ limit: 25 }) : fake.service.summary();
    await expect(result).rejects.toBe(failure);
    expect(fake.reviews[method]).toHaveBeenCalledOnce();
  });
});

describe("ReviewService.inspect", () => {
  it.each([
    [{ kind: "none" }, "NOT_APPLICABLE"],
    [{ kind: "workflow-delivery", requestId: "request" }, "NOT_CONFIGURED"],
  ] as const)(
    "reports %j without running an inspection or changing a Review",
    async (inspection, status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
      const fake = setup();
      fake.saved.inspection = inspection;
      expect(await fake.service.inspect(fake.saved.reviewId)).toEqual({
        reviewId: fake.saved.reviewId,
        status,
        observedAt: "2026-09-30T12:00:00.000Z",
        mutatesState: false,
        automaticRetry: false,
      });
      expect(fake.reviews.read).toHaveBeenCalledExactlyOnceWith(fake.saved.reviewId);
      expect(fake.readFiles).not.toHaveBeenCalled();
      expect(fake.check).not.toHaveBeenCalled();
    },
  );
});

describe("ReviewService.evidence and recheck", () => {
  it("returns the exact record and gateway files using a bounded abort signal", async () => {
    const fake = setup();
    const files = [
      {
        key: "missing.json",
        status: "missing" as const,
        byteSize: null,
        content: null,
        code: null,
      },
    ];
    fake.readFiles.mockResolvedValue(files);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const result = await fake.service.evidence(fake.saved.reviewId);
      expect(result.review).toBe(fake.saved);
      expect(result.files).toBe(files);
      expect(timeout).toHaveBeenCalledWith(120_000);
      expect(fake.readFiles).toHaveBeenCalledExactlyOnceWith(fake.saved, expect.any(AbortSignal));
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["evidence", "recheck"] as const)(
    "refuses %s without evidence configuration before reading the ledger",
    async (method) => {
      const fake = setup();
      const service = new ReviewService({ reviews: fake.reviews });
      const result =
        method === "evidence"
          ? service.evidence("review")
          : service.recheck({ reviewId: "review" });
      await expect(result).rejects.toMatchObject({ code: "REVIEW.EVIDENCE_NOT_CONFIGURED" });
      expect(fake.reviews.read).not.toHaveBeenCalled();
      expect(fake.reviews.list).not.toHaveBeenCalled();
    },
  );

  it("rechecks a single ID without listing Reviews", async () => {
    const fake = setup();
    const result = await fake.service.recheck({ reviewId: fake.saved.reviewId });
    expect(result).toEqual({
      items: [answer(fake.saved.reviewId, "passes")],
      summary: { passes: 1, fails: 0, not_applicable: 0, unavailable: 0 },
    });
    expect(fake.reviews.list).not.toHaveBeenCalled();
    expect(fake.check).toHaveBeenCalledExactlyOnceWith(fake.saved, expect.any(AbortSignal));
  });

  it("preserves filter selection order, counts every status, and shares the bounded signal", async () => {
    const fake = setup();
    const statuses = ["passes", "fails", "not_applicable", "unavailable", "passes"] as const;
    const ids = statuses.map((_status, index) => `review-${index}`);
    fake.reviews.list.mockResolvedValue({
      items: ids.map((reviewId) => ({ reviewId })),
      nextCursor: "ignored",
    });
    fake.reviews.read.mockImplementation(async (reviewId) => record(reviewId));
    statuses.forEach((status, index) =>
      fake.check.mockResolvedValueOnce(answer(`review-${index}`, status)),
    );
    const filter = { code: "TEXT.CITATION_INVALID", before: "cursor" };
    const result = await fake.service.recheck({ filter, limit: 5 });
    expect(result.items.map((item) => item.reviewId)).toEqual(ids);
    expect(result.summary).toEqual({ passes: 2, fails: 1, not_applicable: 1, unavailable: 1 });
    expect(fake.reviews.list).toHaveBeenCalledExactlyOnceWith({ ...filter, limit: 5 });
    expect(fake.reviews.read.mock.calls).toEqual(ids.map((reviewId) => [reviewId]));
    expect(new Set(fake.check.mock.calls.map((call) => call[1])).size).toBe(1);
  });

  it("returns zero counts for an empty filtered page", async () => {
    const fake = setup();
    fake.reviews.list.mockResolvedValue({ items: [] });
    expect(await fake.service.recheck({ filter: {}, limit: 5 })).toEqual({
      items: [],
      summary: { passes: 0, fails: 0, not_applicable: 0, unavailable: 0 },
    });
    expect(fake.check).not.toHaveBeenCalled();
    expect(fake.reviews.read).not.toHaveBeenCalled();
  });

  it.each([null, { items: [{}] }, { items: [{ reviewId: "" }] }])(
    "refuses an invalid selected page %j",
    async (page) => {
      const fake = setup();
      fake.reviews.list.mockResolvedValue(page);
      await expect(fake.service.recheck({ filter: {}, limit: 5 })).rejects.toMatchObject({
        name: "ZodError",
      });
      expect(fake.reviews.read).not.toHaveBeenCalled();
    },
  );

  it("stops at a failed check rather than retrying or reading later Reviews", async () => {
    const fake = setup();
    const failure = new Error("gateway failed");
    fake.reviews.list.mockResolvedValue({ items: [{ reviewId: "one" }, { reviewId: "two" }] });
    fake.check.mockRejectedValue(failure);
    await expect(fake.service.recheck({ filter: {}, limit: 5 })).rejects.toBe(failure);
    expect(fake.reviews.read).toHaveBeenCalledExactlyOnceWith("one");
    expect(fake.check).toHaveBeenCalledOnce();
  });

  it("propagates a failed filter lookup before reading records or checking answers", async () => {
    const fake = setup();
    const failure = new Error("selection query failed");
    fake.reviews.list.mockRejectedValue(failure);
    await expect(fake.service.recheck({ filter: {}, limit: 5 })).rejects.toBe(failure);
    expect(fake.reviews.list).toHaveBeenCalledOnce();
    expect(fake.reviews.read).not.toHaveBeenCalled();
    expect(fake.check).not.toHaveBeenCalled();
  });

  it("propagates evidence gateway errors without hiding them", async () => {
    const fake = setup();
    const failure = new Error("evidence unavailable");
    fake.readFiles.mockRejectedValue(failure);
    await expect(fake.service.evidence("review")).rejects.toBe(failure);
    expect(fake.readFiles).toHaveBeenCalledOnce();
  });
});

describe("ReviewService full-record read refusals", () => {
  it("does not turn a get repository failure into REVIEW.NOT_FOUND", async () => {
    const fake = setup();
    const failure = new Error("lookup failed");
    fake.reviews.find.mockRejectedValue(failure);
    await expect(fake.service.get("review")).rejects.toBe(failure);
    expect(fake.reviews.find).toHaveBeenCalledExactlyOnceWith("review");
  });

  it.each(["inspect", "evidence", "recheck"] as const)(
    "%s names a missing Review and never calls evidence gateways",
    async (method) => {
      const fake = setup();
      fake.reviews.read.mockResolvedValue(null);
      const result =
        method === "recheck"
          ? fake.service.recheck({ reviewId: "missing" })
          : fake.service[method]("missing");
      await expect(result).rejects.toMatchObject({
        code: "REVIEW.NOT_FOUND",
        details: { reviewId: "missing" },
      });
      expect(fake.readFiles).not.toHaveBeenCalled();
      expect(fake.check).not.toHaveBeenCalled();
    },
  );

  it.each(["inspect", "evidence", "recheck"] as const)(
    "%s propagates record read failures",
    async (method) => {
      const fake = setup();
      const failure = new Error("read failed");
      fake.reviews.read.mockRejectedValue(failure);
      const result =
        method === "recheck"
          ? fake.service.recheck({ reviewId: "review" })
          : fake.service[method]("review");
      await expect(result).rejects.toBe(failure);
      expect(fake.reviews.read).toHaveBeenCalledOnce();
    },
  );
});
