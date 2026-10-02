import { expect, it } from "vitest";
import { storedDtcSites } from "./stored-settings.js";
import { createDtcAdapter } from "./adapter.js";
import { dtcSitePolicy } from "./site-policy.js";
import { ChannelRegistry } from "@crawl-automation/channels-core";
const setting = (name: string) => ({
  siteKey: "shop.example",
  platform: "shopify",
  kind: "multi-brand",
  brands: [{ brand: name, catalogUrl: `https://shop.example/collections/vendors?q=${name}` }],
});
it("refreshes persisted sources into a running registry and keeps brand URL validation", async () => {
  const rows: unknown[] = [];
  const registry = new ChannelRegistry([createDtcAdapter()]).withRefresh(async () => [
    createDtcAdapter(storedDtcSites([], rows)),
  ]);
  expect(() => registry.get("dtc").productAddress("https://shop.example/products/alpha")).toThrow();
  rows.push(setting("Alpha"), setting("Beta"));
  await registry.refresh();
  expect(registry.get("dtc").productAddress("https://shop.example/products/alpha").url).toBe(
    "https://shop.example/products/alpha",
  );
  const alpha = registry.forBrandSource("dtc", setting("Alpha").brands[0]?.catalogUrl);
  expect(() =>
    alpha.assertBrandSource?.({
      brandName: "Beta",
      url: setting("Alpha").brands[0]?.catalogUrl ?? "",
    }),
  ).toThrow();
});
it("a sub-brand policy is bound to its own domain, not its parent", () => {
  expect(() => storedDtcSites([], [{ ...setting("Alpha"), siteKey: "parent.example" }])).toThrow();
});
it("preserves configured single-brand source semantics when a new catalog is added", () => {
  const legacy = dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    catalogUrl: "https://shop.example/collections/all",
  });
  const sites = storedDtcSites([legacy], [setting("Beta")]);
  const adapter = createDtcAdapter(sites);
  expect(() =>
    adapter
      .forBrandSource(legacy.catalogUrl ?? "")
      .assertBrandSource?.({ url: legacy.catalogUrl ?? "", brandName: "Original" }),
  ).not.toThrow();
  expect(
    adapter.forBrandSource(setting("Beta").brands[0]?.catalogUrl ?? "").brandSources,
  ).toMatchObject([{ brand: "Beta" }]);
});
