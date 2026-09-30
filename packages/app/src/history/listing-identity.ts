import { canonicalHash } from "./canonical.js";

/** A listing as the history keys it: by its channel site and product ID, else its URL, else unresolved. */
export interface HistoryListing {
  id: string;
  channel: string;
  site: string | null;
  externalId: string | null;
  url: string | null;
  basis: "external-id" | "url" | "unresolved";
  identity: Record<string, unknown>;
}

/** The identity already read by the adapter during capture; its history key may differ from its address key. */
export interface ListingIdentitySource {
  channel: string;
  url: string;
  listingId: string;
  /** Produced by the adapter's externalId hook, or its productAddress when the hook is absent. */
  externalId: string | null;
}

/** The channel adapter validates the address; the application only keys the resolved identity. */
export interface ListingIdentityResolver {
  resolve(page: ListingIdentitySource): {
    site: string;
    url: string;
    externalId: string;
  } | null;
}

/** Stable history keys, with site ownership and product identity supplied through the channel port. */
export function identifyListing(
  page: ListingIdentitySource & { sourceKey: string; dataset: string },
  resolver: ListingIdentityResolver,
): HistoryListing {
  const channel = page.channel.toLowerCase();
  const resolved = resolver.resolve({ ...page, channel });
  const basis = resolved ? "external-id" : "unresolved";
  const site = resolved?.site ?? null;
  const externalId = resolved?.externalId ?? null;
  const identity = resolved ? { channel, site, externalId } : unresolvedIdentity(channel, page);
  return {
    id: canonicalHash(identity),
    channel,
    site,
    externalId,
    url: resolved?.url ?? null,
    basis,
    identity,
  };
}

function unresolvedIdentity(channel: string, page: { dataset: string; sourceKey: string }) {
  return {
    channel,
    dataset: page.dataset,
    sourceKey: page.sourceKey,
    legacyListingId: null,
    reason: "no_verified_channel_anchor",
  };
}
