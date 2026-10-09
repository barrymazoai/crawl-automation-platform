import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrandReviewService } from "./review-service.js";
import { BrandOwnershipWriteService } from "./ownership-write-service.js";
import type { OwnershipReviewer } from "./task-ports.js";
import { companies, reviews, research, signal } from "./testing/fakes.js";
import { seededRuns } from "./testing/memory-runs.js";

async function fixture() {
  const store = await seededRuns();
  const company = companies();
  const review = reviews();
  const reviewer = {
    review: vi.fn<OwnershipReviewer["review"]>(async () => ({
      verdict: "owner",
      ownerName: "Parent",
      ownerDomain: "parent.test",
      kind: "brand_of",
      confidence: 0.9,
      reason: "Our brands page",
      signals: ["website_our_brands"],
    })),
  };
  await store.runs.saveStep({
    runId: store.runId,
    step: "research",
    output: research,
    archiveKeys: [],
  });
  await store.runs.saveStep({
    runId: store.runId,
    step: "ownership-status",
    output: { owners: [], latestCheck: null },
    archiveKeys: [],
  });
  const deps = { ...store, companies: company, reviews: review, reviewer, model: "test-model" };
  return { ...deps, service: new BrandReviewService(deps) };
}
it("creates a visible owner and its profile-only child, deferring the link until the child phase finishes", async () => {
  const test = await fixture();
  const result = await test.service.review(test.runId, signal);
  expect(result.ownerRunId).toBeDefined();
  expect(test.companies.create).toHaveBeenCalledWith(
    { name: "Parent", website: "https://parent.test", isNutrition: false },
    signal,
  );
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(await test.runs.list({ parentRunId: test.runId, limit: 10 })).toMatchObject([
    { role: "owner", requestId: null },
  ]);
  expect(await test.reviews.decisions(test.runId)).toMatchObject([
    { verdict: "owner", decidedBy: "codex:test-model" },
  ]);
  await new BrandOwnershipWriteService(test).write(test.runId, signal);
  expect(test.companies.link).toHaveBeenCalledOnce();
  expect(test.companies.recordOwnershipCheck).toHaveBeenCalledWith(
    expect.objectContaining({ result: "has_parent" }),
    signal,
  );
});
it("ambiguous owners become questions without creating or linking a company", async () => {
  const test = await fixture();
  test.companies.resolve.mockResolvedValue({
    status: "ambiguous",
    companyId: null,
    matchedBy: null,
    matches: [],
    reason: "multiple owners",
  });
  expect(await test.service.review(test.runId, signal)).toEqual({});
  expect(await test.reviews.questions({ runId: test.runId, limit: 10 })).toMatchObject([
    { kind: "ownership" },
  ]);
  expect(test.companies.create).not.toHaveBeenCalled();
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "ownership")).toBe("waiting_for_person");
});
it("link conflicts stay questions and never write a final ownership check", async () => {
  const test = await fixture();
  test.companies.resolve.mockResolvedValue({
    status: "matched",
    companyId: randomUUID(),
    matchedBy: "domain",
    matches: [],
    reason: "domain",
  });
  await test.service.review(test.runId, signal);
  test.companies.link.mockResolvedValue({
    status: "conflict",
    detail: { existingOwner: "another" },
  });
  await new BrandOwnershipWriteService(test).write(test.runId, signal);
  expect(await test.reviews.questions({ runId: test.runId, limit: 10 })).toMatchObject([
    { kind: "link_conflict" },
  ]);
  expect(test.companies.recordOwnershipCheck).not.toHaveBeenCalled();
});
it("an existing ownership check skips a second reviewer decision", async () => {
  const test = await fixture();
  test.steps.set(`${test.runId}/ownership-status`, {
    latestCheck: { checkedAt: "2026-10-09", result: "independent", signals: [] },
    owners: [],
  });
  await test.service.review(test.runId, signal);
  expect(test.reviewer.review).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "ownership")).toBe("independent");
});
