import { AMAZON_MARKETPLACES, type ForeignAmazonChannel } from "@crawl-automation/v3-contracts";
import {
  MarketplaceBrandsApi,
  PostgresBrandCompany,
  PostgresListingStates,
  PostgresMarketplaceBrands,
  PostgresListingTargets,
  PostgresMarketplaceReader,
  PostgresProductSync,
  SupplySmartCompaniesClient,
  SupplySmartListingStates,
  loadSupplySmartSecrets,
  SupplySmartObservationWriter,
  SupplySmartRpc,
} from "@crawl-automation/adapters";
import {
  ListingStateDelivery,
  MarketplaceBrandSweep,
  MarketplaceRoutedListingStates,
  ProductSyncService,
  ProductSyncSweep,
} from "@crawl-automation/app";
import type { CoreParts } from "./core-parts.js";
import { crossMarketCheck } from "./cross-market-parts.js";
import type { BrandEnrichmentSettings } from "./brand-enrichment-settings.js";

/** Hosted by the brand-enrichment role: it holds the Supply Smart key, R2 and the channels' retained-page parsers. */
export function buildProductSyncSweep(
  parts: CoreParts,
  input: {
    rpc: SupplySmartRpc;
    settings: BrandEnrichmentSettings["productSync"];
    /** KAN-243: storefronts sent to another Supply Smart (productSync.targets), by crawler channel. */
    targets?: Partial<Record<ForeignAmazonChannel, SupplySmartRpc>>;
  },
) {
  const targets = Object.entries(input.targets ?? {}) as Targets;
  const reader = new PostgresMarketplaceReader({
    database: parts.database,
    objects: parts.r2.store,
    channels: parts.registry,
    log: parts.log,
  });
  const service = new ProductSyncService({
    reader,
    brands: new PostgresBrandCompany(parts.database),
    ledger: new PostgresProductSync(parts.database),
    writer: new SupplySmartObservationWriter(input.rpc),
    writers: targetWriters(parts, { reader, targets, settings: input.settings }),
  });
  return new ProductSyncSweep({
    sync: service,
    // Delistings of the synced channels only; DTC keeps its own path.
    listings: new ListingStateDelivery({
      store: new PostgresListingStates(parts.database),
      sender: listingSender(input.rpc, targets),
      targets: new PostgresListingTargets(parts.database),
      channels: input.settings.channels,
    }),
    ...brandStep(parts, input),
    settings: input.settings,
    log: parts.log.child({ service: "product-sync" }),
  });
}

type Targets = [ForeignAmazonChannel, SupplySmartRpc][];

/** Each target's writer, its company lookup and its cross-market check (KAN-243). */
function targetWriters(
  parts: CoreParts,
  input: {
    reader: PostgresMarketplaceReader;
    targets: Targets;
    settings: BrandEnrichmentSettings["productSync"];
  },
) {
  return Object.fromEntries(
    input.targets.map(([channel, rpc]) => [
      channel,
      {
        writer: new SupplySmartObservationWriter(rpc),
        companies: new SupplySmartCompaniesClient(rpc),
        crossMarket: crossMarketCheck(parts, { rpc, reader: input.reader }),
        brandDomains: input.settings.targets[channel]?.brandDomains ?? {},
      },
    ]),
  );
}

/** Listing states of a storefront with its own target go there; the rest to production as before. */
function listingSender(rpc: SupplySmartRpc, targets: Targets) {
  const routes = targets.map(
    ([channel, target]) =>
      [AMAZON_MARKETPLACES[channel].marketplace, new SupplySmartListingStates(target)] as const,
  );
  return new MarketplaceRoutedListingStates(new SupplySmartListingStates(rpc), new Map(routes));
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

/** KAN-243: each configured storefront target's own Supply Smart client. */
export async function syncTargets(sync: BrandEnrichmentSettings["productSync"]) {
  const targets: Partial<Record<ForeignAmazonChannel, SupplySmartRpc>> = {};
  for (const [channel, target] of Object.entries(sync.targets) as [
    ForeignAmazonChannel,
    { secretsFile: string },
  ][]) {
    targets[channel] = new SupplySmartRpc(await loadSupplySmartSecrets(target.secretsFile));
  }
  return targets;
}
