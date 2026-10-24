import { NotSupplementSchema } from "@crawl-automation/v3-contracts";
import { pageBreadcrumbs } from "@crawl-automation/channels-core";
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
  const categories = pageBreadcrumbs(parseHTML(Buffer.from(input.html).toString()).document);
  const { listingId, variantId } = dtcProductAddress(input.url, [input.site]);
  return neverCollectOutcome({
    categories,
    operationId: input.operationId,
    identity: { listingId, variantId },
  });
}

/** A retained store breadcrumb ends collection before scope, planning, OCR or label work. */
export function neverCollectOutcome(input: {
  categories?: string[] | undefined;
  operationId: string;
  identity: { listingId: string; variantId: string | null };
}) {
  const categories = neverCollectPath(input.categories ?? []);
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
