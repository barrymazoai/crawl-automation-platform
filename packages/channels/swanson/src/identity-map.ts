import type { SwansonRenderedProduct } from "@crawl-automation/v3-contracts";
import { swansonProductAddress } from "./swanson-address.js";
import { swansonErrors } from "./swanson-errors.js";

/** The saved page explicitly binds its canonical handle to its own numeric Shopify IDs. */
export function swansonIdentityMapping(
  page: Pick<SwansonRenderedProduct, "canonicalUrl" | "selectedForms">,
) {
  const form = page.selectedForms[0];
  const variantId = form?.variantIds[0];
  if (
    page.selectedForms.length !== 1 ||
    form?.variantIds.length !== 1 ||
    !variantId ||
    !/^\d+$/.test(form.productId) ||
    !/^\d+$/.test(variantId)
  ) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return {
    handle: swansonProductAddress(page.canonicalUrl).handle,
    productId: form.productId,
    variantId,
  };
}
