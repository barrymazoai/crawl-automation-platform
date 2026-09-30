import {
  jsonLdProducts,
  object,
  parsePageJson,
  schemaUrl,
  type JsonObject,
} from "@crawl-automation/channels-core";
import { recordRecovery } from "@crawl-automation/platform";

/** Optional metadata must not prevent recording a readable product's metrics. */
function optionalMetadata(read: () => unknown): unknown {
  try {
    return read();
  } catch (error) {
    recordRecovery(error, { operation: "wholefoods.optional-metadata" });
    return null;
  }
}

function matches(product: JsonObject, target: { asin: string; url: string }): boolean {
  const identity = product.asin ?? product.sku ?? product.productID;
  const url = schemaUrl(product, target.url);
  return (
    (identity === undefined || String(identity).toUpperCase() === target.asin) &&
    (url === null || new URL(url).pathname === new URL(target.url).pathname)
  );
}

/**
 * Confirm on a saved real product: script[type="application/ld+json"] Product fields and
 * script#__NEXT_DATA__ -> props.pageProps.product. Never search recommendation objects recursively.
 * The existing synthetic window.__NEXT_DATA__ = {} shell is not executable product evidence.
 */
export function wholeFoodsStructured(document: Document, target: { asin: string; url: string }) {
  const products = optionalMetadata(() => jsonLdProducts(document));
  const candidates = Array.isArray(products)
    ? products
        .map(object)
        .filter(
          (entry) => entry !== null && optionalMetadata(() => matches(entry, target)) === true,
        )
    : [];
  const product = nextProduct(document);
  return candidates.length === 1
    ? (candidates[0] ?? {})
    : product && optionalMetadata(() => matches(product, target)) === true
      ? product
      : {};
}

function nextProduct(document: Document) {
  const script = document.querySelector("script#__NEXT_DATA__")?.textContent;
  const next = script ? object(optionalMetadata(() => parsePageJson(script))) : null;
  const product = object(object(object(next?.props)?.pageProps)?.product);
  return product;
}
