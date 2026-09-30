import { runInNewContext } from "node:vm";
import {
  SwansonRenderedProductSchema,
  type SwansonRenderedProduct,
} from "@crawl-automation/v3-contracts";
import { SWANSON_ORIGIN, swansonProductAddress } from "./swanson-address.js";
import { swansonErrors } from "./swanson-errors.js";
import {
  swansonIdentityExpression,
  swansonProductExpression,
} from "./swanson-product-expression.js";
import { swansonStaticDocument } from "./swanson-static-dom.js";

// The challenge itself, not the precursor script present on normal product pages.
const CHALLENGE =
  /<title>\s*(?:Just a moment|Attention Required)|id="challenge-form"|cf-chl-bypass/i;

/** Retained static HTML -> the same public DOM projection used by historical Swanson captures. */
function readProjection(
  html: string,
  pageUrl: string,
  expression: string,
): Record<string, unknown> {
  if (CHALLENGE.test(html)) {
    throw swansonErrors.create("SWANSON.ACCESS_CHALLENGE");
  }
  swansonProductAddress(pageUrl);
  try {
    const document = swansonStaticDocument(html, pageUrl);
    return runInNewContext(
      expression,
      {
        document,
        URL,
        location: { href: pageUrl, origin: SWANSON_ORIGIN },
        getComputedStyle: () => ({ visibility: "visible", display: "block" }),
        productTemplateError: swansonErrors.create("SWANSON.PRODUCT_TEMPLATE"),
      },
      { timeout: 10_000 },
    ) as Record<string, unknown>;
  } catch (error) {
    if (swansonErrors.is(error, "SWANSON.PRODUCT_TEMPLATE")) {
      throw error;
    }
    throw swansonErrors.create("SWANSON.STATIC_PARSE_FAILED", { cause: error });
  }
}

/** Read only the page's canonical handle and selected Shopify form before full product validation. */
export function parseSwansonStaticIdentity(html: string, pageUrl: string) {
  const raw = readProjection(html, pageUrl, swansonIdentityExpression);
  return SwansonRenderedProductSchema.pick({ canonicalUrl: true, selectedForms: true }).parse(raw);
}

/** Retained static HTML -> the same public DOM projection used by historical Swanson captures. */
export function parseSwansonStaticHtml(
  html: string,
  pageUrl: string,
  capturedAt: string,
): SwansonRenderedProduct {
  const raw = readProjection(html, pageUrl, swansonProductExpression);
  try {
    return SwansonRenderedProductSchema.parse({ ...raw, url: pageUrl, capturedAt });
  } catch (error) {
    throw swansonErrors.create("SWANSON.STATIC_PARSE_FAILED", { cause: error });
  }
}
