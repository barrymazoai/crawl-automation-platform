import { commerce } from "./commerce.js";
import {
  descriptionImages,
  factsSection,
  imageUrls,
  productRoot,
  sectionImages,
} from "./content.js";
import { platformPageErrors } from "./errors.js";
import {
  graphRecords,
  identifier,
  jsonScripts,
  object,
  records,
  schemaType,
  string,
} from "./json.js";
import type { JsonObject, PlatformContext, PlatformProduct, PlatformVariant } from "./types.js";
import { canonicalUrl, pageUrl, samePage } from "./urls.js";

export function jsonLdProducts(document: Document): JsonObject[] {
  return jsonScripts(document, "application/ld+json")
    .flatMap(graphRecords)
    .flatMap((record) =>
      schemaType(record, "ProductGroup") ? records(record.hasVariant) : [record],
    )
    .filter((record) => schemaType(record, "Product"));
}

export function schemaUrl(product: JsonObject, base: string): string | null {
  const value =
    string(product.url) ??
    string(product.mainEntityOfPage) ??
    string(object(product.mainEntityOfPage)?.["@id"]);
  return value ? pageUrl(value, base) : null;
}

export function ownJsonLd(document: Document, context: PlatformContext): JsonObject {
  const canonical = canonicalUrl(document, context.url);
  const products = jsonLdProducts(document);
  const matches = canonical
    ? products.filter((product) => {
        const url = schemaUrl(product, context.url);
        return url !== null && samePage(url, canonical);
      })
    : products;
  // Some stores omit the URL on their sole Product, but state it in a canonical link.
  const candidates = matches.length
    ? matches
    : products.filter(
        (product) =>
          products.length === 1 && canonical !== null && schemaUrl(product, context.url) === null,
      );
  if (candidates.length !== 1 || !candidates[0]) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return candidates[0];
}

export function schemaImages(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const url = string(entry) ?? string(object(entry)?.url) ?? string(object(entry)?.contentUrl);
    return url ? [url] : [];
  });
}

function variantOffers(product: JsonObject, url: string): PlatformVariant[] {
  return records(product.offers).flatMap((offer) => {
    const target = string(offer.url);
    if (!target) {
      return [];
    }
    const linked = new URL(pageUrl(target, url));
    const variant = linked.searchParams.get("variant") ?? linked.searchParams.get("variation_id");
    if (!variant || !samePage(linked.href, url)) {
      return [];
    }
    const values = commerce(offer);
    return [
      {
        id: variant,
        url: linked.href,
        title: string(offer.name),
        price: values.price,
        availability: values.availability,
        image: null,
      },
    ];
  });
}

/** Selection must be in the rendered form, not assumed from the requested query. */
export function selectedVariant(
  document: Document,
  variants: readonly PlatformVariant[],
  root: Element | null = null,
): string | null {
  const scope = root ?? document;
  const inputs = [
    ...scope.querySelectorAll(
      'form[action*="/cart/add"] input[name="id"], form[action*="/cart/add"] select[name="id"] option[selected], input[name="variation_id"]',
    ),
  ]
    .filter(
      (input) =>
        !input.closest('product-recommendations, [class*="recommend"], .related, .upsells'),
    )
    .map((input) => input.getAttribute("value"))
    .filter((value) => value && value !== "0");
  const unique = [...new Set(inputs)];
  if (unique.length > 1 || (unique[0] && !variants.some((variant) => variant.id === unique[0]))) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return unique[0] ?? (variants.length === 1 ? (variants[0]?.id ?? null) : null);
}

export function readJsonLdProduct(document: Document, context: PlatformContext): PlatformProduct {
  const product = ownJsonLd(document, context);
  const url = schemaUrl(product, context.url) ?? canonicalUrl(document, context.url);
  const title = string(product.name);
  if (!url || !title) {
    throw platformPageErrors.create("DTC.PRODUCT_MISSING");
  }
  const variants = variantOffers(product, url);
  const root = productRoot(document, context);
  const selected = variants.length ? selectedVariant(document, variants, root) : null;
  const offers = records(product.offers);
  const offer =
    offers.find((entry) => offerVariant(entry, url) === selected && selected !== null) ??
    (offers.length === 1 ? offers[0] : undefined) ??
    {};
  const detailsHtml = string(product.description);
  return {
    platform: "jsonld",
    productId: identifier(product.productID ?? product.sku) ?? new URL(url).pathname,
    url,
    title,
    selectedVariantId: selected,
    variants,
    commerce: commerce(offer, product),
    detailsHtml,
    ...factsSection(root, detailsHtml),
    images: imageUrls(
      [
        ...schemaImages(product.image),
        ...sectionImages(root),
        ...descriptionImages(document, detailsHtml),
      ],
      context,
    ),
  };
}

function offerVariant(offer: JsonObject, url: string): string | null {
  const target = string(offer.url);
  if (!target) {
    return null;
  }
  const query = new URL(target, url).searchParams;
  return query.get("variant") ?? query.get("variation_id");
}
