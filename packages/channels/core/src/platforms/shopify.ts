import { commerce } from "./commerce.js";
import { productRoot } from "./content.js";
import { readProductContent } from "./read-content.js";
import { platformPageErrors } from "./errors.js";
import { object, records, string } from "./json.js";
import { jsonLdBrand, jsonLdProducts, readJsonLdProduct, selectedVariant } from "./jsonld.js";
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

function shopifyBrand(vendor: string | null, document: Document, context: PlatformContext) {
  return vendor ?? jsonLdBrand(document, context);
}

/**
 * The rendered form decides. When no form singles one out, the address's own `variant` counts if it is one of this
 * product's variants (shop.katefarms.com draws no cart input, 2026-10-20). A base address of a multi-variant product
 * with no selection is the base product (null), as the agent path records it, not a failed identity; the caller
 * still refuses a requested variant the page never confirms.
 */
function selectedShopifyVariant(
  document: Document,
  context: PlatformContext,
  variants: PlatformProduct["variants"],
): string | null {
  const rendered = selectedVariant(document, variants, productRoot(document, context));
  if (rendered) {
    return rendered;
  }
  const requested = new URL(context.url).searchParams.get("variant");
  return requested && variants.some((entry) => entry.id === requested) ? requested : null;
}

export function readShopifyProduct(document: Document, context: PlatformContext): PlatformProduct {
  const url = canonicalUrl(document, context.url);
  const record = url ? ownRecord(document, url) : null;
  if (!record || !url) {
    return { ...readJsonLdProduct(document, context), platform: "shopify" };
  }
  const data = readShopifyData(record, url);
  const selected = selectedShopifyVariant(document, context, data.variants);
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
    brandRaw: shopifyBrand(data.brandRaw, document, context),
    platform: "shopify",
    url,
    selectedVariantId: selected,
    commerce: commerce({ ...offer, sku }),
    ...readProductContent(
      document,
      { ...context, url, productId: data.productId },
      {
        ...data,
        factsHtml: string(details?.supplement_facts),
      },
    ),
  };
}
