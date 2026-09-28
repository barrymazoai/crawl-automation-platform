import { describe, expect, it, vi } from "vitest";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { SwansonLinkCatalog, SwansonProductListSchema } from "./swanson-link-catalog.js";
import { SwansonCaptureConfigSchema } from "./swanson-live-config.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, b: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(b)); return "created" as const; });
}
const requestId = "11111111-1111-4111-8111-111111111111";
const urls = ["https://www.swansonvitamins.com/p/healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels", "https://www.swansonvitamins.com/p/healthy-origins-pycnogenol-100-mg-60-vcaps"];
const scope = { brandId: "22222222-2222-4222-8222-222222222222", sourceId: "33333333-3333-4333-8333-333333333333", channel: "swanson" as const,
  region: "US", rootUrl: "https://www.swansonvitamins.com/collections/brand-healthy-origins", scopeVersion: "source-revision-1" };

describe("Swanson product list catalog", () => {
  it("turns a products.json list into one page of family entries, published and verified; completion stays unknown", async () => {
    const remote = new Memory(), catalog = new SwansonLinkCatalog(new RetainedPublication(new Memory(), remote), { codec: "swanson-product-list/1", urls });
    const page = await catalog.read({ catalogId: requestId, scope, page: 0, cursor: null }, AbortSignal.timeout(5000));
    expect(page.entries).toEqual(urls.map(url => ({ listingId: new URL(url).pathname.slice(3), variantId: null, url, kind: "family" })));
    expect(page.completion).toBe("unknown"); expect(page.nextCursor).toBe(null);
    await expect(catalog.verify(page, AbortSignal.timeout(5000))).resolves.toBeUndefined();
    await expect(catalog.read({ catalogId: requestId, scope: { ...scope, channel: "amazon" }, page: 0, cursor: null }, AbortSignal.timeout(5000))).rejects.toThrow(/LINK_SCOPE_CONFLICT/);
    await expect(catalog.read({ catalogId: requestId, scope, page: 1, cursor: "x" }, AbortSignal.timeout(5000))).rejects.toThrow(/LINK_SCOPE_CONFLICT/);
  });
  it("accepts only unique canonical /p/<handle> URLs", () => {
    const ok = (u: string[]) => SwansonProductListSchema.safeParse({ codec: "swanson-product-list/1", urls: u }).success;
    expect(ok(urls)).toBe(true);
    expect(ok([urls[0]!, urls[0]!])).toBe(false);
    expect(ok([urls[0] + "?variant=46318811709578"])).toBe(false);
    expect(ok(["https://www.swansonvitamins.com/collections/brand-healthy-origins/p/healthy-origins-pycnogenol-100-mg-60-vcaps"])).toBe(false);
    expect(ok(["https://evil.example/p/x"])).toBe(false);
  });
  it("capture config: browser by default, or ScraperAPI with a route that allows swansonvitamins.com", () => {
    expect(SwansonCaptureConfigSchema.parse({ mode: "browser" })).toEqual({ mode: "browser" });
    expect(SwansonCaptureConfigSchema.safeParse({ mode: "scraperapi", route: {}, scraperApi: { apiKey: "short", allowedOrigins: [] } }).success).toBe(false);
  });
});
