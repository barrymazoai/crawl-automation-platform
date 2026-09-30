export interface GncOffer {
  url?: string;
  priceCurrency?: string;
  price?: string | number;
  availability?: string;
}

export interface GncJsonProduct {
  "@type"?: string;
  name?: string;
  description?: string;
  sku?: string;
  mpn?: string;
  image?: string | string[];
  brand?: { name?: string } | string;
  offers?: GncOffer;
  flavor?: string;
  size?: string;
  aggregateRating?: { ratingValue?: string | number; reviewCount?: string | number };
}

export interface GncProductGroup {
  "@type"?: string;
  name?: string;
  description?: string;
  url?: string;
  productGroupID?: string;
  brand?: { name?: string } | string;
  hasVariant?: GncJsonProduct[];
  aggregateRating?: { ratingValue?: string | number; reviewCount?: string | number };
}

export interface GncAnalyticsProduct {
  item_id?: string;
  item_master_id?: string;
  item_name?: string;
  item_prodname?: string;
  item_url?: string;
  item_master_url?: string;
  item_brand?: string;
  item_primaryCategory?: string;
  item_stock?: number;
  flavor?: string;
  size?: string;
  variant?: string;
  item_price?: number;
  price?: number;
  image_hi_res?: { url?: string };
  "image_hi-res"?: { url?: string };
}

export interface RawGncPage {
  url: string;
  title: string;
  diagnosticText: string;
  capturedAt: string;
  denied: boolean;
  product: GncJsonProduct | null;
  group: GncProductGroup | null;
  analytics: GncAnalyticsProduct | null;
  variantUrls: string[];
  pdfLinks: string[];
  imageUrls: string[];
  detailText: string;
  factsText: string;
}

export interface ExtractedGncProduct {
  sku: string;
  mpn: string | null;
  title: string;
  brand: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  inStock: boolean | null;
  rating: number | null;
  reviewCount: number | null;
  images: string[];
  productUrl: string;
  labelPdfUrl: string | null;
  family: { parentExternalId: string; name: string | null } | null;
  variantAttrs: Record<string, string>;
  detailText: string;
  factsText: string;
  capturedAt: string;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function brandName(value: GncJsonProduct["brand"] | GncProductGroup["brand"]) {
  return text(typeof value === "string" ? value : value?.name);
}

function images(value: GncJsonProduct["image"]) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function normalizeUrl(value: string, base: string) {
  try { return new URL(value, base).toString(); }
  catch { return null; }
}

export function variantUrls(page: RawGncPage) {
  const values = [
    ...(page.group?.hasVariant?.map((variant) => variant.offers?.url).filter((value): value is string => Boolean(value)) ?? []),
    ...page.variantUrls,
  ];
  return [...new Set(values.map((value) => normalizeUrl(value, page.url)).filter((value): value is string => Boolean(value)))];
}

export function extractGncProduct(page: RawGncPage): ExtractedGncProduct | null {
  const sku = text(page.product?.sku) ?? text(page.analytics?.item_id);
  if (!sku) return null;
  const variant = page.group?.hasVariant?.find((item) => text(item.sku) === sku) ?? page.product;
  const offer = variant?.offers;
  const analyticsImage = page.analytics?.["image_hi-res"]?.url ?? page.analytics?.image_hi_res?.url;
  const productUrl = normalizeUrl(offer?.url ?? page.analytics?.item_url ?? page.url, page.url) ?? page.url;
  const brand = brandName(page.product?.brand) ?? brandName(page.group?.brand) ?? text(page.analytics?.item_brand);
  const title = text(page.product?.name) ?? text(variant?.name) ?? text(page.analytics?.item_prodname);
  if (!brand || !title) return null;
  const ratingSource = page.product?.aggregateRating ?? page.group?.aggregateRating;
  const availability = text(offer?.availability);
  const price = number(offer?.price ?? page.analytics?.item_price ?? page.analytics?.price);
  const imageValues = [
    ...images(page.product?.image),
    ...images(variant?.image),
    ...(analyticsImage ? [analyticsImage] : []),
    ...page.imageUrls.filter((value) => value.includes(sku)),
  ].map((value) => normalizeUrl(value, page.url)).filter((value): value is string => Boolean(value));
  const labelPdfUrl = page.pdfLinks
    .map((value) => normalizeUrl(value, page.url))
    .find((value) => value && new RegExp(`/${sku}_lbl\\.pdf(?:$|\\?)`, "i").test(value)) ?? null;
  const variantAttrs: Record<string, string> = {};
  const flavor = text(page.analytics?.flavor) ?? text(variant?.flavor);
  const size = text(page.analytics?.size);
  const servings = text(variant?.size);
  if (flavor) variantAttrs.flavor = flavor;
  if (size) variantAttrs.size = size;
  if (servings) variantAttrs.servings = servings;
  if (text(variant?.mpn ?? page.product?.mpn)) variantAttrs.upc = text(variant?.mpn ?? page.product?.mpn)!;
  if (text(page.analytics?.item_primaryCategory)) variantAttrs.category = text(page.analytics?.item_primaryCategory)!;

  return {
    sku,
    mpn: text(variant?.mpn ?? page.product?.mpn),
    title,
    brand,
    description: text(page.product?.description) ?? text(variant?.description) ?? text(page.group?.description),
    price: price == null ? null : String(price),
    currency: text(offer?.priceCurrency),
    inStock: availability ? /InStock$/i.test(availability) : page.analytics?.item_stock == null ? null : page.analytics.item_stock > 0,
    rating: number(ratingSource?.ratingValue),
    reviewCount: number(ratingSource?.reviewCount),
    images: [...new Set(imageValues)],
    productUrl,
    labelPdfUrl,
    family: page.group?.productGroupID ? {
      parentExternalId: page.group.productGroupID,
      name: text(page.group.name),
    } : null,
    variantAttrs,
    detailText: page.detailText.trim(),
    factsText: page.factsText.trim(),
    capturedAt: page.capturedAt,
  };
}
