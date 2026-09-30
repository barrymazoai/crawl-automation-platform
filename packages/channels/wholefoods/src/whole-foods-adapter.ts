import type {
  ChannelAdapter,
  CommerceEvidence,
  FetchedPage,
  ParsedProduct,
} from "@crawl-automation/channels-core";
import type { ChannelProductEvidence } from "@crawl-automation/v3-contracts";
import { WholeFoodsBrandReader } from "./whole-foods-brand-reader.js";
import { wholeFoodsProductAddress } from "./whole-foods-address.js";
import { wholeFoodsPageIdentity } from "./whole-foods-identity.js";
import { WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import { parseWholeFoodsProduct, type WholeFoodsProduct } from "./whole-foods-product.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/** Metrics as the shared commerce record, with the store every Whole Foods price belongs to. */
function commerceOf(product: WholeFoodsProduct): CommerceEvidence {
  const unavailable = product.availability === "unavailable";
  const priceStatus = product.price ? "observed" : unavailable ? "unavailable" : "not_observed";
  return {
    codec: "public-product-commerce/1",
    sku: product.asin,
    price: product.price,
    currency: product.price ? "USD" : null,
    listPrice: null,
    rating: null,
    reviewCount: null,
    availability: product.availability,
    context: [
      `wholefoods-store:${product.storeId}`,
      `wholefoods-store-label:${product.storeLabel}`,
    ],
    priceStatus,
  };
}

function evidenceOf(product: WholeFoodsProduct): ChannelProductEvidence {
  return {
    codec: "channel-product/1",
    channel: "wholefoods",
    listingId: product.asin,
    variantId: null,
    url: product.url,
    title: product.title,
    brandRaw: product.brandRaw,
    variantOptions: [],
    variants: [],
    detailsHtml: product.detailsHtml,
    factsCandidates: product.detailsHtml
      ? [
          {
            field: "page-facts",
            html: product.detailsHtml,
            scope: "selected-product",
          },
        ]
      : [],
    imageCandidates: product.images.map((url) => ({
      url,
      variantId: null,
      basis: "product-gallery",
      verifiedOriginal: false,
    })),
    warnings: [],
  };
}

/**
 * Product HTML comes through ScraperAPI with the store cookie; brand scans alone use the browser.
 * The ASIN shares Amazon's formula. Page facts are retained as evidence, never planned as a new formula.
 */
export function wholeFoodsAdapter(store: WholeFoodsStore): ChannelAdapter<WholeFoodsProduct> {
  return {
    id: "wholefoods",
    formulaFamily: "amazon-asin",
    captureModes: ["http"],
    brandScan: new WholeFoodsBrandReader(store),
    scanCapture: () => "browser",
    httpPolicy: WHOLE_FOODS_PAGE_POLICY,
    productAddress: wholeFoodsProductAddress,
    pageIdentity: wholeFoodsPageIdentity,
    parseProduct(page: FetchedPage): ParsedProduct<WholeFoodsProduct> {
      const product = parseWholeFoodsProduct(page, store);
      return {
        channel: "wholefoods",
        identity: { listingId: product.asin, variantId: null },
        rendered: product,
        evidence: evidenceOf(product),
        commerce: commerceOf(product),
        variants: [],
        facts: { text: product.factsText, complete: false, missing: ["FACTS.FROM_AMAZON_BY_ASIN"] },
      };
    },
  };
}
