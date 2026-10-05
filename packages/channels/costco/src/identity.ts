import {
  jsonLdProducts,
  object,
  string,
  type FetchedPage,
  type JsonObject,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { costcoProductAddress } from "./address.js";
import { costcoErrors } from "./errors.js";
import { costcoChildren } from "./children.js";

/** Only page-owned URLs establish the online ID; JSON-LD sku is a warehouse item number. */
export function costcoStructured(document: Document): {
  product: JsonObject;
  url: string;
  listingId: string;
} {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const own = canonical ? costcoProductAddress(canonical) : null;
  const products = jsonLdProducts(document).map((product) => {
    const url = string(product.url) ?? string(object(product.offers)?.url);
    const address = url ? costcoProductAddress(url) : own;
    return { product, address };
  });
  const matches = products.filter(
    ({ address }) => address && (!own || address.listingId === own.listingId),
  );
  const selected = matches[0];
  if (matches.length !== 1 || !selected?.address) {
    throw costcoErrors.create("COSTCO.IDENTITY_UNVERIFIED");
  }
  return {
    product: selected.product,
    url: selected.address.url,
    listingId: selected.address.listingId,
  };
}

/** A requested child must be one of this page's own children; otherwise the identity conflicts. */
export function costcoPageIdentity(page: FetchedPage) {
  const { document } = parseHTML(page.html);
  const { listingId } = costcoStructured(document);
  const requested = costcoProductAddress(page.url).variantId;
  if (!requested) {
    return { listingId, variantId: null };
  }
  const own = costcoChildren(document, listingId).children.some(
    (child) => child.itemNumber === requested,
  );
  return { listingId, variantId: own ? requested : null };
}
