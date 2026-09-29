import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { BrandService, type BrandStore } from "./brand-service.js";

const silent = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});

function storeWith(found: boolean): BrandStore {
  const brand = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Healthy Origins",
    note: "",
    revision: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
  };
  return {
    list: vi.fn(),
    find: vi.fn(async () => (found ? brand : null)),
    sources: vi.fn(),
    create: vi.fn(async () => brand),
    update: vi.fn(),
    createSource: vi.fn(),
    updateSource: vi.fn(),
    toggleSource: vi.fn(),
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
});
