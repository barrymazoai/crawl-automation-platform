import { GncUrlSchema } from "@crawl-automation/v3-contracts";
import { gncErrors } from "./gnc-address.js";

/** An absolute gnc.com URL resolved against the page; anything the GNC URL rule refuses is rejected. */
export function gncUrl(raw: string, base: string): string {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (error) {
    throw gncErrors.create("GNC.URL_REJECTED", { cause: error });
  }
  if (!GncUrlSchema.safeParse(url.href).success) {
    throw gncErrors.create("GNC.URL_REJECTED", { details: { url: raw } });
  }
  return url.href;
}

export interface GncProductLink {
  url: string;
  kind: "sku" | "family";
  sku: string | null;
}

/** A link to a product page (`/<id>.html`, not search or store pages): a 6-digit SKU or a family page. */
export function productLink(raw: string, base: string): GncProductLink | null {
  const url = gncUrl(raw, base);
  const path = new URL(url).pathname;
  const id = path.match(/\/([\w-]+)\.html$/)?.[1];
  if (!id || /\/search\b|demandware\.store/i.test(path)) {
    return null;
  }
  const sku = /^\d{6}$/.test(id) ? id : null;
  return { url, kind: sku ? "sku" : "family", sku };
}
