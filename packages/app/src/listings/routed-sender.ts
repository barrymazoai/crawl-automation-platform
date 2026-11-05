import { productDeliveryErrors } from "../product-delivery/errors.js";
import type { ListingStateAnswer, ListingStateBatch, ListingStateSender } from "./ports.js";

/**
 * KAN-243: listing states of a storefront sent to its own Supply Smart (amazon.in to the test database), by the
 * batch's `marketplace`; a batch without one goes to `fallback` exactly as before. A storefront without a sender is
 * refused, never sent to `fallback`.
 */
export class MarketplaceRoutedListingStates implements ListingStateSender {
  constructor(
    private readonly fallback: ListingStateSender,
    private readonly byMarketplace: ReadonlyMap<string, ListingStateSender>,
  ) {}

  send(batch: ListingStateBatch, signal: AbortSignal): Promise<ListingStateAnswer[]> {
    const { marketplace } = batch.run;
    if (!marketplace) {
      return this.fallback.send(batch, signal);
    }
    const sender = this.byMarketplace.get(marketplace);
    if (!sender) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.TARGET_MISSING", {
        details: { marketplace },
      });
    }
    return sender.send(batch, signal);
  }
}
