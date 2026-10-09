import {
  BrandResearchSchema,
  FamilyFindingSchema,
  DomainAdditionResultSchema,
  type ApolloBrandFacts,
  type FamilyFinding,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";
import { domainOf, requireRun } from "./run-records.js";

export async function brandFacts(
  runs: BrandEnrichmentRuns,
  runId: string,
): Promise<ApolloBrandFacts> {
  const run = await requireRun(runs, runId);
  const family = FamilyFindingSchema.safeParse(await runs.step(runId, "family"));
  const research = BrandResearchSchema.safeParse(await runs.step(runId, "research"));
  const additions = DomainAdditionResultSchema.safeParse(
    await runs.step(runId, "domain-additions"),
  );
  const blocked = new Set(
    additions.success
      ? [...additions.data.conflicts, ...additions.data.skipped].map((item) =>
          domainOf(item.domain),
        )
      : [],
  );
  const domains = brandDomains(family.success ? family.data : undefined);
  const current = [
    domainOf(run.brandUrl),
    ...domains.filter((item) => item.status === "current").map((item) => domainOf(item.domain)),
  ];
  const former = domains
    .filter((item) => item.status === "former")
    .map((item) => domainOf(item.domain));
  const clean = (items: (string | null)[]) => [
    ...new Set(items.filter((domain): domain is string => !!domain && !blocked.has(domain))),
  ];
  return {
    name: run.brandName,
    domains: clean(current),
    formerDomains: clean(former),
    legalName: research.success ? research.data.legalName : null,
    address: research.success ? research.data.address : null,
    linkedinUrl: research.success ? research.data.linkedinUrl : null,
  };
}
function brandDomains(family: FamilyFinding | undefined) {
  const domains = [...(family?.otherDomains ?? [])];
  const redirect = family?.redirect;
  if (redirect?.sameBrand) {
    domains.push(
      { domain: redirect.fromDomain, status: "former" },
      { domain: redirect.toDomain, status: "current" },
    );
  }
  return domains;
}
