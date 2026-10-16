import {
  MarketplaceBrandsApi,
  PostgresBrandCompany,
  PostgresListingStates,
  PostgresMarketplaceBrands,
  PostgresListingTargets,
  PostgresMarketplaceReader,
  PostgresProductSync,
  SupplySmartListingStates,
  SupplySmartObservationWriter,
  type SupplySmartRpc,
} from "@crawl-automation/adapters";
import {
  ListingStateDelivery,
  MarketplaceBrandSweep,
  ProductSyncService,
  ProductSyncSweep,
} from "@crawl-automation/app";
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
    ...brandStep(parts, input),
    settings: input.settings,
    log: parts.log.child({ service: "product-sync" }),
  });
}

/** The automatic brand step calls the operators' API: its own `apiUrl`, else the stop sweep's. */
function brandStep(parts: CoreParts, input: { settings: BrandEnrichmentSettings["productSync"] }) {
  const { brands } = input.settings;
  const apiUrl = brands.apiUrl ?? parts.config.stopSweep?.apiUrl;
  if (!brands.enabled || !apiUrl) {
    return {};
  }
  return {
    brands: new MarketplaceBrandSweep({
      api: new MarketplaceBrandsApi(apiUrl),
      runs: new PostgresMarketplaceBrands(parts.database),
      settings: brands,
      log: parts.log.child({ service: "marketplace-brands" }),
    }),
  };
}
