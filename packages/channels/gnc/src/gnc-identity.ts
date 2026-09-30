import type { FetchedPage, ProductIdentity } from "@crawl-automation/channels-core";
import { gncErrors, gncProductAddress, isSku } from "./gnc-address.js";
import { allElements, gncDocument, refuseChallenge, type Element } from "./gnc-dom.js";
import { jsonLdProducts } from "./gnc-json-ld.js";
import { productLink } from "./gnc-links.js";
import { gncPageErrors } from "./gnc-page-errors.js";

/** The page's canonical product, used only to disambiguate several JSON-LD products, never the requested SKU. */
function canonicalSku(elements: Element[], url: string): string | null {
  const links = elements.filter(
    (element) => element.name === "link" && element.attribs.rel === "canonical",
  );
  const skus = new Set(
    links.map((link) => productLink(link.attribs.href ?? "", url)?.sku).filter(Boolean),
  );
  if (skus.size > 1) {
    throw gncPageErrors.create("GNC.SKU_AMBIGUOUS");
  }
  return [...skus][0] ?? null;
}

/** GNC's own JSON-LD SKU. A different requested SKU never filters the product out. */
export function gncPageIdentity(page: FetchedPage): ProductIdentity {
  const address = gncProductAddress(page.url);
  if (!isSku(address.listingId)) {
    throw gncErrors.create("GNC.FAMILY_PAGE", { details: { listingId: address.listingId } });
  }
  const document = gncDocument(page.html);
  const elements = allElements(document);
  refuseChallenge(document, elements);
  const { products } = jsonLdProducts(elements);
  const skus = new Set(products.map((product) => String(product.sku ?? "")).filter(isSku));
  const sku = skus.size === 1 ? [...skus][0] : canonicalSku(elements, page.url);
  if (!sku || !skus.has(sku)) {
    const code = skus.size > 1 ? "GNC.SKU_AMBIGUOUS" : "GNC.SKU_UNVERIFIED";
    throw gncPageErrors.create(code);
  }
  return { listingId: sku, variantId: null };
}
