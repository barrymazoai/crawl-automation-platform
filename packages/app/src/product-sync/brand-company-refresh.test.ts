import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BrandCompanyService } from "./brand-company.js";
import type { BrandCompanyMatch, NamedBrandCompanyMatch } from "./brand-company-model.js";

const now = new Date("2026-10-12T10:00:00.000Z");
const companyId = randomUUID();

function match(overrides: Partial<BrandCompanyMatch> = {}): BrandCompanyMatch {
  return {
    brandId: randomUUID(),
    status: "unmatched",
    companyId: null,
    domain: null,
    matchedBy: null,
    candidates: [],
    checkedAt: now.toISOString(),
    ...overrides,
  };
}

function setup() {
  const brands = {
    candidates: vi.fn(async () => []),
    list: vi.fn(async () => []),
    upsert: vi.fn(async (_match: BrandCompanyMatch) => undefined),
    matches: vi.fn(async () => [] as BrandCompanyMatch[]),
    moveCompany: vi.fn(async () => 0),
    staleMatches: vi.fn(
      async (_filter: { limit: number; checkedBefore: string }) => [] as NamedBrandCompanyMatch[],
    ),
  };
  const companies = {
    resolve: vi.fn(),
    get: vi.fn(async (id: string) => ({
      id,
      name: "Example Inc.",
      website: "example.com" as string | null,
    })),
  };
  return { brands, companies };
}

describe("refresh of matched brands (2026-11-14)", () => {
  const merged = randomUUID();
  const survivor = randomUUID();
  function stale(overrides: Partial<NamedBrandCompanyMatch>): NamedBrandCompanyMatch {
    return {
      ...match({ status: "matched", companyId, domain: "example.com", matchedBy: "name" }),
      checkedAt: "2026-10-01T00:00:00.000Z",
      name: "Example",
      ...overrides,
    };
  }
  function refreshing(matches: NamedBrandCompanyMatch[]) {
    const fake = setup();
    fake.brands.staleMatches.mockResolvedValue(matches);
    const runs = { moveCompany: vi.fn(async () => 1) };
    const service = new BrandCompanyService({
      brands: fake.brands,
      companies: fake.companies,
      runs,
      now: () => now,
    });
    return { ...fake, runs, service };
  }

  it("follows a merged company to its survivor and carries the survivor's website", async () => {
    // Organic India USA (organicindiausa.com) was merged into Organic India; Supply Smart answers with the survivor.
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
    const fake = refreshing([brandA, brandB]);
    fake.companies.get.mockResolvedValue({
      id: survivor,
      name: "Organic India",
      website: "organicindia.com",
    });

    const result = await fake.service.matchBrands(
      { limit: 1, refreshMatched: { limit: 50 } },
      new AbortController().signal,
    );

    expect(fake.brands.staleMatches).toHaveBeenCalledWith({
      limit: 50,
      checkedBefore: "2026-10-05T10:00:00.000Z",
    });
    expect(fake.companies.get).toHaveBeenCalledOnce();
    expect(fake.companies.get).toHaveBeenCalledWith(merged, expect.anything());
    expect(fake.brands.upsert.mock.calls.map(([saved]) => saved)).toEqual(
      [brandA, brandB].map(({ name: _name, ...saved }) => ({
        ...saved,
        companyId: survivor,
        domain: "organicindia.com",
        checkedAt: now.toISOString(),
      })),
    );
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

  it("replaces a changed website and only records the check of an unchanged company", async () => {
    const other = randomUUID();
    const changed = stale({ name: "Myprotein", domain: "us.myprotein.com" });
    const same = stale({ name: "Same", companyId: other, domain: "same.com" });
    const fake = refreshing([changed, same]);
    fake.companies.get.mockImplementation(async (id: string) =>
      id === companyId
        ? { id, name: "Myprotein", website: "https://www.myprotein.com/" }
        : { id, name: "Same", website: "same.com" },
    );

    const result = await fake.service.matchBrands(
      { limit: 1, refreshMatched: { limit: 50, checkedBefore: now.toISOString() } },
      new AbortController().signal,
    );

    expect(fake.brands.upsert.mock.calls.map(([saved]) => [saved.companyId, saved.domain])).toEqual(
      [
        [companyId, "myprotein.com"],
        [other, "same.com"],
      ],
    );
    expect(fake.runs.moveCompany).not.toHaveBeenCalled();
    expect(result.refreshed).toMatchObject({ checked: 2, merged: 0, website: 1, unchanged: 1 });
  });

  it("keeps the stored domain when the company has no website, and changes nothing on a refused read", async () => {
    const refused = randomUUID();
    const kept = stale({ name: "No Website" });
    const failed = stale({ name: "OP2 Labs", companyId: refused, domain: "op2labs.com" });
    const fake = refreshing([kept, failed]);
    fake.companies.get.mockImplementation(async (id: string) => {
      if (id === refused) {
        throw new Error("Supply Smart refused or failed the call.");
      }
      return { id, name: "No Website", website: null };
    });

    const result = await fake.service.matchBrands(
      { limit: 1, refreshMatched: { limit: 50 } },
      new AbortController().signal,
    );

    expect(fake.brands.upsert).toHaveBeenCalledOnce();
    expect(fake.brands.upsert.mock.calls[0]?.[0]).toMatchObject({
      domain: "example.com",
      companyId,
    });
    expect(result.refreshed).toMatchObject({ checked: 2, unchanged: 1 });
    expect(result.errors).toEqual([
      {
        brandId: failed.brandId,
        name: "OP2 Labs",
        error: "Error: Supply Smart refused or failed the call.",
      },
    ]);
  });

  it("does not refresh unless asked", async () => {
    const fake = refreshing([stale({})]);
    const result = await fake.service.matchBrands({ limit: 1 }, new AbortController().signal);
    expect(fake.brands.staleMatches).not.toHaveBeenCalled();
    expect(result.refreshed).toBeUndefined();
  });
});
