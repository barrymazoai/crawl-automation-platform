import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { BrandService, type BrandStore } from "./brand-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});

const brand = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Healthy Origins",
  note: "",
  revision: 1,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
const source = {
  id: "33333333-3333-4333-8333-333333333333",
  brandId: brand.id,
  channel: "wholefoods" as const,
  region: "US",
  url: "https://www.wholefoodsmarket.com/search?text=nordic",
  enabled: false,
  revision: 2,
  createdAt: brand.createdAt,
  updatedAt: brand.updatedAt,
};

function storeWith(found: boolean): BrandStore {
  return {
    list: vi.fn(async () => ({ items: [brand], limit: 25, offset: 0, hasMore: false })),
    find: vi.fn(async () => (found ? brand : null)),
    sources: vi.fn(async () => ({ items: [source], limit: 25, offset: 0, hasMore: false })),
    create: vi.fn(async () => brand),
    update: vi.fn(async () => brand),
    createSource: vi.fn(async () => source),
    updateSource: vi.fn(async () => source),
    toggleSource: vi.fn(async () => source),
  };
}

describe("BrandService", () => {
  it("returns a brand that exists", async () => {
    const service = new BrandService({ brands: storeWith(true), log: silent });

    await expect(service.get("22222222-2222-4222-8222-222222222222")).resolves.toMatchObject({
      name: "Healthy Origins",
    });
  });

  it("reports a missing brand by code", async () => {
    const service = new BrandService({ brands: storeWith(false), log: silent });

    await expect(service.get("22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({
      code: "BRAND.NOT_FOUND",
    });
  });

  const requestId = "44444444-4444-4444-8444-444444444444";
  const ids = { requestId, brandId: brand.id, sourceId: source.id };
  const fields = { channel: "wholefoods" as const, region: "US", url: source.url };

  it.each([
    ["list", { limit: 25, offset: 0, q: "" }],
    ["sources", { brandId: brand.id, limit: 25, offset: 0, q: "" }],
    ["create", { requestId, name: "Healthy Origins", note: "" }],
    ["update", { ...ids, name: "Healthy Origins", note: "", revision: 1 }],
    ["createSource", { requestId, brandId: brand.id, ...fields }],
    ["updateSource", { ...ids, ...fields, revision: 1 }],
    ["toggleSource", { ...ids, enabled: false, revision: 1 }],
  ] as const)("%s passes the request to the brand store unchanged", async (method, input) => {
    const brands = storeWith(true);
    const service = new BrandService({ brands, log: silent });
    const call = service[method] as (value: typeof input) => Promise<unknown>;
    const store = brands[method] as (value: typeof input) => Promise<unknown>;

    await expect(call.call(service, input)).resolves.toEqual(await store(input));
    expect(brands[method]).toHaveBeenCalledWith(input);
  });
});
