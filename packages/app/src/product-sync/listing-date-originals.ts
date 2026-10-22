import type { ListingDateWarning } from "../product-delivery/listing-date-read.js";

/** Exact capture context selected by the same settled-product query as normal sync. */
export interface ListingDateSelection {
  listingId: string;
  variantId: string | null;
  runId: string;
  sourceId: string;
  url: string;
}

export interface ListingDateOriginalsReport {
  checked: number;
  noReadableOriginal: number;
  warnings: (ListingDateSelection & ListingDateWarning)[];
}

export interface ListingDateOriginals {
  inspect(
    selected: ListingDateSelection[],
    signal: AbortSignal,
  ): Promise<ListingDateOriginalsReport>;
}
