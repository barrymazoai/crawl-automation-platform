import {
  loadBrandEnrichmentSecrets,
  PostgresBrandCompany,
  PostgresBrandEnrichmentRuns,
  PostgresProductSync,
  RetainedListingDateOriginals,
  SupplySmartCompaniesClient,
  SupplySmartEnrichmentClient,
  SupplySmartProductDelivery,
  SupplySmartProductsClient,
  SupplySmartRpc,
  loadSupplySmartSecrets,
} from "@crawl-automation/adapters";
import {
  BrandCompanyService,
  DtcSourceDelivery,
  EnrichmentUpdate,
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
    runs: new PostgresBrandEnrichmentRuns(parts.database),
  });
  const ledger = new PostgresProductSync(parts.database);
  const control = syncControl(parts, ledger);
  const removal = new NotSupplementRemoval({
    ledger,
    products: new SupplySmartProductsClient(rpc),
  });
  const enrichment = new EnrichmentUpdate({
    ledger,
    supplySmart: new SupplySmartEnrichmentClient(rpc),
  });
  const dtc = await dtcDelivery(parts, { rpc, testSecretsFile: settings.testSecretsFile });
  return {
    deliverDtc: dtc.deliver.bind(dtc),
    matchBrands: brands.matchBrands.bind(brands),
    brands: brands.brands.bind(brands),
    status: () => control.status(),
    markPresent: control.markPresent.bind(control),
    reopen: control.reopen.bind(control),
    removeNotSupplements: removal.run.bind(removal),
    updateEnrichment: enrichment.run.bind(enrichment),
  };
}

/** KAN-259: production uses the brand-enrichment client; test only when its own secrets file is configured. */
async function dtcDelivery(
  parts: { database: Database; storageReaders?: { objects: Pick<ObjectStore, "read"> } | null },
  input: { rpc: SupplySmartRpc; testSecretsFile: string | undefined },
) {
  const objects = parts.storageReaders?.objects;
  if (!objects) {
    // Retained projections are the delivery material; without R2 readers nothing can be sent.
    return new DtcSourceDelivery({ deliveries: {} });
  }
  const delivery = (rpc: SupplySmartRpc) =>
    new SupplySmartProductDelivery({ database: parts.database, rpc, objects });
  return new DtcSourceDelivery({
    deliveries: {
      production: delivery(input.rpc),
      ...(input.testSecretsFile
        ? {
            test: delivery(new SupplySmartRpc(await loadSupplySmartSecrets(input.testSecretsFile))),
          }
        : {}),
    },
  });
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
