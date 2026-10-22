import type {
  ListingDateOriginals,
  ListingDateOriginalsReport,
  ListingDateSelection,
} from "@crawl-automation/app";
import { errorCodeOf } from "@crawl-automation/platform";
import type { MarketplaceReaderDependencies } from "./marketplace-materials.js";
import { marketplaceHistory } from "./marketplace-history.js";
import { marketplaceListingDate, unavailableListingDate } from "./marketplace-listing-date.js";

/** Read-only audit of precisely the previewed/reopened captures; never reads a product or donor projection. */
export class RetainedListingDateOriginals implements ListingDateOriginals {
  constructor(private readonly deps: MarketplaceReaderDependencies) {}

  async inspect(
    selected: ListingDateSelection[],
    signal: AbortSignal,
  ): Promise<ListingDateOriginalsReport> {
    const warnings: ListingDateOriginalsReport["warnings"] = [];
    for (const selection of selected) {
      signal.throwIfAborted();
      const result = await this.read(selection, signal);
      if ("dateFirstAvailableWarning" in result) {
        warnings.push({ ...selection, ...result.dateFirstAvailableWarning });
      }
    }
    return { checked: selected.length, noReadableOriginal: warnings.length, warnings };
  }

  private async read(selection: ListingDateSelection, signal: AbortSignal) {
    try {
      const history = await marketplaceHistory(this.deps.database, {
        ...selection,
        channel: "amazon",
      });
      if (history.listing.externalId !== selection.listingId) {
        return unavailableListingDate(this.deps, { ...selection, reason: "identity_mismatch" });
      }
      return await marketplaceListingDate(this.deps, history, signal);
    } catch (error) {
      signal.throwIfAborted();
      const code = errorCodeOf(error) ?? (error instanceof Error ? error.name : "UnknownError");
      return unavailableListingDate(this.deps, {
        ...selection,
        reason: "history_unavailable",
        code,
      });
    }
  }
}
