import { factsErrors } from "../facts/facts-errors.js";
import { factsFromHtml } from "../facts/facts-text.js";
import { pageText } from "../page-text.js";
import type { FactsText } from "../adapter.js";
import { platformPageErrors } from "./errors.js";
import type { PlatformContext } from "./types.js";
import { allowedContent, PRODUCT_CONTENT, type ContentIdentity } from "./content-policy.js";
import { ownContentHtml, type ProductContentScope } from "./content-scope.js";

const SECTIONS =
  'table, details, [id*="facts"], [class*="facts"], [id*="ingredients"], [class*="accordion"], [class*="description"]';

export function productRoot(document: Document, context: PlatformContext): Element | null {
  return document.querySelector(context.productSelector ?? PRODUCT_CONTENT.root);
}

export function factsSection(scope: ProductContentScope, description: string | null) {
  const sections = [...(scope.root?.querySelectorAll(SECTIONS) ?? [])]
    .filter((node) => allowedContent(node, scope.identity))
    .map((node) => ownContentHtml(node, scope.identity));
  const extra = scope.sections.map((node) => ownContentHtml(node, scope.identity));
  const candidates = [...sections, description ?? "", ...extra].filter((html) =>
    /supplement facts|nutrition facts|serving size/i.test(pageText(html)),
  );
  const joined = joinedFacts(candidates, extra);
  const html =
    candidates.find((candidate) => completeFacts(candidate).complete) ??
    joined ??
    candidates[0] ??
    null;
  return { factsHtml: html, facts: completeFacts(html) };
}

/** Join only one facts panel and one separate ingredients section; ambiguous panels stay on the image path. */
function joinedFacts(candidates: string[], extra: string[]): string | null {
  if (!extra.length) {
    return null;
  }
  const panels = [...new Set(candidates.map((html) => pageText(html)))];
  const ingredients = extra.filter((html) => /^other ingredients\b/i.test(pageText(html).trim()));
  if (panels.length !== 1 || ingredients.length !== 1 || !candidates[0]) {
    return null;
  }
  const html = `${candidates[0]}\n${ingredients[0]}`;
  return completeFacts(html).complete ? html : null;
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

export function sectionImages(root: Element | null, identity?: ContentIdentity): string[] {
  return [...(root?.querySelectorAll("img") ?? [])]
    .filter((node) => allowedContent(node, identity))
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
