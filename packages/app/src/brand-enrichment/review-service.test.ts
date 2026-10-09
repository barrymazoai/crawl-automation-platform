import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrandReviewService } from "./review-service.js";
import { BrandOwnershipWriteService } from "./ownership-write-service.js";
import type { OwnershipReviewer } from "./task-ports.js";
import { companies, reviews, research, signal } from "./testing/fakes.js";
import { seededRuns } from "./testing/memory-runs.js";
import { BrandSummaryService } from "./summary-service.js";
import { BrandResearchService } from "./research-service.js";

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
it("retains ambiguous owners without a question or a Supply Smart write", async () => {
  const test = await fixture();
  test.companies.resolve.mockResolvedValue({
    status: "ambiguous",
    companyId: null,
    matchedBy: null,
    matches: [],
    reason: "multiple owners",
  });
  expect(await test.service.review(test.runId, signal)).toEqual({});
  expect(test.reviews.addQuestion).not.toHaveBeenCalled();
  expect(test.companies.create).not.toHaveBeenCalled();
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "ownership")).toBeNull();
  expect(await test.runs.step(test.runId, "ownership-unresolved")).toMatchObject({
    resolution: { status: "ambiguous" },
  });
});
it("retains link conflicts, keeps the existing owner and summarizes has_parent without a question", async () => {
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
  expect(test.reviews.addQuestion).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "ownership-conflict")).toEqual({
    link: await test.runs.step(test.runId, "ownership-link"),
    detail: { existingOwner: "another" },
  });
  expect(await new BrandSummaryService(test).build(test.runId)).toMatchObject({
    ownership: "has_parent",
  });
  expect(test.companies.link).toHaveBeenCalledOnce();
  expect(test.companies.unlink).not.toHaveBeenCalled();
  expect(test.companies.recordOwnershipCheck).not.toHaveBeenCalled();
  expect(test.reviews.markDecisionSent).not.toHaveBeenCalled();
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

it("records cannot_tell locally, sends no ownership and creates no question", async () => {
  const test = await fixture();
  test.reviewer.review.mockResolvedValue({ verdict: "cannot_tell", reason: "No evidence" });
  expect(await test.service.review(test.runId, signal)).toEqual({});
  await new BrandOwnershipWriteService(test).write(test.runId, signal);
  expect(await test.reviews.decisions(test.runId)).toMatchObject([
    { verdict: "cannot_tell", reason: "No evidence", sent: null },
  ]);
  expect(test.reviews.addQuestion).not.toHaveBeenCalled();
  expect(test.companies.create).not.toHaveBeenCalled();
  expect(test.companies.enrich).not.toHaveBeenCalled();
  expect(test.companies.link).not.toHaveBeenCalled();
  expect(test.companies.recordOwnershipCheck).not.toHaveBeenCalled();
  expect(await new BrandSummaryService(test).build(test.runId)).not.toHaveProperty("ownership");
  const later = await seededRuns();
  await later.runs.update(later.runId, { companyId: test.companyId });
  const researcher = { research: vi.fn(async () => research) };
  await new BrandResearchService({ ...test, runs: later.runs, researcher }).research(
    later.runId,
    signal,
  );
  await new BrandReviewService({ ...test, runs: later.runs }).review(later.runId, signal);
  expect(researcher.research).toHaveBeenCalledWith(
    expect.objectContaining({ companyId: test.companyId, skipOwnershipResearch: false }),
    signal,
  );
  expect(test.reviewer.review).toHaveBeenCalledTimes(2);
  expect(test.companies.recordOwnershipCheck).not.toHaveBeenCalled();
  expect(test.reviews.addQuestion).not.toHaveBeenCalled();
});

it("retains a merge suggestion without a question, unlink or automatic merge", async () => {
  const test = await fixture();
  const holderCompanyId = randomUUID();
  await test.runs.addClues(test.runId, [
    {
      signal: "shared_apollo_org",
      ownerName: "Holder",
      ownerDomain: null,
      ownerCompanyId: holderCompanyId,
      quote: "Same Apollo org",
      url: null,
      archiveKey: null,
    },
  ]);
  const mergeCompany = vi.fn();
  Object.assign(test.companies, { mergeCompany });
  await test.service.review(test.runId, signal);
  expect(await test.runs.step(test.runId, "merge-suggestion")).toEqual({
    holderCompanyId,
    ownerCompanyId: test.companies.create.mock.results[0]
      ? (await test.companies.create.mock.results[0].value).id
      : undefined,
    reason: "Our brands page",
  });
  expect(test.reviews.addQuestion).not.toHaveBeenCalled();
  expect(test.companies.unlink).not.toHaveBeenCalled();
  expect(mergeCompany).not.toHaveBeenCalled();
});
