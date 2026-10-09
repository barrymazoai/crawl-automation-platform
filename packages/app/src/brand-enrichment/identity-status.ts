import { z } from "zod";
import type { BrandEnrichmentRuns } from "./ports.js";

/** A preassigned child company was just created; only a saved match means it already existed. */
export async function existingBrandCompany(runs: BrandEnrichmentRuns, runId: string) {
  return z
    .object({ status: z.literal("matched") })
    .safeParse(await runs.step(runId, "identity-resolution")).success;
}
