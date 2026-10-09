import type { CompanyLink } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";
import { saveOutput } from "./run-records.js";

/** A 409 confirms an existing owner; retain the refused link without replacing that owner. */
export async function saveOwnershipConflict(
  runs: BrandEnrichmentRuns,
  input: { runId: string; link: CompanyLink; detail: unknown },
) {
  const { runId, link, detail } = input;
  await saveOutput(runs, { runId, step: "ownership-conflict", output: { link, detail } });
  await saveOutput(runs, { runId, step: "ownership", output: "has_parent" });
}
