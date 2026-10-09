import { vi } from "vitest";
import { BrandReviewService } from "../review-service.js";
import type { OwnershipReviewer } from "../task-ports.js";
import { companies, reviews, research } from "./fakes.js";
import { seededRuns } from "./memory-runs.js";

export async function ownershipFixture() {
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
