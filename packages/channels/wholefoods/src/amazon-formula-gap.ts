/** An Amazon product to queue, in the shared queue's product shape (`sourceId`, `url`, `listingId`, `variantId`). */
export interface AmazonProductToQueue {
  sourceId: string;
  url: string;
  listingId: string;
  variantId: null;
}

/**
 * A Whole Foods product whose ASIN has no Amazon formula yet, as the Amazon product whose page the formula is
 * extracted from (Whole Foods shows fewer images than Amazon). Its Whole Foods metrics are recorded meanwhile.
 * `sourceId` is the brand's Amazon source.
 */
export function amazonProductForAsin(
  asin: string,
  sourceId: string,
  productUrl: (asin: string) => string,
): AmazonProductToQueue {
  const listingId = asin.toUpperCase();
  return { sourceId, url: productUrl(listingId), listingId, variantId: null };
}
