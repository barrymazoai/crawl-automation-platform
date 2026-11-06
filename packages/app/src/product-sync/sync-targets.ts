import type { CrossMarketField } from "@crawl-automation/v3-contracts";
import type { CrossMarketOutcome } from "../cross-market/cross-market-check.js";
import type { BrandCompanyMatch } from "./brand-company-model.js";
import type { MarketplaceProduct } from "./marketplace-model.js";
import type { PlannedSync, SyncTally } from "./sync-model.js";

/** Each brand's production match, else (only for a brand without one) the target's own domain for it. */
export function withTargetDomains(
  brandIds: string[],
  known: Map<string, BrandCompanyMatch>,
  domains: Readonly<Record<string, string>> = {},
): BrandCompanyMatch[] {
  return brandIds.flatMap((brandId) => {
    const match = known.get(brandId);
    const domain = domains[brandId];
    if (match?.status === "matched" || !domain) {
      return match ? [match] : [];
    }
    return [
      {
        brandId,
        status: "matched",
        companyId: null,
        domain,
        matchedBy: "target-domain",
        candidates: [],
        checkedAt: new Date(0).toISOString(),
      },
    ];
  });
}

export function withOutcomes(
  planned: PlannedSync[],
  outcomes: Map<MarketplaceProduct, CrossMarketOutcome>,
  tally: SyncTally,
): PlannedSync[] {
  return planned.flatMap((entry) => {
    const outcome = outcomes.get(entry.product);
    if (outcome && "hold" in outcome) {
      tally.result.waitingCrossMarket = (tally.result.waitingCrossMarket ?? 0) + 1;
      return [];
    }
    return [outcome && "field" in outcome ? withVerdict(entry, outcome.field) : entry];
  });
}

/** The verdict rides on the item; the label (built from the item before) never carries it. */
function withVerdict(entry: PlannedSync, crossMarket: CrossMarketField): PlannedSync {
  return { ...entry, item: { ...entry.item, crossMarket } };
}
