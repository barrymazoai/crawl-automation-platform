import {
  loadBrandEnrichmentSecrets,
  PostgresBrandCompany,
  PostgresProductSync,
  RetainedListingDateOriginals,
  SupplySmartCompaniesClient,
  SupplySmartRpc,
} from "@crawl-automation/adapters";
import { BrandCompanyService, ProductSyncControl } from "@crawl-automation/app";
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
  const brands = new BrandCompanyService({
    brands: new PostgresBrandCompany(parts.database),
    companies: new SupplySmartCompaniesClient(new SupplySmartRpc(secrets.supplySmart)),
  });
  const control = new ProductSyncControl({
    ledger: new PostgresProductSync(parts.database),
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
  return {
    matchBrands: brands.matchBrands.bind(brands),
    brands: brands.brands.bind(brands),
    status: () => control.status(),
    markPresent: control.markPresent.bind(control),
    reopen: control.reopen.bind(control),
  };
}
