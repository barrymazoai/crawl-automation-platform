import { appErrors, type BrandScanService, type BrandSourceImport } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./server.js";

function appWith(services: {
  brandScans?: Partial<BrandScanService>;
  brandSources?: Partial<BrandSourceImport>;
}) {
  const unused = {} as never;
  return createHttpApp({
    runs: unused,
    queue: unused,
    brands: unused,
    reviews: unused,
    products: unused,
    originals: unused,
    history: unused,
    resources: unused,
    fleet: unused,
    listingStates: unused,
    brandScans: (services.brandScans ?? unused) as BrandScanService,
    brandSources: (services.brandSources ?? unused) as BrandSourceImport,
  });
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("brand scan procedures", () => {
  it.each(["gnc", "costco"])("requests scans of %s enabled sources", async (channel) => {
    const request = vi.fn(async () => []);
    const input = { requestId: "11111111-1111-4111-8111-111111111111", channel };
    const response = await appWith({ brandScans: { request } }).request(
      "/trpc/brands.scan",
      post(input),
    );
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledWith(input);
  });

  it("imports a channel's brand directory", async () => {
    const answer = { created: 1, existing: 0, looseMatches: [], unmatched: [], refused: [] };
    const importer = vi.fn(async () => answer);
    const input = {
      channel: "swanson",
      entries: [
        { name: "NOW Foods", url: "https://www.swansonvitamins.com/collections/brand-now-foods" },
      ],
    };
    const response = await appWith({ brandSources: { import: importer } }).request(
      "/trpc/brands.importSources",
      post(input),
    );
    expect(response.status).toBe(200);
    expect(importer).toHaveBeenCalledWith(input);
  });

  it("refuses a channel that cannot be scanned before any service runs", async () => {
    const request = vi.fn(async () => []);
    const input = { requestId: "11111111-1111-4111-8111-111111111111", channel: "unknown" };
    const response = await appWith({ brandScans: { request } }).request(
      "/trpc/brands.scan",
      post(input),
    );
    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("answers one scan with its revisit outcomes", async () => {
    const scanId = "22222222-2222-4222-8222-222222222222";
    const detail = { scanId, revisits: { requested: 2, live: 1, unlisted: {}, pending: 1 } };
    const get = vi.fn(async () => detail);
    const query = encodeURIComponent(JSON.stringify({ scanId }));
    const response = await appWith({ brandScans: { get } as never }).request(
      `/trpc/brands.scanGet?input=${query}`,
    );
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(scanId);
    expect((await response.json()).result.data).toEqual(detail);
  });

  it("answers 404 for an unknown scan", async () => {
    const get = vi.fn(async () => {
      throw appErrors.create("SCAN.NOT_FOUND");
    });
    const query = encodeURIComponent(
      JSON.stringify({ scanId: "22222222-2222-4222-8222-222222222222" }),
    );
    const response = await appWith({ brandScans: { get } as never }).request(
      `/trpc/brands.scanGet?input=${query}`,
    );
    expect(response.status).toBe(404);
  });
});
