import { commerce } from "./commerce.js";
import { productRoot } from "./content.js";
import { platformPageErrors } from "./errors.js";
import { identifier, records, schemaType, string } from "./json.js";
import { canonicalUrl, pageUrl, samePage } from "./urls.js";
import type { JsonObject, PlatformContext, PlatformVariant } from "./types.js";
import { selectedVariant } from "./selected-variant.js";

function memberOffer(product: JsonObject, url: string) {
  const offers = records(product.offers);
  const offer = offers[0];
  if (!schemaType(product, "Product") || offers.length !== 1 || !offer) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const raw = string(offer.url);
  if (!raw) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const target = new URL(pageUrl(raw, url));
  const id = target.searchParams.get("variant") ?? target.searchParams.get("variation_id");
  if (!id || !samePage(target.href, url)) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  return { offer, target, id };
}

function memberVariant(product: JsonObject, url: string): PlatformVariant {
  const ownUrl = string(product.url);
  if (ownUrl && !samePage(pageUrl(ownUrl, url), url)) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const { offer, target, id } = memberOffer(product, url);
  const values = commerce(offer);
  return {
    id,
    url: target.href,
    title: string(product.name),
    price: values.price,
    availability: values.availability,
    image: null,
  };
}

/** Only a rendered selection can choose between this canonical group's observed variants. */
export function groupSelection(
  document: Document,
  context: PlatformContext,
  group: JsonObject,
): { product: JsonObject; variants: PlatformVariant[]; selected: string } {
  const url = string(group.url)
    ? pageUrl(String(group.url), context.url)
    : canonicalUrl(document, context.url);
  if (!url) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const products = records(group.hasVariant);
  const variants = products.map((product) => memberVariant(product, url));
  if (!variants.length || new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const selected = selectedVariant(document, variants, productRoot(document, context));
  if (!selected) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const product = products[variants.findIndex((variant) => variant.id === selected)];
  return {
    product: {
      ...group,
      ...product,
      url,
      productID: identifier(group.productGroupID ?? group.productID) ?? new URL(url).pathname,
    },
    variants,
    selected,
  };
}
