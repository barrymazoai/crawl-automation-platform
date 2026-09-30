import { GncProductEvidenceSchema, type GncProductEvidence } from "@crawl-automation/v3-contracts";
import {
  allElements,
  cleanText,
  gncDocument,
  hasClass,
  refuseChallenge,
  sourceOf,
  visibleText,
  within,
  type Element,
} from "./gnc-dom.js";
import { gncImages } from "./gnc-images.js";
import {
  groupMembers,
  isRecord,
  jsonLdProducts,
  productRecord,
  stringValue,
  type JsonRecord,
} from "./gnc-json-ld.js";
import { gncUrl, productLink } from "./gnc-links.js";
import { gncPageErrors } from "./gnc-page-errors.js";

interface Page {
  html: string;
  url: string;
  sku: string;
}

const skuConflict = (sku: string) => gncPageErrors.create("GNC.SKU_CONFLICT", { details: { sku } });

/** The page must be the SKU's own page, and its offer (if any) must link that same page. */
function checkOwnPage(page: Page, product: JsonRecord): void {
  const offerUrl = isRecord(product.offers) ? stringValue(product.offers.url) : null;
  if (offerUrl && !new URL(gncUrl(offerUrl, page.url)).pathname.endsWith(`/${page.sku}.html`)) {
    throw skuConflict(page.sku);
  }
}

function uniqueSection(elements: Element[], id: string): Element | undefined {
  const found = elements.filter((element) => element.attribs.id === id);
  if (found.length > 1) {
    throw gncPageErrors.create("GNC.DOM_AMBIGUOUS", { details: { id } });
  }
  return found[0];
}

/** A group member's own page, when it names one; a member linking another SKU's page is a conflict. */
function memberPage(member: JsonRecord, page: Page): string | null {
  const memberSku = String(member.sku ?? "");
  const offerUrl = isRecord(member.offers) ? stringValue(member.offers.url) : null;
  if (memberSku === page.sku || !offerUrl) {
    return null;
  }
  const link = productLink(offerUrl, page.url);
  if (!link?.sku || link.sku !== memberSku) {
    throw skuConflict(page.sku);
  }
  return link.url;
}

const isVariationControl = (node: Element) =>
  hasClass(node, "product-variations") || node.attribs["data-attribute-id"] !== undefined;

/** Another SKU's page linked from the page's own size/flavour controls. */
function controlPage(element: Element, page: Page): string | null {
  const raw = element.attribs["data-url"] ?? element.attribs.href;
  const link = raw && within(element, isVariationControl) ? productLink(raw, page.url) : null;
  return link?.sku && link.sku !== page.sku ? link.url : null;
}

/** Other sizes and flavours: the SKU's own product group, and the page's variation controls. */
function variantUrls(page: Page, input: { groups: JsonRecord[]; elements: Element[] }): string[] {
  const fromGroup = groupMembers(input.groups, page.sku).map((member) => memberPage(member, page));
  const fromControls = input.elements.map((element) => controlPage(element, page));
  return [...new Set([...fromGroup, ...fromControls].filter((url): url is string => url !== null))];
}

/** Title and brand as the SKU's product record states them. */
function namesOf(product: JsonRecord, sku: string) {
  const title = stringValue(product.name);
  if (!title) {
    throw gncPageErrors.create("GNC.TITLE_MISSING", { details: { sku } });
  }
  const brandRaw = stringValue(isRecord(product.brand) ? product.brand.name : product.brand);
  return { title, brandRaw };
}

function warningsOf(factsHtml: string | null, brandRaw: string | null): string[] {
  return [
    ...(factsHtml ? [] : ["GNC.FACTS_DOM_MISSING"]),
    "GNC.GALLERY_UNVERIFIED",
    ...(brandRaw ? [] : ["GNC.BRAND_MISSING"]),
  ];
}

/**
 * One GNC product page, as GNC's own JSON-LD and DOM state it: the SKU's title and brand, its exact facts and details
 * HTML (kept even when incomplete), its other sizes and its own images. Never falls back to another product.
 */
export function parseGncProduct(html: string, url: string, sku: string): GncProductEvidence {
  const page = { html, url, sku };
  if (!/^\d{6}$/.test(sku) || !new URL(gncUrl(url, url)).pathname.endsWith(`/${sku}.html`)) {
    throw skuConflict(sku);
  }
  const document = gncDocument(html);
  const elements = allElements(document);
  refuseChallenge(document, elements);
  const { products, groups } = jsonLdProducts(elements);
  const product = productRecord(products, sku);
  const { title, brandRaw } = namesOf(product, sku);
  checkOwnPage(page, product);
  const facts = uniqueSection(elements, "productIngredientsAccordionContent");
  const details = uniqueSection(elements, "productDetailsAccordionContent");
  const factsHtml = facts && cleanText(visibleText(facts)) ? sourceOf(html, facts) : null;
  const variants = variantUrls(page, { groups, elements });
  const images = gncImages({ product, elements, page: { url, sku, title } });
  if (images.length > 100 || variants.length > 200) {
    throw gncPageErrors.create("GNC.PAGE_LIMIT");
  }
  const detailsHtml = details ? sourceOf(html, details) : null;
  const warnings = warningsOf(factsHtml, brandRaw);
  return GncProductEvidenceSchema.parse({
    ...{ sku, url, title, brandRaw, factsHtml, detailsHtml },
    ...{ variantUrls: variants, imageCandidates: images, warnings },
  });
}
