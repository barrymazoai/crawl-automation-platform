import { brandScanErrors } from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { swansonErrors } from "./swanson-errors.js";

/** The server supplies the brand facet name even though Constructor renders the grid in the client. */
export function swansonCollectionTitle(body: string): string {
  const { document } = parseHTML(body);
  const titles = [...document.querySelectorAll("constructor-plp[data-collection-title]")]
    .map((element) => element.getAttribute("data-collection-title")?.trim())
    .filter((title) => !!title);
  const title = titles[0];
  if (title && new Set(titles).size === 1) {
    return title;
  }
  const challenge = /__shopify_bv_challenge|cf-chl|captcha|Just a moment|Attention Required/i;
  if (challenge.test(body)) {
    throw brandScanErrors.create("BRAND_SCAN.ACCESS_CHALLENGE");
  }
  throw swansonErrors.create("SWANSON.COLLECTION_TITLE_MISSING");
}
