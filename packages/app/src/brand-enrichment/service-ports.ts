import type { BrandEnrichmentRun } from "@crawl-automation/v3-contracts";

/** Temporal adapter; the facade never knows Temporal clients or workflow options. */
export interface BrandEnrichmentGateway {
  start(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  describe(runId: string): Promise<{ status: string } | null>;
}
export type RunId = Pick<BrandEnrichmentRun, "runId">;
