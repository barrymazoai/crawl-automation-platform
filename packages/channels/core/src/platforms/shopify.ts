import { commerce } from "./commerce.js";
import {
  descriptionImages,
  factsSection,
  imageUrls,
  productRoot,
  sectionImages,
} from "./content.js";
import { platformPageErrors } from "./errors.js";
import { object, records, string } from "./json.js";
import { jsonLdProducts, readJsonLdProduct, selectedVariant } from "./jsonld.js";
import { embeddedShopifyProducts, readShopifyData } from "./shopify-data.js";
import type { JsonObject, PlatformContext, PlatformProduct } from "./types.js";
import { canonicalUrl } from "./urls.js";

function ownRecord(document: Document, url: string): JsonObject | null {
  const handle = new URL(url).pathname.split("/products/")[1]?.replace(/\/$/, "");
  const matches = embeddedShopifyProducts(document).filter((product) => product.handle === handle);
  const unique = new Map(matches.map((record) => [String(record.id), record]));
  if (unique.size > 1) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return [...unique.values()][0] ?? null;
}

function shopifyCurrency(document: Document): string | null {
  const meta = document
    .querySelector('meta[property="product:price:currency"]')
    ?.getAttribute("content");
  const currencies = jsonLdProducts(document)
    .flatMap((product) => records(product.offers))
    .map((offer) => string(offer.priceCurrency))
    .filter((value) => value !== null);
  const unique = [...new Set(meta ? [meta, ...currencies] : currencies)];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

export function readShopifyProduct(document: Document, context: PlatformContext): PlatformProduct {
  const url = canonicalUrl(document, context.url);
  const record = url ? ownRecord(document, url) : null;
  if (!record || !url) {
    return { ...readJsonLdProduct(document, context), platform: "shopify" };
  }
  const data = readShopifyData(record, url);
  const root = productRoot(document, context);
  const selected = selectedVariant(document, data.variants, root);
  if (!selected) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const variant = data.variants.find((entry) => entry.id === selected);
  const offer = {
    price: variant?.price,
    availability: variant?.availability,
    priceCurrency: shopifyCurrency(document),
  };
  const sku = records(record.variants).find((entry) => String(entry.id) === selected)?.sku;
  const details = object(record.metafields);
  return {
    ...data,
    platform: "shopify",
    url,
    selectedVariantId: selected,
    commerce: commerce({ ...offer, sku }),
    ...factsSection(root, string(details?.supplement_facts) ?? data.detailsHtml),
    images: imageUrls(
      [...data.images, ...sectionImages(root), ...descriptionImages(document, data.detailsHtml)],
      context,
    ),
  };
}
