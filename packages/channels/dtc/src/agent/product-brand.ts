import { canonicalUrl, ownJsonLd, samePage, schemaBrand } from "@crawl-automation/channels-core";
import { dtcDocument } from "../product.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { HarvestRecord } from "./product-record.js";

/** Recover omitted metadata from the retained own-product schema, never from the source's name. */
export function capturedProductBrand(input: {
  record: HarvestRecord;
  html?: Uint8Array;
  url: string;
  site: DtcSitePolicy;
}): string | null {
  const brand = input.record.fields.brand;
  if (typeof brand === "string" && brand.trim()) {
    return brand;
  }
  if (!input.html) {
    return null;
  }
  const document = dtcDocument(Buffer.from(input.html).toString());
  const canonical = canonicalUrl(document, input.url);
  if (!canonical || !samePage(canonical, input.url)) {
    return null;
  }
  try {
    const product = ownJsonLd(document, {
      url: input.url,
      siteKey: input.site.siteKey,
      imageOrigins: input.site.imageOrigins,
    });
    return schemaBrand(product.brand);
  } catch {
    // Missing or ambiguous product schemas cannot establish brand identity.
    return null;
  }
}
