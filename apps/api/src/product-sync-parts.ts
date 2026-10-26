import {
  loadBrandEnrichmentSecrets,
  PostgresBrandCompany,
  PostgresProductSync,
  RetainedListingDateOriginals,
  SupplySmartCompaniesClient,
  SupplySmartHealthFunctionsClient,
  SupplySmartProductsClient,
  SupplySmartRpc,
} from "@crawl-automation/adapters";
import {
  BrandCompanyService,
  HealthFunctionCleanup,
  NotSupplementRemoval,
  ProductSyncControl,
} from "@crawl-automation/app";
import type { Database, Logger, ObjectStore } from "@crawl-automation/platform";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import type { ApiConfig } from "./config.js";

/** Uses the same configured Supply Smart API and private key as brand enrichment; no polling. */
export async function productSyncService(parts: {
  database: Database;
  config: Pick<ApiConfig, "brandEnrichment">;
  storageReaders?: { objects: Pick<ObjectStore, "read"> } | null;
  log?: Logger;
}) {
  const settings = parts.config.brandEnrichment;
  if (!settings) {
    return undefined;
  }
  const secrets = await loadBrandEnrichmentSecrets(settings.secretsFile);
  const rpc = new SupplySmartRpc(secrets.supplySmart);
  const brands = new BrandCompanyService({
    brands: new PostgresBrandCompany(parts.database),
    companies: new SupplySmartCompaniesClient(rpc),
  });
  const ledger = new PostgresProductSync(parts.database);
  const control = syncControl(parts, ledger);
  const removal = new NotSupplementRemoval({
    ledger,
    products: new SupplySmartProductsClient(rpc),
  });
  const cleanup = new HealthFunctionCleanup({
    ledger,
    healthFunctions: new SupplySmartHealthFunctionsClient(rpc),
  });
  return {
    matchBrands: brands.matchBrands.bind(brands),
    brands: brands.brands.bind(brands),
    status: () => control.status(),
    markPresent: control.markPresent.bind(control),
    reopen: control.reopen.bind(control),
    removeNotSupplements: removal.run.bind(removal),
    cleanHealthFunctions: cleanup.run.bind(cleanup),
  };
}

function syncControl(
  parts: {
    database: Database;
    storageReaders?: { objects: Pick<ObjectStore, "read"> } | null;
    log?: Logger;
  },
  ledger: PostgresProductSync,
) {
  return new ProductSyncControl({
    ledger,
    ...(parts.storageReaders
      ? {
          listingDateOriginals: new RetainedListingDateOriginals({
            database: parts.database,
            objects: parts.storageReaders.objects,
            channels: new ChannelRegistry([amazonAdapter]),
            ...(parts.log ? { log: parts.log } : {}),
          }),
        }
      : {}),
  });
}
