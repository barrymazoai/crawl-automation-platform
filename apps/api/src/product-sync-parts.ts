import {
  loadBrandEnrichmentSecrets,
  PostgresBrandCompany,
  PostgresProductSync,
  SupplySmartCompaniesClient,
  SupplySmartRpc,
} from "@crawl-automation/adapters";
import { BrandCompanyService, ProductSyncControl } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";

/** Uses the same configured Supply Smart API and private key as brand enrichment; no polling. */
export async function productSyncService(parts: {
  database: Database;
  config: Pick<ApiConfig, "brandEnrichment">;
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
  const control = new ProductSyncControl({ ledger: new PostgresProductSync(parts.database) });
  return {
    matchBrands: brands.matchBrands.bind(brands),
    brands: brands.brands.bind(brands),
    status: () => control.status(),
    markPresent: control.markPresent.bind(control),
  };
}
