import {
  PostgresBrandCompany,
  PostgresListingStates,
  PostgresListingTargets,
  PostgresMarketplaceReader,
  PostgresProductSync,
  SupplySmartListingStates,
  SupplySmartObservationWriter,
  type SupplySmartRpc,
} from "@crawl-automation/adapters";
import { ListingStateDelivery, ProductSyncService, ProductSyncSweep } from "@crawl-automation/app";
import type { CoreParts } from "./core-parts.js";
import type { BrandEnrichmentSettings } from "./brand-enrichment-settings.js";

/** Hosted by the brand-enrichment role: it holds the Supply Smart key, R2 and the channels' retained-page parsers. */
export function buildProductSyncSweep(
  parts: CoreParts,
  input: { rpc: SupplySmartRpc; settings: BrandEnrichmentSettings["productSync"] },
) {
  const service = new ProductSyncService({
    reader: new PostgresMarketplaceReader({
      database: parts.database,
      objects: parts.r2.store,
      channels: parts.registry,
    }),
    brands: new PostgresBrandCompany(parts.database),
    ledger: new PostgresProductSync(parts.database),
    writer: new SupplySmartObservationWriter(input.rpc),
  });
  return new ProductSyncSweep({
    sync: service,
    // Delistings of the synced channels only; DTC keeps its own path.
    listings: new ListingStateDelivery({
      store: new PostgresListingStates(parts.database),
      sender: new SupplySmartListingStates(input.rpc),
      targets: new PostgresListingTargets(parts.database),
      channels: input.settings.channels,
    }),
    settings: input.settings,
    log: parts.log.child({ service: "product-sync" }),
  });
}
