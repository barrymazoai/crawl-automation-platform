import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CompanyResolution } from "@crawl-automation/v3-contracts";
import { BrandCompanyService } from "./brand-company.js";
import {
  BRAND_COMPANY_CANDIDATE_LIMIT,
  type BrandCompanyMatch,
  type SyncBrand,
} from "./brand-company-model.js";

const now = new Date("2026-10-12T10:00:00.000Z");
const companyId = randomUUID();
const counts = { amazon: 1, gnc: 0, swanson: 0, wholefoods: 0, costco: 0 };
function brand(overrides: Partial<SyncBrand> = {}): SyncBrand {
  return {
    brandId: randomUUID(),
    name: "Example",
    productCounts: counts,
    dtcDomain: null,
    match: null,
    ...overrides,
  };
}
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
function setup(items = [brand()]) {
  const brands = {
    candidates: vi.fn(async () => items),
    list: vi.fn(async () => items),
    upsert: vi.fn(async (_match: BrandCompanyMatch) => undefined),
    matches: vi.fn(async () => [] as BrandCompanyMatch[]),
    moveCompany: vi.fn(async () => 0),
  };
  const companies = {
    resolve: vi.fn(async (): Promise<CompanyResolution> => ({
      status: "matched",
      companyId,
      matchedBy: "name",
      matches: [],
      reason: "exact",
    })),
    get: vi.fn(async () => ({
      id: companyId,
      name: "Example Inc.",
      website: "https://www.Example.com/catalog?ref=brand" as string | null,
    })),
    create: vi.fn(),
  };
  const service = new BrandCompanyService({ brands, companies, now: () => now });
  return { brands, companies, service };
}

describe("marketplace brand company matching", () => {
  it("resolves by name and DTC domain, storing the company's authoritative website", async () => {
    const item = brand({ dtcDomain: "catalog.example.co.uk" });
    const { brands, companies, service } = setup([item]);
    const signal = new AbortController().signal;
    expect(await service.matchBrands({ limit: 5 }, signal)).toEqual({
      checked: 1,
      matched: 1,
      ambiguous: 0,
      unmatched: 0,
      errors: [],
    });
    expect(companies.resolve).toHaveBeenCalledExactlyOnceWith(
      { name: item.name, domain: item.dtcDomain },
      signal,
    );
    expect(companies.get).toHaveBeenCalledExactlyOnceWith(companyId, signal);
    expect(brands.upsert).toHaveBeenCalledExactlyOnceWith({
      brandId: item.brandId,
      status: "matched",
      companyId,
      domain: "example.com",
      matchedBy: "name",
      candidates: [],
      checkedAt: now.toISOString(),
    });
    expect(brands.candidates).toHaveBeenCalledWith({
      limit: 5,
      checkedBefore: "2026-10-11T10:00:00.000Z",
      recheckUnmatched: false,
    });
    expect(companies.create).not.toHaveBeenCalled();
  });

  it("omits an absent DTC hint and stores an unmatched resolution", async () => {
    const { brands, companies, service } = setup();
    companies.resolve.mockResolvedValue({
      status: "unmatched",
      companyId: null,
      matchedBy: null,
      matches: [],
      reason: "absent",
    });
    expect(await service.matchBrands({ limit: 1 })).toMatchObject({
      checked: 1,
      unmatched: 1,
      errors: [],
    });
    expect(companies.resolve.mock.calls[0]).toEqual([{ name: "Example" }, expect.any(AbortSignal)]);
    expect(brands.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unmatched",
        companyId: null,
        domain: null,
        candidates: [],
      }),
    );
    expect(companies.get).not.toHaveBeenCalled();
    expect(companies.create).not.toHaveBeenCalled();
  });

  it("stores unique ambiguous company IDs with a fixed cap and never selects a company", async () => {
    const { brands, companies, service } = setup();
    const ids = Array.from({ length: 30 }, () => randomUUID());
    companies.resolve.mockResolvedValue({
      status: "ambiguous",
      companyId: null,
      matchedBy: null,
      reason: "multiple",
      matches: [ids[0], ...ids].map((id) => ({
        companyId: id as string,
        name: "Example",
        matchedBy: "name",
      })),
    });
    expect(await service.matchBrands({ limit: 1 })).toMatchObject({ ambiguous: 1, errors: [] });
    expect(brands.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ambiguous",
        companyId: null,
        domain: null,
        candidates: ids.slice(0, BRAND_COMPANY_CANDIDATE_LIMIT),
      }),
    );
    expect(companies.get).not.toHaveBeenCalled();
  });

  it.each([null, "", "   ", "not a website"])(
    "stores no_website for unusable website %j without using the DTC hint",
    async (website) => {
      const { brands, companies, service } = setup([brand({ dtcDomain: "catalog.example.com" })]);
      companies.get.mockResolvedValue({ id: companyId, name: "Example", website });
      expect(await service.matchBrands({ limit: 1 })).toMatchObject({
        unmatched: 1,
        matched: 0,
        errors: [],
      });
      expect(brands.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "unmatched",
          matchedBy: "no_website",
          companyId: null,
          domain: null,
        }),
      );
    },
  );

  it.each([
    "www.Example.co.uk",
    "http://WWW.Example.co.uk:8080/catalog",
    " https://www.example.co.uk./ ",
  ])("normalizes %s without guessing a public suffix", async (website) => {
    const { brands, companies, service } = setup();
    companies.get.mockResolvedValue({ id: companyId, name: "Example", website });
    await service.matchBrands({ limit: 1 });
    expect(brands.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "example.co.uk" }),
    );
  });

  it.each(["resolve", "get", "upsert"] as const)(
    "records a %s failure and continues without fabricating an unmatched decision",
    async (operation) => {
      const first = brand();
      const second = brand();
      const { brands, companies, service } = setup([first, second]);
      const failing = operation === "upsert" ? brands.upsert : companies[operation];
      failing.mockRejectedValueOnce(new Error("network unavailable"));
      const result = await service.matchBrands({ limit: 2 });
      expect(result).toMatchObject({
        checked: 2,
        matched: 1,
        unmatched: 0,
        errors: [{ brandId: first.brandId, name: first.name, error: "Error: network unavailable" }],
      });
      expect(brands.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ brandId: second.brandId, status: "matched" }),
      );
      if (operation !== "upsert") {
        expect(brands.upsert).toHaveBeenCalledOnce();
      }
    },
  );

  it("rejects inconsistent resolved identity before saving a result", async () => {
    const { brands, companies, service } = setup();
    companies.get.mockResolvedValue({ id: randomUUID(), name: "Other", website: "other.example" });
    expect(await service.matchBrands({ limit: 1 })).toMatchObject({
      checked: 1,
      matched: 0,
      errors: [{ error: expect.stringContaining("inconsistent company identity") }],
    });
    expect(brands.upsert).not.toHaveBeenCalled();
  });

  it("skips recent waiting brands and all matched brands, but checks stale waiting results", async () => {
    const recent = brand({ match: match() });
    const ambiguous = brand({ match: match({ status: "ambiguous" }) });
    const matched = brand({
      match: match({
        status: "matched",
        companyId,
        domain: "example.com",
        checkedAt: "2026-01-01T00:00:00Z",
      }),
    });
    const stale = brand({ match: match({ checkedAt: "2026-10-11T10:00:00.000Z" }) });
    const { companies, service } = setup([recent, ambiguous, matched, stale]);
    expect(await service.matchBrands({ limit: 4 })).toMatchObject({ checked: 1 });
    expect(companies.resolve).toHaveBeenCalledOnce();
  });

  it("explicit recheck includes recent unmatched and ambiguous, while retaining matched brands", async () => {
    const { brands, service } = setup([
      brand({ match: match() }),
      brand({ match: match({ status: "ambiguous" }) }),
      brand({ match: match({ status: "matched", companyId, domain: "example.com" }) }),
    ]);
    expect(await service.matchBrands({ limit: 3, recheckUnmatched: true })).toMatchObject({
      checked: 2,
    });
    expect(brands.candidates).toHaveBeenCalledWith(
      expect.objectContaining({ recheckUnmatched: true }),
    );
  });

  it("is sequential and processes no more than the requested limit", async () => {
    const { brands, companies, service } = setup([brand(), brand(), brand()]);
    const events: string[] = [];
    companies.resolve.mockImplementation(async () => {
      events.push("resolve");
      await Promise.resolve();
      return { status: "matched", companyId, matchedBy: "name", matches: [], reason: "exact" };
    });
    companies.get.mockImplementation(async () => {
      events.push("get");
      return { id: companyId, name: "Example", website: "example.com" };
    });
    brands.upsert.mockImplementation(async () => {
      events.push("save");
    });
    expect(await service.matchBrands({ limit: 2 })).toMatchObject({ checked: 2 });
    expect(events).toEqual(["resolve", "get", "save", "resolve", "get", "save"]);
  });

  it("honors an already aborted signal before repository access", async () => {
    const { brands, service } = setup();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(service.matchBrands({ limit: 1 }, controller.signal)).rejects.toThrow("cancelled");
    expect(brands.candidates).not.toHaveBeenCalled();
  });

  it.each(["resolve", "get"] as const)(
    "stops after cancellation during %s and never saves or starts the next brand",
    async (operation) => {
      const { brands, companies, service } = setup([brand(), brand()]);
      const controller = new AbortController();
      companies[operation].mockImplementationOnce(async () => {
        controller.abort(new Error("cancelled"));
        throw new Error("request stopped");
      });
      await expect(service.matchBrands({ limit: 2 }, controller.signal)).rejects.toThrow(
        "cancelled",
      );
      expect(companies.resolve).toHaveBeenCalledOnce();
      expect(brands.upsert).not.toHaveBeenCalled();
    },
  );

  it("does not save if a client returns successfully after cancellation", async () => {
    const { brands, companies, service } = setup();
    const controller = new AbortController();
    companies.get.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled"));
      return { id: companyId, name: "Example", website: "example.com" };
    });
    await expect(service.matchBrands({ limit: 1 }, controller.signal)).rejects.toThrow("cancelled");
    expect(brands.upsert).not.toHaveBeenCalled();
  });

  it.each([0, 501, 1.5])("rejects invalid limit %s before doing work", async (limit) => {
    const { brands, service } = setup();
    await expect(service.matchBrands({ limit })).rejects.toThrow();
    expect(brands.candidates).not.toHaveBeenCalled();
  });

  it("lists saved status and product counts through the repository without Supply Smart calls", async () => {
    const items = [brand()];
    const { brands, companies, service } = setup(items);
    expect(await service.brands({ status: "ambiguous", limit: 5 })).toEqual(items);
    expect(brands.list).toHaveBeenCalledExactlyOnceWith({ status: "ambiguous", limit: 5 });
    await service.brands({});
    expect(brands.list).toHaveBeenLastCalledWith({ limit: 100 });
    expect(companies.resolve).not.toHaveBeenCalled();
  });
});
