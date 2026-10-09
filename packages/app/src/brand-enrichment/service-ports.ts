import type { BrandEnrichmentRun, BrandProductsRetryRequest } from "@crawl-automation/v3-contracts";

/** Temporal adapter; the facade never knows Temporal clients or workflow options. */
export interface BrandEnrichmentGateway {
  startProductsRetry(input: BrandProductsRetryRequest): Promise<void>;
  describeProductsRetry(input: BrandProductsRetryRequest): Promise<{ status: string } | null>;
  start(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  describe(runId: string): Promise<{ status: string } | null>;
}
export type RunId = Pick<BrandEnrichmentRun, "runId">;
