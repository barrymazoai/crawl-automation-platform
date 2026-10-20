import { z } from "zod";
import type { BrandClaimResult } from "@crawl-automation/app";
import { operatorsApiCall } from "./marketplace-brands-api.js";

const claimed = z.object({
  result: z.object({
    data: z.array(
      z.union([
        z.object({ requestId: z.string(), run: z.object({ runId: z.string() }).loose() }),
        z.object({ requestId: z.string(), skipped: z.literal("retail_site"), site: z.string() }),
        z.object({ requestId: z.string(), error: z.string() }),
      ]),
    ),
  }),
});

/**
 * KAN-220: request intake claims and stops runs through the operators' mutations (`brandEnrichment.claimPending`,
 * `brandEnrichment.cancel`), so a run starts with the API's own Temporal settings, as a person's would.
 */
export class BrandRequestsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private get api() {
    return { baseUrl: this.baseUrl, fetch: this.fetch };
  }

  async claimPending(limit: number, signal: AbortSignal): Promise<BrandClaimResult[]> {
    const answer = await operatorsApiCall(
      this.api,
      { path: "brandEnrichment.claimPending", input: { limit } },
      signal,
    );
    return claimed
      .parse(answer)
      .result.data.map((item) =>
        "run" in item ? { requestId: item.requestId, runId: item.run.runId } : item,
      );
  }

  async cancel(runId: string, signal: AbortSignal): Promise<void> {
    await operatorsApiCall(this.api, { path: "brandEnrichment.cancel", input: { runId } }, signal);
  }
}
