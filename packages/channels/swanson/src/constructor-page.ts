import {
  brandScanErrors,
  type ListedProduct,
  type ListingPage,
} from "@crawl-automation/channels-core";
import { z } from "zod";
import { SWANSON_ORIGIN, swansonProductAddress } from "./swanson-address.js";

export const CONSTRUCTOR_ORIGIN = "https://ac.cnstrc.com";
export const CONSTRUCTOR_PAGE_SIZE = 100;
export const CONSTRUCTOR_MAX_PAGES = 250;

const ProductDataSchema = z.object({
  url: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});
const CardSchema = z.object({
  value: z.string().trim().min(1),
  data: ProductDataSchema.extend({ id: z.string().min(1) }),
  variations: z.array(z.object({ data: ProductDataSchema })).default([]),
});
const ResponseSchema = z.object({
  response: z.object({
    total_num_results: z.number().int().nonnegative(),
    results: z.array(CardSchema).max(CONSTRUCTOR_PAGE_SIZE),
  }),
});

function responseOf(body: string) {
  try {
    return ResponseSchema.parse(JSON.parse(body)).response;
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.NOT_JSON", { cause: error });
  }
}

/** Product capture uses handles, not Constructor SKUs or numeric Shopify IDs. */
function product(handle: string, title: string): ListedProduct {
  const address = swansonProductAddress(`${SWANSON_ORIGIN}/p/${handle}`);
  return {
    url: address.url.href,
    listingId: address.handle,
    variantId: address.variantId,
    title,
    kind: "product",
  };
}

export function parseConstructorPage(input: { body: string; url: string; page: number }) {
  const { results, total_num_results: total } = responseOf(input.body);
  const products = results.flatMap((card) => [
    product(card.data.url, card.value),
    ...card.variations.map((variation) => product(variation.data.url, card.value)),
  ]);
  const more = input.page * CONSTRUCTOR_PAGE_SIZE < total;
  const capped = more && input.page === CONSTRUCTOR_MAX_PAGES;
  return {
    pageNumber: input.page,
    cardIds: results.map((card) => card.data.id),
    cards: results.length,
    products: [...new Map(products.map((item) => [item.listingId, item])).values()],
    statedTotal: total,
    nextPage: more && !capped ? input.page + 1 : null,
    capped,
  };
}

/** Variations never count toward the card total; duplicates and changing totals fail closed. */
export function constructorComplete(pages: readonly ListingPage[]): boolean {
  const total = pages[0]?.statedTotal;
  if (total === undefined || total === null || !Number.isSafeInteger(total) || total < 0) {
    return false;
  }
  const expectedPages = Math.max(1, Math.ceil(total / CONSTRUCTOR_PAGE_SIZE));
  const chained =
    pages.length === expectedPages &&
    pages.every((page, index) => {
      const expectedCards = Math.min(CONSTRUCTOR_PAGE_SIZE, total - index * CONSTRUCTOR_PAGE_SIZE);
      return (
        page.pageNumber === index + 1 &&
        page.statedTotal === total &&
        page.cards === expectedCards &&
        page.cardIds?.length === expectedCards &&
        page.nextPage === (index === pages.length - 1 ? null : index + 2)
      );
    });
  const distinct = new Set(pages.flatMap((page) => page.cardIds ?? []));
  return chained && distinct.size === total;
}
