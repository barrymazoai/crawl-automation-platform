import { parseHTML } from "linkedom";
import type { HarvestRecord } from "./product-record.js";
import { dtcAgentErrors } from "./errors.js";

/** Resolve identity only from this capture's own retained product region and page. */
export function retainedProductTitle(input: {
  record: HarvestRecord;
  detailsHtml?: string | undefined;
  html?: Uint8Array | undefined;
}): { title: string; source: string | null } {
  const captured = input.record.fields.title;
  if (typeof captured === "string" && captured.trim()) {
    return { title: captured.trim(), source: null };
  }
  const fallback = pageTitle(input);
  if (fallback) {
    return fallback;
  }
  throw dtcAgentErrors.create("DTC.PRODUCT_TITLE_MISSING", {
    details: { productUrl: input.record.productUrl },
  });
}

function pageTitle(input: { detailsHtml?: string | undefined; html?: Uint8Array | undefined }) {
  const h1 = productHeading(input.detailsHtml);
  if (h1) {
    return { title: h1, source: "DTC.TITLE_FROM_PRODUCT_HTML_H1" };
  }

  if (!input.html) {
    return null;
  }
  const page = parseHTML(Buffer.from(input.html).toString()).document;
  const og = page.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
  if (og) {
    return { title: og, source: "DTC.TITLE_FROM_PAGE_OG_TITLE" };
  }
  const title = page.querySelector("title")?.textContent?.trim();
  return title ? { title, source: "DTC.TITLE_FROM_PAGE_TITLE" } : null;
}

function productHeading(html: string | undefined): string | null {
  if (!html) {
    return null;
  }
  return parseHTML(html).document.querySelector("h1")?.textContent?.trim() ?? null;
}
