import { amount, availability } from "./commerce.js";
import { platformPageErrors } from "./errors.js";
import { identifier, jsonScripts, object, records, string } from "./json.js";
import { schemaImages } from "./jsonld.js";
import type { JsonObject, PlatformVariant } from "./types.js";
import { variantUrl } from "./urls.js";

/** Public embedded product data, including collection products; never an HTTP JSON endpoint. */
export function shopifyCatalogRecords(value: unknown): JsonObject[] {
  return records(value)
    .flatMap((record) => {
      if (Array.isArray(record.products)) {
        return records(record.products);
      }
      return object(record.product) ? records(record.product) : [record];
    })
    .filter((record) => identifier(record.id) && string(record.handle));
}

export function shopifyRecords(value: unknown): JsonObject[] {
  return shopifyCatalogRecords(value).filter((record) => Array.isArray(record.variants));
}

export function embeddedShopifyCatalogProducts(document: Document): JsonObject[] {
  return jsonScripts(document, "application/json").flatMap(shopifyCatalogRecords);
}

export function embeddedShopifyProducts(document: Document): JsonObject[] {
  return jsonScripts(document, "application/json").flatMap(shopifyRecords);
}

/** Exposed separately so retained browser JSON captures can be tested without fabricating HTML pages. */
export function readShopifyData(record: JsonObject, url: string) {
  const productId = identifier(record.id);
  const title = string(record.title);
  if (!productId || !title) {
    throw platformPageErrors.create("DTC.PRODUCT_MISSING");
  }
  const variants = records(record.variants).map((variant): PlatformVariant => {
    const id = identifier(variant.id);
    if (!id) {
      throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
    }
    return {
      id,
      title: string(variant.title),
      url: variantUrl(url, "variant", id),
      price: amount(variant.price, typeof variant.price === "number"),
      availability: availability(variant.available),
      image: string(object(variant.featured_image)?.src),
    };
  });
  if (
    !variants.length ||
    variants.length > 200 ||
    new Set(variants.map((entry) => entry.id)).size !== variants.length
  ) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const categories = shopifyCategories(record);
  return {
    productId,
    title,
    brandRaw: string(record.vendor),
    variants,
    images: recordImages(record),
    detailsHtml: string(record.description) ?? string(record.body_html),
    ...(categories.length ? { categories } : {}),
  };
}

/** The product's images as the store lists them: URL strings, or objects with a `src`. */
function recordImages(record: JsonObject): string[] {
  return (Array.isArray(record.images) ? record.images : []).flatMap((entry) =>
    schemaImages(entry).concat(string(object(entry)?.src) ?? []),
  );
}

/** The store's own filing: the product type (`product_type` in embedded data, `type` in `.js`) and its tags. */
export function shopifyCategories(record: JsonObject): string[] {
  const type = string(record.product_type) ?? string(record.type);
  const tags = Array.isArray(record.tags)
    ? record.tags.map(string)
    : typeof record.tags === "string"
      ? record.tags.split(",").map(string)
      : [];
  const names = [type, ...tags]
    .filter((name): name is string => name !== null)
    .map((name) => name.slice(0, 200));
  return [...new Set(names)].slice(0, 20);
}
