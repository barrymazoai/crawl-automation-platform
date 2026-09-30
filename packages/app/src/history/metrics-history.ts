import type { CapturedPage } from "@crawl-automation/channels-core";
import { captureHistoryEntry, type CaptureRun } from "./capture-history.js";
import type { ListingIdentityResolver } from "./listing-identity.js";
import type { ProductHistoryStore } from "./ports.js";

/**
 * The metrics history: every capture of a product page adds one metrics point (price, rating, reviews, stock,
 * sales) to its listing's history, for every channel. A product that is not captured (a skipped listing) adds
 * nothing; the same capture recorded again adds nothing.
 */
export class MetricsHistory {
  constructor(
    private readonly store: ProductHistoryStore,
    private readonly identities: ListingIdentityResolver,
  ) {}

  async record(page: CapturedPage, run: CaptureRun) {
    const entry = captureHistoryEntry(page, run, this.identities);
    const { inserted } = await this.store.append(entry);
    const [listing] = entry.listings;
    const [point] = entry.observations;
    return { inserted, historyListingId: listing?.id ?? null, observationId: point?.id ?? null };
  }
}
