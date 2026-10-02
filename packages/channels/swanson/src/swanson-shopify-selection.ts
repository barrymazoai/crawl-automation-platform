import { swansonProductAddress, swansonUrl } from "./swanson-address.js";
import { swansonErrors } from "./swanson-errors.js";

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Product cards can carry their own forms and pickers, including inside the sold-out detail. */
export function swansonProductElements(document: Document, selector: string): Element[] {
  return [...document.querySelectorAll(selector)].filter(
    (element) =>
      !element.closest("constructor-recommendations, product-recommendations, product-card"),
  );
}

function identifier(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return text;
}

/** Shopify emits a JSON object on its own assignment line. Read data, never evaluate page code. */
function metaProduct(document: Document): JsonRecord {
  const declarations = [...document.querySelectorAll("script")].flatMap((script) => [
    ...(script.textContent ?? "").matchAll(/^\s*var\s+meta\s*=\s*(\{[^\r\n]*\});\s*$/gm),
  ]);
  if (declarations.length !== 1) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(declarations[0]?.[1] ?? "");
  } catch (error) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED", { cause: error });
  }
  if (!isRecord(meta) || !isRecord(meta.product)) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return meta.product;
}

/** Selection must be explicit on exactly one radio; a sole meta variant alone is not selection. */
function selectedOption(picker: Element): Element {
  const selected = [
    ...picker.querySelectorAll<HTMLInputElement>('input[type="radio"], input[role="radio"]'),
  ].filter((input) => input.checked || input.getAttribute("aria-checked") === "true");
  const option = selected[0];
  if (selected.length !== 1 || !option || option.getAttribute("aria-checked") === "false") {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return option;
}

function checkProduct(product: JsonRecord, picker: Element, canonicalUrl: string): string {
  const productId = identifier(product.id);
  const canonical = swansonProductAddress(canonicalUrl);
  const ownHandle = canonical.url.pathname === `/p/${product.handle}` && !canonical.url.search;
  if (!ownHandle || picker.getAttribute("data-product-id") !== productId) {
    throw swansonErrors.create("SWANSON.IDENTITY_CONFLICT");
  }
  return productId;
}

function checkOption(product: JsonRecord, option: Element, canonicalUrl: string): string {
  const variantId = identifier(option.getAttribute("data-variant-id"));
  const variants = Array.isArray(product.variants) ? product.variants.filter(isRecord) : [];
  const matches = variants.filter((variant) => identifier(variant.id) === variantId);
  if (matches.length !== 1) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  const connected = option.getAttribute("data-connected-product-url");
  if (connected && swansonUrl(connected, canonicalUrl).href !== canonicalUrl) {
    throw swansonErrors.create("SWANSON.IDENTITY_CONFLICT");
  }
  return variantId;
}

/** The product detail, never a recommendation/card, must own the sole product heading. */
function productDetail(document: Document): Element {
  const headings = swansonProductElements(document, "main h1");
  const details = swansonProductElements(document, "main [data-cnstrc-product-detail]");
  const detail = details[0];
  if (headings.length !== 1 || details.length !== 1 || !detail?.contains(headings[0] ?? null)) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  return detail;
}

/** Single-variant sold-out pages omit the picker but explicitly name their selection on the detail. */
function detailSelection(document: Document, canonicalUrl: string) {
  const detail = productDetail(document);
  const ownUrl = detail.getAttribute("data-url");
  identifier(detail.getAttribute("data-product-id"));
  if (!ownUrl) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  const product = metaProduct(document);
  const productId = checkProduct(product, detail, canonicalUrl);
  if (swansonUrl(ownUrl, canonicalUrl).href !== canonicalUrl) {
    throw swansonErrors.create("SWANSON.IDENTITY_CONFLICT");
  }
  if (!Array.isArray(product.variants) || product.variants.length !== 1) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  const variantId = checkOption(product, detail, canonicalUrl);
  return [{ productId, variantIds: [variantId] }];
}

/** Sold-out pages replace the cart form, but still name the product and explicitly select its size. */
export function swansonShopifySelection(document: Document, canonicalUrl: string) {
  const pickers = swansonProductElements(document, "main variant-picker");
  if (pickers.length === 0) {
    return detailSelection(document, canonicalUrl);
  }
  const picker = pickers[0];
  if (pickers.length !== 1 || !picker) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  const product = metaProduct(document);
  const productId = checkProduct(product, picker, canonicalUrl);
  const variantId = checkOption(product, selectedOption(picker), canonicalUrl);
  return [{ productId, variantIds: [variantId] }];
}
