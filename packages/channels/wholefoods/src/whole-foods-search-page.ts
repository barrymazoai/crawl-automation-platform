import { z } from "zod";
import { brandScanErrors, type ListingPage } from "@crawl-automation/channels-core";
import { wholeFoodsProductUrl, wholeFoodsProductAddress } from "./whole-foods-address.js";

const SearchAnswerSchema = z.object({
  mainResultSet: z.object({
    availableTotalResultCount: z.number().int().nonnegative(),
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
  const total = answer.availableTotalResultCount;
  return {
    products,
    cards: products.length,
    cardIds: products.map((product) => product.listingId),
    pageNumber: input.page,
    statedTotal: total,
    nextPage: input.page * input.size < total ? input.page + 1 : null,
  } satisfies ListingPage;
}

/** Fail closed on changing counts or duplicates that could hide products between offsets. */
export function wholeFoodsSearchComplete(pages: readonly ListingPage[]): boolean {
  const total = pages[0]?.statedTotal;
  if (!total || pages.at(-1)?.nextPage !== null) {
    return false;
  }
  const unique = new Set(pages.flatMap((page) => page.cardIds ?? []));
  return unique.size === total && pages.every((page) => page.statedTotal === total);
}
