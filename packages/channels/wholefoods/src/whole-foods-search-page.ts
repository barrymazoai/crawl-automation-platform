import { z } from "zod";
import { brandScanErrors, type ListingPage } from "@crawl-automation/channels-core";
import { wholeFoodsProductUrl, wholeFoodsProductAddress } from "./whole-foods-address.js";

const SearchAnswerSchema = z.object({
  mainResultSet: z.object({
    availableTotalResultCount: z.number().int().nonnegative().nullish(),
    searchResults: z.array(z.object({ asin: z.string().regex(/^B0[A-Z0-9]{8}$/i) })),
  }),
});

/** Only the API's product ASINs and available count are evidence; approximate totals are ignored. */
export function parseWholeFoodsSearchPage(input: { body: string; page: number; size: number }) {
  let answer;
  try {
    answer = SearchAnswerSchema.parse(JSON.parse(input.body)).mainResultSet;
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.NOT_JSON", { cause: error });
  }
  const products = answer.searchResults.map(({ asin }) => ({
    ...wholeFoodsProductAddress(wholeFoodsProductUrl(asin)),
    title: null,
    kind: "product" as const,
  }));
  const total = answer.availableTotalResultCount ?? null;
  return {
    products,
    cards: products.length,
    cardIds: products.map((product) => product.listingId),
    pageNumber: input.page,
    statedTotal: total,
    // Counts can understate coverage. Only the observed page length ends offset traversal.
    nextPage: products.length >= input.size ? input.page + 1 : null,
  } satisfies ListingPage;
}

/** A total must describe every nonempty page; an empty terminator may report zero. */
export function wholeFoodsSearchTotal(pages: readonly ListingPage[]): number | null {
  const total = pages.find((page) => page.cards > 0)?.statedTotal;
  if (!total || pages.some((page) => !matchesTotal(page, total))) {
    return null;
  }
  return total;
}

function matchesTotal(page: ListingPage, total: number): boolean {
  return page.statedTotal === total || (page.cards === 0 && page.statedTotal === 0);
}

/** Deduplicated coverage of a consistent API count proves a read or the two-read union. */
export function wholeFoodsSearchComplete(pages: readonly ListingPage[]): boolean {
  const total = wholeFoodsSearchTotal(pages);
  if (!total || pages.at(-1)?.nextPage !== null) {
    return false;
  }
  const unique = new Set(pages.flatMap((page) => page.cardIds ?? []));
  return unique.size === total;
}
