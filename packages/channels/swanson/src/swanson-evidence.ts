import { factsErrors } from "@crawl-automation/channels-core";
import { channelErrors, type ProductIdentity } from "@crawl-automation/channels-core";
import {
  ChannelProductEvidenceSchema,
  SwansonRenderedProductSchema,
  type ChannelProductEvidence,
  type SwansonRenderedProduct,
} from "@crawl-automation/v3-contracts";
import { swansonProductAddress } from "./swanson-address.js";
import { swansonErrors } from "./swanson-errors.js";

const htmlText = (text: string) =>
  `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;

/** A facts section that only repeats its heading carries no facts. */
const HEADINGS_ONLY = /^(?:Supplement Facts|Nutrition Facts|Ingredients|\s)*$/i;

/** The page must be the product asked for: same handle, its own canonical link, the requested variant if any. */
function checkAddresses(page: SwansonRenderedProduct, expectedUrl: string): string | null {
  const actual = swansonProductAddress(page.url);
  const expected = swansonProductAddress(expectedUrl);
  const canonical = swansonProductAddress(page.canonicalUrl);
  const ownCanonical = canonical.url.pathname === `/p/${actual.handle}` && !canonical.url.search;
  const expectedVariantHeld = !expected.variantId || expected.variantId === actual.variantId;
  if (!ownCanonical || expected.handle !== actual.handle || !expectedVariantHeld) {
    throw swansonErrors.create("SWANSON.IDENTITY_CONFLICT");
  }
  return actual.variantId;
}

/** One selected form with one variant is evidence of the selection, not that the product has no other variants. */
function selectedForm(
  page: SwansonRenderedProduct,
  owner: ProductIdentity,
  urlVariant: string | null,
) {
  const form = page.selectedForms[0];
  const variantId = form?.variantIds[0];
  if (page.selectedForms.length !== 1 || form?.variantIds.length !== 1 || !variantId) {
    throw swansonErrors.create("SWANSON.IDENTITY_UNVERIFIED");
  }
  const ownerHeld = owner.listingId === form.productId && owner.variantId === variantId;
  if (!ownerHeld || (urlVariant && urlVariant !== variantId)) {
    throw swansonErrors.create("SWANSON.VARIANT_CONFLICT");
  }
  return { productId: form.productId, variantId };
}

function sectionsOf(page: SwansonRenderedProduct): Map<string, string> {
  const sections = new Map<string, string>();
  for (const section of page.sections) {
    if (sections.has(section.heading)) {
      throw swansonErrors.create("SWANSON.AMBIGUOUS_FACTS");
    }
    const text = section.text
      .trim()
      .replace(new RegExp(`^${section.heading}\\s*`), "")
      .trim();
    sections.set(section.heading, text);
  }
  return sections;
}

/** Gallery images exactly as the page links them (never a manufactured larger size), on Swanson's own files path. */
function galleryOf(page: SwansonRenderedProduct): string[] {
  const images = new Set<string>();
  for (const image of page.gallery) {
    const url = new URL(image.url);
    const ownFile =
      url.protocol === "https:" &&
      url.hostname === "www.swansonvitamins.com" &&
      url.pathname.startsWith("/cdn/shop/files/");
    const clean = !url.port && !url.username && !url.password && !url.hash;
    const params = [...url.searchParams.keys()].every((key) => key === "v" || key === "width");
    if (!ownFile || !clean || !params) {
      throw channelErrors.create("CHANNEL.IMAGE_URL_REJECTED", { details: { url: image.url } });
    }
    images.add(url.href);
  }
  return [...images];
}

/**
 * Pure conversion of a Swanson page projection into channel-independent product evidence, checked against the
 * expected URL and the observation's identity. Does not download, enumerate variants or infer nutrients.
 */
export function parseSwansonRenderedProduct(
  raw: unknown,
  expectedUrl: string,
  owner: ProductIdentity,
): ChannelProductEvidence {
  const page = SwansonRenderedProductSchema.parse(raw);
  const form = selectedForm(page, owner, checkAddresses(page, expectedUrl));
  const sections = sectionsOf(page);
  const facts = sections.get("Product Facts");
  const details = sections.get("Product Details");
  const factsCandidates =
    facts && !HEADINGS_ONLY.test(facts)
      ? [{ field: "productFacts", html: htmlText(facts), scope: "selected-product" }]
      : [];
  const imageCandidates = galleryOf(page).map((url) => ({
    url,
    variantId: form.variantId,
    basis: "selected-gallery",
    verifiedOriginal: false,
  }));
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "swanson",
    listingId: form.productId,
    variantId: form.variantId,
    url: page.url,
    title: page.title,
    brandRaw: null,
    variantOptions: [],
    variants: [],
    detailsHtml: details ? htmlText(details) : null,
    factsCandidates,
    imageCandidates,
    warnings: [
      swansonErrors.code("SWANSON.VARIANT_ENUMERATION_UNVERIFIED"),
      factsErrors.code("CHANNEL.DOM_TEXT_PROJECTION"),
    ],
  });
}
