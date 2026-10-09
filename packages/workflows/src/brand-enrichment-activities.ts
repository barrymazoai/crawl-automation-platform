import type {
  BrandFamilyPlan,
  BrandReviewPlan,
  BrandProductProgress,
  BrandEnrichmentRole,
  BrandProductsAttempt,
} from "@crawl-automation/v3-contracts";
export interface BrandEnrichmentActivities {
  brandIdentity(input: {
    runId: string;
  }): Promise<{ role: BrandEnrichmentRole; hasWebsite: boolean; existing?: boolean }>;
  brandFamily(input: { runId: string }): Promise<BrandFamilyPlan>;
  brandResearch(input: { runId: string }): Promise<unknown>;
  brandApollo(input: { runId: string }): Promise<unknown>;
  brandProducts(input: BrandProductsAttempt): Promise<BrandProductProgress>;
  brandProductsStop(input: BrandProductsAttempt): Promise<void>;
  brandProductFailure(input: BrandProductsAttempt & { reason: string }): Promise<void>;
  brandWrite(input: { runId: string }): Promise<unknown>;
  brandContacts(input: { runId: string }): Promise<unknown>;
  brandReview(input: { runId: string }): Promise<BrandReviewPlan>;
  brandOwnershipWrite(input: { runId: string }): Promise<void>;
  brandClose(input: {
    runId: string;
    state: "completed" | "failed" | "cancelled";
    reason?: string;
    cleanupPending?: boolean;
  }): Promise<unknown>;
}
