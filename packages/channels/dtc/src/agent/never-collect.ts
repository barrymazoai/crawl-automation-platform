import { NotSupplementSchema } from "@crawl-automation/v3-contracts";
import {
  embeddedShopifyProducts,
  pageBreadcrumbs,
  readShopifyData,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { dtcProductAddress } from "../address.js";
import { neverCollectPath } from "../adapter.js";
import type { DtcSitePolicy } from "../site-policy.js";

/** Use only the archived page's own breadcrumb, before product/Facts projection. */
export function neverCollectFromHtml(input: {
  html: Uint8Array;
  url: string;
  site: DtcSitePolicy;
  operationId: string;
}) {
  const document = parseHTML(Buffer.from(input.html).toString()).document;
  const categories = pageBreadcrumbs(document);
  const storeType =
    input.site.platform === "shopify" ? ownShopifyType(document, input.url) : undefined;
  const { listingId, variantId } = dtcProductAddress(input.url, [input.site]);
  return neverCollectOutcome({
    categories,
    storeType,
    operationId: input.operationId,
    identity: { listingId, variantId },
  });
}

/** A retained store breadcrumb ends collection before scope, planning, OCR or label work. */
export function neverCollectOutcome(input: {
  categories?: string[] | undefined;
  storeType?: string | undefined;
  operationId: string;
  identity: { listingId: string; variantId: string | null };
}) {
  const categories = neverCollectPath(input.categories ?? [], input.storeType);
  return categories
    ? NotSupplementSchema.parse({
        status: "not-supplement",
        operationId: input.operationId,
        ...input.identity,
        reason: "PRODUCT.NOT_SUPPLEMENT",
        policy: "store-category/1",
        categories,
        reviewCode: null,
      })
    : null;
}

function ownShopifyType(document: Document, url: string): string | undefined {
  const handle = new URL(url).pathname.split("/products/")[1]?.replace(/\/$/, "");
  const matches = embeddedShopifyProducts(document).filter((record) => record.handle === handle);
  if (new Set(matches.map((record) => String(record.id))).size !== 1) {
    return undefined;
  }
  try {
    return readShopifyData(matches[0] ?? {}, url).storeType;
  } catch {
    return undefined;
  }
}
