import { randomUUID } from "node:crypto";
import type { BrandEnrichmentRun, BrandEnrichmentRole } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";
import { brandEnrichmentErrors } from "./errors.js";

export async function requireRun(runs: BrandEnrichmentRuns, runId: string) {
  const run = await runs.get(runId);
  if (!run) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND", { details: { runId } });
  }
  return run;
}
export function domainOf(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}
export async function childRun(
  runs: BrandEnrichmentRuns,
  input: {
    parent: BrandEnrichmentRun;
    role: BrandEnrichmentRole;
    name: string;
    url: string | null;
    companyId: string;
  },
) {
  const runId = randomUUID();
  const created = await runs.create({
    runId,
    requestId: null,
    parentRunId: input.parent.runId,
    role: input.role,
    brandName: input.name,
    brandUrl: input.url,
    workflowId: `brand-enrichment-${runId}`,
  });
  return runs.update(created.run.runId, { companyId: input.companyId });
}
export const saveOutput = (
  runs: BrandEnrichmentRuns,
  input: {
    runId: string;
    step: string;
    output: unknown;
    archiveKeys?: string[];
  },
) => runs.saveStep({ ...input, archiveKeys: input.archiveKeys ?? [] });

export async function requireCompanyRun(runs: BrandEnrichmentRuns, runId: string) {
  const run = await requireRun(runs, runId);
  if (!run.companyId) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED", {
      details: { runId },
    });
  }
  return { ...run, companyId: run.companyId };
}
