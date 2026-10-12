import { errorCodeOf } from "@crawl-automation/platform";
import { canonicalHash } from "../history/canonical.js";
import type { BrandCompanyMatch } from "./brand-company-model.js";
import type { SyncRecord } from "./ledger.js";
import { marketplaceItem, marketplaceLabel } from "./marketplace-mapping.js";
import type { MarketplaceProduct } from "./marketplace-model.js";
import {
  materialOf,
  materialProblem,
  syncKeyOf,
  syncKeyString,
  type PlannedSync,
  type SyncTally,
} from "./sync-model.js";

interface PlanInput {
  products: MarketplaceProduct[];
  runId: string;
  ledger: SyncRecord[];
  matches: BrandCompanyMatch[];
}

/**
 * Which products of one page go to Supply Smart: no material problem, a matched brand company, and a payload different
 * from the last verified one. Everything else is counted (and written to the ledger) here.
 */
export function planSync(input: PlanInput, tally: SyncTally): PlannedSync[] {
  const ledger = new Map(input.ledger.map((row) => [syncKeyString(row), row]));
  const matches = new Map(input.matches.map((match) => [match.brandId, match]));
  const planned: PlannedSync[] = [];
  const seen = new Set<string>();
  for (const product of input.products) {
    const entry = planOne({
      product,
      prior: ledger.get(syncKeyString(syncKeyOf(product))),
      match: product.brandId ? matches.get(product.brandId) : undefined,
      runId: input.runId,
      tally,
    });
    if (entry && seen.has(entry.item.clientRef)) {
      materialProblem(tally, entry.product, "PRODUCT_DELIVERY.INTEGRITY");
    } else if (entry) {
      seen.add(entry.item.clientRef);
      planned.push(entry);
    }
  }
  return planned;
}

function planOne(at: {
  product: MarketplaceProduct;
  prior: SyncRecord | undefined;
  match: BrandCompanyMatch | undefined;
  runId: string;
  tally: SyncTally;
}): PlannedSync | null {
  const company = eligibleCompany(at);
  if (!company) {
    return null;
  }
  const { product, prior, tally } = at;
  const key = syncKeyOf(product);
  try {
    const options = { ...company, runId: at.runId };
    const item = marketplaceItem(product, options);
    const label = marketplaceLabel(product, options);
    const hash = canonicalHash({ item, label });
    if (prior?.status === "verified" && prior.payloadHash === hash) {
      // Checked again after a newer settlement: record that, or it would stay first in every pending page.
      tally.result.unchanged += 1;
      tally.touched.push({ ...key, materialAt: materialOf(product) });
      return null;
    }
    return { product, key, item, label, hash };
  } catch (error) {
    materialProblem(tally, product, errorCodeOf(error) ?? "PRODUCT_DELIVERY.MATERIAL_MISSING");
    return null;
  }
}

/** The matched company to send under, or null after counting why the product is not sent. */
function eligibleCompany(at: {
  product: MarketplaceProduct;
  match: BrandCompanyMatch | undefined;
  tally: SyncTally;
}): { domain: string; companyId: string } | null {
  const { product, match, tally } = at;
  const key = syncKeyOf(product);
  // A `present` baseline only hides the capture it was recorded against; the pending query compares the times.
  if (product.problem) {
    materialProblem(tally, product, product.problem);
    return null;
  }
  if (match?.status !== "matched" || !match.domain || !match.companyId) {
    tally.result.waitingCompany += 1;
    tally.changes.push({ ...key, status: "waiting_company" });
    return null;
  }
  return { domain: match.domain, companyId: match.companyId };
}
