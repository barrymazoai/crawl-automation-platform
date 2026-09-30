import { factsErrors } from "../facts/facts-errors.js";
import { factsFromHtml } from "../facts/facts-text.js";
import { pageText } from "../page-text.js";
import type { FactsText } from "../adapter.js";
import { platformPageErrors } from "./errors.js";
import type { PlatformContext } from "./types.js";

const RECOMMENDATIONS =
  'product-recommendations, [class*="recommend"], [id*="recommend"], .related, .upsells';
const SECTIONS =
  'table, details, [id*="facts"], [class*="facts"], [id*="ingredients"], [class*="accordion"], [class*="description"]';

export function productRoot(document: Document, context: PlatformContext): Element | null {
  return document.querySelector(
    context.productSelector ??
      'product-info, [id^="MainProduct-"], .product.type-product, [itemscope][itemtype$="/Product"]',
  );
}

export function factsSection(root: Element | null, description: string | null) {
  const sections = [...(root?.querySelectorAll(SECTIONS) ?? [])]
    .filter((node) => !node.closest(RECOMMENDATIONS))
    .map((node) => node.outerHTML);
  const candidates = [...sections, description ?? ""].filter((html) =>
    /supplement facts|nutrition facts|serving size/i.test(pageText(html)),
  );
  const html =
    candidates.find((candidate) => completeFacts(candidate).complete) ?? candidates[0] ?? null;
  return { factsHtml: html, facts: completeFacts(html) };
}

/** Require a serving quantity and real amounts, not just the three headings. */
export function completeFacts(html: string | null): FactsText {
  const result = factsFromHtml(html);
  const missing = [...result.missing];
  if (result.text && !/serving size\s*:?\s*\d/i.test(result.text)) {
    missing.push(factsErrors.code("FACTS.SERVING_QUANTITY_MISSING"));
  }
  if (result.text && !/\b\d[\d,.]*\s*(?:mg|mcg|[µμ]g|g|iu|cfu|ml)\b/i.test(result.text)) {
    missing.push(factsErrors.code("FACTS.INGREDIENT_AMOUNTS_MISSING"));
  }
  return { ...result, complete: missing.length === 0, missing };
}

/** Only observed URLs; no invented high-resolution image addresses. */
export function imageUrls(values: readonly string[], context: PlatformContext): string[] {
  const urls = values
    .filter(Boolean)
    .map((raw) => new URL(raw, context.url))
    .filter(
      (url) =>
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        context.imageOrigins.includes(url.origin),
    )
    .map((url) => url.href);
  const result = [...new Set(urls)];
  if (result.length > 100) {
    throw platformPageErrors.create("DTC.PAGE_LIMIT");
  }
  return result;
}

export function sectionImages(root: Element | null): string[] {
  return [...(root?.querySelectorAll("img") ?? [])]
    .filter((node) => !node.closest(RECOMMENDATIONS))
    .flatMap((node) => {
      const sources = ["src", "data-src", "data-original"].map((key) => node.getAttribute(key));
      const srcset = node.getAttribute("srcset") ?? node.getAttribute("data-srcset") ?? "";
      return [...sources, ...srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0])].filter(
        (value): value is string => Boolean(value),
      );
    });
}

export function descriptionImages(document: Document, html: string | null): string[] {
  const fragment = document.createElement("div");
  fragment.innerHTML = html ?? "";
  return sectionImages(fragment);
}
