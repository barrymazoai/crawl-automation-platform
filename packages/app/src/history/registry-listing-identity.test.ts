import { ChannelRegistry } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import { identifyListing } from "./listing-identity.js";
import { fakeAdapter } from "./listing-test-helpers.js";
import { listingIdentityResolver } from "./registry-listing-identity.js";

const page = {
  channel: "gnc",
  listingId: "listing",
  externalId: "SKU-42",
  url: "https://www.catalog.example/products/listing?size=2#details",
  sourceKey: "capture",
  dataset: "products",
};

describe("registry listing identity with a fake channel adapter", () => {
  it("uses the adapter address, strips www and fragment, and preserves variant query data", () => {
    const adapter = fakeAdapter();
    const resolver = listingIdentityResolver(new ChannelRegistry([adapter]));
    expect(resolver.resolve(page)).toEqual({
      site: "catalog.example",
      externalId: "SKU-42",
      url: "https://catalog.example/products/listing?size=2",
    });
    expect(adapter.productAddress).toHaveBeenCalledExactlyOnceWith(page.url);
    expect(adapter.parseProduct).not.toHaveBeenCalled();
  });

  it.each([null, "", "  "])(
    "falls back to the adapter listing ID for externalId=%j",
    (externalId) => {
      const resolver = listingIdentityResolver(new ChannelRegistry([fakeAdapter()]));
      expect(resolver.resolve({ ...page, externalId })?.externalId).toBe("listing");
    },
  );

  it("trims a supplied external ID without replacing it with the address key", () => {
    const resolver = listingIdentityResolver(new ChannelRegistry([fakeAdapter()]));
    expect(resolver.resolve({ ...page, externalId: "  SKU-42  " })?.externalId).toBe("SKU-42");
  });

  it("refuses an unregistered channel without consulting an adapter", () => {
    const adapter = fakeAdapter();
    const resolver = listingIdentityResolver(new ChannelRegistry([adapter]));
    expect(resolver.resolve({ ...page, channel: "unknown" })).toBeNull();
    expect(adapter.productAddress).not.toHaveBeenCalled();
  });

  it("keeps refused addresses unresolved", () => {
    const adapter = fakeAdapter({
      productAddress: vi.fn(() => {
        throw new Error("refused");
      }),
    });
    const resolver = listingIdentityResolver(new ChannelRegistry([adapter]));
    expect(resolver.resolve(page)).toBeNull();
    expect(adapter.productAddress).toHaveBeenCalledOnce();
  });

  it("refuses an address whose listing differs from the captured identity", () => {
    const resolver = listingIdentityResolver(new ChannelRegistry([fakeAdapter()]));
    expect(resolver.resolve({ ...page, listingId: "other-listing" })).toBeNull();
  });
});

describe("identifyListing identity boundaries", () => {
  it("normalizes the channel before resolving and uses only site and external ID for the key", () => {
    const resolver = listingIdentityResolver(new ChannelRegistry([fakeAdapter()]));
    const resolve = vi.spyOn(resolver, "resolve");
    const first = identifyListing({ ...page, channel: "GNC" }, resolver);
    const second = identifyListing(
      { ...page, url: "https://www.catalog.example/new", sourceKey: "next" },
      resolver,
    );
    expect(resolve).toHaveBeenNthCalledWith(1, page);
    expect(first.id).toBe(second.id);
    expect(first.identity).toEqual({
      channel: "gnc",
      site: "catalog.example",
      externalId: "SKU-42",
    });
    expect(first.basis).toBe("external-id");
  });

  it("keeps unresolved identities local to their dataset and source, without trusting raw IDs or URLs", () => {
    const resolver = { resolve: vi.fn(() => null) };
    const first = identifyListing(page, resolver);
    expect(first).toMatchObject({ basis: "unresolved", site: null, externalId: null, url: null });
    expect(first.identity).toEqual({
      channel: "gnc",
      dataset: "products",
      sourceKey: "capture",
      legacyListingId: null,
      reason: "no_verified_channel_anchor",
    });
    expect(identifyListing({ ...page, externalId: "untrusted", url: "invalid" }, resolver).id).toBe(
      first.id,
    );
    expect(identifyListing({ ...page, sourceKey: "next" }, resolver).id).not.toBe(first.id);
    expect(identifyListing({ ...page, dataset: "other" }, resolver).id).not.toBe(first.id);
  });

  it("does not hide unexpected resolver failures", () => {
    const failure = new Error("registry unavailable");
    const resolver = {
      resolve: () => {
        throw failure;
      },
    };
    expect(() => identifyListing(page, resolver)).toThrow(failure);
  });
});
