import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DomainResolution } from "@crawl-automation/v3-contracts";
import { BrandCompanyService } from "./brand-company.js";
import type { BrandCompanyMatch, NamedBrandCompanyMatch } from "./brand-company-model.js";

const now = new Date("2026-10-12T10:00:00.000Z");
const signal = () => new AbortController().signal;
const companyId = randomUUID();
const merged = randomUUID();
const survivor = randomUUID();

function stale(overrides: Partial<NamedBrandCompanyMatch>): NamedBrandCompanyMatch {
  return {
    brandId: randomUUID(),
    status: "matched",
    companyId,
    domain: "example.com",
    matchedBy: "name",
    candidates: [],
    checkedAt: "2026-10-01T00:00:00.000Z",
    name: "Example",
    ...overrides,
  };
}

/** Supply Smart as the refresh sees it: companies by id (a merged id answers with its survivor), domain owners. */
function refreshing(
  matches: NamedBrandCompanyMatch[],
  smart: {
    companies: Record<string, { id: string; name: string; website: string | null } | Error>;
    owners: Record<string, string>;
    /** Sent product IDs per brand, and each product's company now. */
    sent?: Record<string, string[]>;
    productCompany?: Record<string, string>;
  },
) {
  const brands = {
    candidates: vi.fn(async () => []),
    list: vi.fn(async () => []),
    upsert: vi.fn(async (_match: BrandCompanyMatch) => undefined),
    matches: vi.fn(async () => [] as BrandCompanyMatch[]),
    moveCompany: vi.fn(async () => 0),
    staleMatches: vi.fn(async (_filter: { limit: number; checkedBefore: string }) => matches),
    deliveredProducts: vi.fn(async (brandId: string) => smart.sent?.[brandId] ?? []),
  };
  const products = {
    companyOf: vi.fn(async (id: string) => smart.productCompany?.[id] ?? null),
  };
  const companies = {
    resolve: vi.fn(),
    get: vi.fn(async (id: string) => {
      const company = smart.companies[id];
      if (!company || company instanceof Error) {
        throw company ?? new Error("Supply Smart refused or failed the call.");
      }
      return company;
    }),
    resolveDomain: vi.fn(async (domain: string): Promise<DomainResolution> => {
      const owner = smart.owners[domain];
      return owner
        ? {
            status: "matched",
            companyId: owner,
            companyName: "Owner",
            candidates: [],
            reason: "website",
          }
        : {
            status: "unmatched",
            companyId: null,
            companyName: null,
            candidates: [],
            reason: "no company owns this domain",
          };
    }),
  };
  const runs = { moveCompany: vi.fn(async () => 1) };
  const service = new BrandCompanyService({ brands, companies, products, runs, now: () => now });
  const run = (refreshMatched: { limit: number; checkedBefore?: string } = { limit: 50 }) =>
    service.matchBrands({ limit: 1, refreshMatched }, signal());
  return { brands, companies, products, runs, run };
}

const saved = (fake: ReturnType<typeof refreshing>) =>
  fake.brands.upsert.mock.calls.map(([match]) => [match.companyId, match.domain, match.checkedAt]);

describe("refresh of matched brands (2026-11-14)", () => {
  it("follows a merged company to its survivor once its website resolves to the survivor", async () => {
    // Organic India USA (organicindiausa.com) was merged into Organic India; reading it answers with the survivor.
    const brandA = stale({
      name: "Organic India USA",
      companyId: merged,
      domain: "organicindiausa.com",
    });
    const brandB = stale({
      name: "Organic India Kids",
      companyId: merged,
      domain: "organicindiausa.com",
    });
    const organicIndia = { id: survivor, name: "Organic India", website: "organicindia.com" };
    const fake = refreshing([brandA, brandB], {
      companies: { [merged]: organicIndia },
      owners: { "organicindia.com": survivor },
    });

    const result = await fake.run();

    expect(fake.brands.staleMatches).toHaveBeenCalledWith({
      limit: 50,
      checkedBefore: "2026-10-05T10:00:00.000Z",
    });
    expect(fake.companies.get).toHaveBeenCalledOnce();
    expect(fake.companies.resolveDomain).toHaveBeenCalledOnce();
    expect(saved(fake)).toEqual([
      [survivor, "organicindia.com", now.toISOString()],
      [survivor, "organicindia.com", now.toISOString()],
    ]);
    expect(fake.runs.moveCompany).toHaveBeenCalledWith(merged, survivor);
    expect(result.refreshed).toMatchObject({ checked: 2, merged: 2, website: 0, unchanged: 0 });
    expect(result.refreshed?.changes[0]).toEqual({
      brandId: brandA.brandId,
      name: "Organic India USA",
      kind: "merged",
      from: { companyId: merged, domain: "organicindiausa.com" },
      to: { companyId: survivor, domain: "organicindia.com" },
    });
  });

  it("finds the survivor through the brand's domain when the merged company cannot be read", async () => {
    const brand = stale({ name: "MET-Rx", companyId: merged, domain: "metrx.com" });
    const fake = refreshing([brand], {
      companies: {
        [merged]: new Error("Supply Smart refused or failed the call."),
        [survivor]: { id: survivor, name: "MET-Rx", website: "met-rx.com" },
      },
      // A merged company's domains move to the survivor as former domains.
      owners: { "metrx.com": survivor, "met-rx.com": survivor },
    });

    const result = await fake.run();

    expect(fake.companies.get.mock.calls.map(([id]) => id)).toEqual([merged, survivor]);
    expect(saved(fake)).toEqual([[survivor, "met-rx.com", now.toISOString()]]);
    expect(result.refreshed).toMatchObject({ merged: 1 });
    expect(result.errors).toEqual([]);
  });

  it("reports a company that can neither be read nor found by its domain, and changes nothing", async () => {
    const brand = stale({ name: "OP2 Labs", companyId: merged, domain: "op2labs.com" });
    const fake = refreshing([brand], { companies: {}, owners: {} });

    const result = await fake.run();

    expect(fake.brands.upsert).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      {
        brandId: brand.brandId,
        name: "OP2 Labs",
        error:
          "Error: Supply Smart refused or failed the call.; domain op2labs.com resolves to no company " +
          "(unmatched: no company owns this domain); 0 sent products belong to none",
      },
    ]);
  });

  it("takes the one company holding the products we sent when neither the id nor the domain finds it", async () => {
    // OP2 Labs was merged into Frog Fuel: its 11 sent products moved, its id and op2labs.com did not.
    const brand = stale({ name: "OP2 Labs", companyId: merged, domain: "op2labs.com" });
    const fake = refreshing([brand], {
      companies: { [survivor]: { id: survivor, name: "Frog Fuel", website: "frogfuel.com" } },
      owners: { "frogfuel.com": survivor },
      sent: { [brand.brandId]: ["p1", "p2", "p3"] },
      productCompany: { p1: survivor, p2: survivor, p3: survivor },
    });

    const result = await fake.run();

    expect(fake.products.companyOf).toHaveBeenCalledTimes(3);
    expect(saved(fake)).toEqual([[survivor, "frogfuel.com", now.toISOString()]]);
    expect(fake.runs.moveCompany).toHaveBeenCalledWith(merged, survivor);
    expect(result.refreshed).toMatchObject({ merged: 1 });
    expect(result.errors).toEqual([]);
  });

  it("reports a brand whose sent products belong to more than one company", async () => {
    const other = randomUUID();
    const brand = stale({ name: "Split", companyId: merged, domain: "split.com" });
    const fake = refreshing([brand], {
      companies: {},
      owners: {},
      sent: { [brand.brandId]: ["p1", "p2"] },
      productCompany: { p1: survivor, p2: other },
    });

    const result = await fake.run();

    expect(fake.brands.upsert).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toContain(`2 sent products belong to ${survivor}, ${other}`);
  });

  it("replaces a changed website it can confirm, and only records the check of an unchanged company", async () => {
    const other = randomUUID();
    const changed = stale({ name: "Myprotein", domain: "us.myprotein.com" });
    const same = stale({ name: "Same", companyId: other, domain: "same.com" });
    const fake = refreshing([changed, same], {
      companies: {
        [companyId]: { id: companyId, name: "Myprotein", website: "https://www.myprotein.com/" },
        [other]: { id: other, name: "Same", website: "same.com" },
      },
      owners: { "myprotein.com": companyId },
    });

    const result = await fake.run({ limit: 50, checkedBefore: now.toISOString() });

    expect(saved(fake)).toEqual([
      [companyId, "myprotein.com", now.toISOString()],
      [other, "same.com", now.toISOString()],
    ]);
    expect(fake.companies.resolveDomain.mock.calls.map(([domain]) => domain)).toEqual([
      "myprotein.com",
    ]);
    expect(fake.runs.moveCompany).not.toHaveBeenCalled();
    expect(result.refreshed).toMatchObject({ checked: 2, merged: 0, website: 1, unchanged: 1 });
  });

  it("keeps a brand whose new domain Supply Smart resolves to another company, and reports it", async () => {
    const brand = stale({ name: "Metis Nutrition", domain: "fitlifebrands.com" });
    const elsewhere = randomUUID();
    const fake = refreshing([brand], {
      companies: {
        [companyId]: { id: companyId, name: "Fitlife", website: "nutrologyonline.com" },
      },
      owners: { "nutrologyonline.com": elsewhere },
    });

    const result = await fake.run();

    expect(fake.brands.upsert).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toBe(
      `Error: PRODUCT_SYNC.REFRESH_UNCONFIRMED: nutrologyonline.com resolves to matched ${elsewhere}, not ${companyId}`,
    );
  });

  it("keeps the stored domain when the company has no website", async () => {
    const brand = stale({ name: "No Website" });
    const fake = refreshing([brand], {
      companies: { [companyId]: { id: companyId, name: "No Website", website: null } },
      owners: {},
    });

    const result = await fake.run();

    expect(saved(fake)).toEqual([[companyId, "example.com", now.toISOString()]]);
    expect(fake.companies.resolveDomain).not.toHaveBeenCalled();
    expect(result.refreshed).toMatchObject({ unchanged: 1 });
  });

  it("does not refresh unless asked", async () => {
    const fake = refreshing([stale({})], { companies: {}, owners: {} });
    const plain = new BrandCompanyService({
      brands: fake.brands,
      companies: fake.companies,
      now: () => now,
    });
    const result = await plain.matchBrands({ limit: 1 }, signal());
    expect(fake.brands.staleMatches).not.toHaveBeenCalled();
    expect(result.refreshed).toBeUndefined();
  });
});
