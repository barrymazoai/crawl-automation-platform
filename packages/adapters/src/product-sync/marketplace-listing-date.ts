import type { ListingDateRead, ListingDateWarning } from "@crawl-automation/app";
import type {
  MarketplaceChannels,
  MarketplaceHistory,
} from "@crawl-automation/app/marketplace-mapping";
import {
  createLogger,
  errorCodeOf,
  type Logger,
  type ObjectStore,
} from "@crawl-automation/platform";
import { retainedValue } from "../product-delivery/retained-value.js";

const log = createLogger({ name: "amazon-dfa" });
export interface ListingDateDependencies {
  objects: Pick<ObjectStore, "read">;
  channels: MarketplaceChannels;
  log?: Pick<Logger, "warn">;
}

/** Only DFA escapes this reparse; retained label projections must never be replaced with today's parse. */
export async function marketplaceListingDate(
  deps: ListingDateDependencies,
  history: MarketplaceHistory,
  signal: AbortSignal,
): Promise<ListingDateRead> {
  let warning: ListingDateWarning = { reason: "missing" };
  for (const reference of history.evidence) {
    try {
      const raw = await retainedValue(deps.objects, reference, signal);
      signal.throwIfAborted();
      if (typeof raw === "string") {
        return parseOriginal(deps, history, raw);
      }
    } catch (error) {
      signal.throwIfAborted();
      const code = errorCodeOf(error) ?? (error instanceof Error ? error.name : "UnknownError");
      warning = {
        reason:
          code === "PRODUCT_DELIVERY.INTEGRITY"
            ? "hash_mismatch"
            : code === "NoSuchKey"
              ? "missing"
              : "unreadable",
        code,
      };
    }
  }
  signal.throwIfAborted();
  return unavailableListingDate(deps, {
    ...warning,
    runId: history.owner.runId,
    listingId: history.listing.externalId,
    observationId: history.observationId,
  });
}

function parseOriginal(
  deps: ListingDateDependencies,
  history: MarketplaceHistory,
  html: string,
): ListingDateRead {
  const parsed = deps.channels.get("amazon").parseProduct({
    html,
    url: history.listing.url,
    capturedAt: history.capturedAt,
  });
  if (
    history.listing.channel !== "amazon" ||
    parsed.channel !== "amazon" ||
    parsed.identity.listingId !== history.listing.externalId ||
    parsed.identity.variantId !== history.capture.variantId
  ) {
    return unavailableListingDate(deps, {
      reason: "identity_mismatch",
      runId: history.owner.runId,
      listingId: history.listing.externalId,
      observationId: history.observationId,
    });
  }
  return { dateFirstAvailable: parsed.commerce?.dateFirstAvailable ?? null };
}

export function unavailableListingDate(
  deps: Pick<ListingDateDependencies, "log">,
  warning: ListingDateWarning & { runId: string; listingId: string; observationId?: string },
): ListingDateRead {
  (deps.log ?? log).warn(warning, "Amazon original unavailable; omitting optional DFA");
  const { reason, code } = warning;
  return { dateFirstAvailableWarning: { reason, ...(code ? { code } : {}) } };
}
