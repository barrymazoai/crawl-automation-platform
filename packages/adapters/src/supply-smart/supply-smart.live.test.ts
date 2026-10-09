import { expect, it } from "vitest";
import { ApolloClient } from "../apollo/apollo-client.js";
import { loadBrandEnrichmentSecrets } from "./brand-enrichment-secrets.js";
import { SupplySmartBrandRequests } from "./supply-smart-brand-requests.js";
import { SupplySmartCompaniesClient } from "./supply-smart-companies.js";
import { SupplySmartContactsClient } from "./supply-smart-contacts.js";
import { SupplySmartRpc } from "./supply-smart-rpc.js";

// Read-only calls against a real Supply Smart (test server); nothing is written.
// CRAWL_BRAND_ENRICHMENT_ENV=/path/to/.env.brand-enrichment
const secretsPath = process.env["CRAWL_BRAND_ENRICHMENT_ENV"];

it.skipIf(!secretsPath)(
  "reads requests, companies, contact positions and Apollo people",
  async () => {
    const { supplySmart, apollo } = await loadBrandEnrichmentSecrets(secretsPath ?? "");
    const rpc = new SupplySmartRpc(supplySmart);
    const signal = AbortSignal.timeout(60_000);

    const pending = await new SupplySmartBrandRequests(rpc).pending(5, signal);
    expect(Array.isArray(pending)).toBe(true);

    const companies = new SupplySmartCompaniesClient(rpc);
    const byDomain = await companies.resolveDomain("katefarms.com", signal);
    expect(["matched", "unmatched", "ambiguous", "conflict"]).toContain(byDomain.status);
    const byFacts = await companies.resolve(
      { domain: "katefarms.com", name: "Kate Farms" },
      signal,
    );
    expect(["matched", "unmatched", "ambiguous"]).toContain(byFacts.status);
    if (byFacts.companyId) {
      const company = await companies.get(byFacts.companyId, signal);
      expect(company.id).toBe(byFacts.companyId);
      const ownership = await companies.ownershipStatus(byFacts.companyId, signal);
      expect(Array.isArray(ownership.owners)).toBe(true);
      // Apollo's people search is free; organization search spends credits and is not called here.
      if (company.apolloOrganizationId) {
        const people = await new ApolloClient(apollo).people(company.apolloOrganizationId, signal);
        expect(people.length).toBeGreaterThan(0);
      }
    }

    const contacts = new SupplySmartContactsClient(rpc);
    const taxonomy = await contacts.positionTaxonomy(signal);
    expect(taxonomy.functions.length).toBeGreaterThan(0);
    const known = await contacts.knownPositions(
      ["Marketing Manager", "Chief Executive Officer"],
      signal,
    );
    expect(known).toHaveLength(2);

    expect(known.map((position) => position.status)).toEqual(["known", "known"]);
  },
);
