import { object, parsePageJson, type FetchedPage } from "@crawl-automation/channels-core";
import { recordRecovery } from "@crawl-automation/platform";
import { parseHTML } from "linkedom";
import { wholeFoodsErrors } from "./whole-foods-errors.js";

function selectedProduct(data: ReturnType<typeof object>) {
  const page = object(object(data?.props)?.pageProps) ?? object(data?.pageData) ?? data;
  return object(page?.product);
}

/** Only explicit selected-product roots; never URL echoes, store IDs or recommendations. */
function selectedAsin(text: string): string | null {
  try {
    const data = object(parsePageJson(text));
    const product = selectedProduct(data);
    const asin = product?.asin;
    return typeof asin === "string" && /^B0[A-Z0-9]{8}$/i.test(asin) ? asin.toUpperCase() : null;
  } catch (error) {
    recordRecovery(error, { operation: "wholefoods.page-identity" });
    return null;
  }
}

/** Bounded JSON paths still require live verification. Disagreement is unverified, never a requested ASIN. */
export function wholeFoodsPageIdentity(page: FetchedPage) {
  const { document } = parseHTML(page.html);
  const scripts = document.querySelectorAll(
    'script[type="application/json"], script#__NEXT_DATA__',
  );
  const asins = new Set([...scripts].map((script) => selectedAsin(script.textContent ?? "")));
  asins.delete(null);
  const listingId = asins.size === 1 ? [...asins][0] : null;
  return listingId ? { listingId, variantId: null } : null;
}

export function requireWholeFoodsIdentity(page: FetchedPage) {
  const identity = wholeFoodsPageIdentity(page);
  if (!identity) {
    throw wholeFoodsErrors.create("WHOLEFOODS.PRODUCT_UNVERIFIED", {
      details: { reason: "selected-product ASIN missing or ambiguous" },
    });
  }
  return identity;
}
