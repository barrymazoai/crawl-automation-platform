import type {
  ChannelAdapter,
  CommerceEvidence,
  FetchedPage,
  ParsedProduct,
} from "@crawl-automation/channels-core";
import type { ChannelProductEvidence } from "@crawl-automation/v3-contracts";
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
    brandRaw: null,
    variantOptions: [],
    variants: [],
    detailsHtml: null,
    factsCandidates: [],
    imageCandidates: [],
    warnings: [],
  };
}

/**
 * wholefoodsmarket.com, read for one configured store. Pages are drawn by script and priced by the chosen store,
 * so they are read in the browser (an owner-approved browser case). The product is an Amazon ASIN: its formula is
 * Amazon's, found by ASIN; this channel adds its own metrics, recorded with the store ID. So there is no formula
 * planner here, and the facts are never read from this page.
 */
export function wholeFoodsAdapter(store: WholeFoodsStore): ChannelAdapter<WholeFoodsProduct> {
  return {
    id: "wholefoods",
    formulaFamily: "amazon-asin",
    captureModes: ["browser"],
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
        facts: { text: null, complete: false, missing: ["FACTS.FROM_AMAZON_BY_ASIN"] },
      };
    },
  };
}
