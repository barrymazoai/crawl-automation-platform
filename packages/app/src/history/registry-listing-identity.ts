import type { ChannelRegistry } from "@crawl-automation/channels-core";
import { text } from "./canonical.js";
import type { ListingIdentityResolver, ListingIdentitySource } from "./listing-identity.js";

/** Builds the identity port from registered adapters, without a second catalog of sites or URL patterns. */
export function listingIdentityResolver(registry: ChannelRegistry): ListingIdentityResolver {
  return {
    resolve(page) {
      const channel = registry.channels().find((id) => id === page.channel);
      if (!channel) {
        return null;
      }
      const adapter = registry.get(channel);
      let address;
      try {
        address = adapter.productAddress(page.url);
      } catch {
        // A refused address has no verified listing; the capture service records an identity failure.
        return null;
      }
      if (address.listingId !== page.listingId) {
        return null;
      }
      return resolvedIdentity(page, address);
    },
  };
}

function resolvedIdentity(
  page: ListingIdentitySource,
  address: { url: string; listingId: string },
) {
  const url = new URL(address.url);
  url.hostname = url.hostname.replace(/^www\./u, "");
  url.hash = "";
  const externalId = text(page.externalId) ?? address.listingId;
  return { site: url.hostname, url: url.toString(), externalId };
}
