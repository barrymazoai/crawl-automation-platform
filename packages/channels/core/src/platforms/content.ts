import { factsErrors } from "../facts/facts-errors.js";
import { factsFromHtml, nutritionInfoTableText } from "../facts/facts-text.js";
import { pageText } from "../page-text.js";
import type { FactsText } from "../adapter.js";
import { platformPageErrors } from "./errors.js";
import type { PlatformContext } from "./types.js";
import { allowedContent, productRootOf, type ContentIdentity } from "./content-policy.js";
import { ownContentHtml, type ProductContentScope } from "./content-scope.js";
import { parseSrcset } from "srcset";
import { observedImageSizes, shopifyThemeAsset } from "./observed-images.js";

const SECTIONS =
  'table, details, [id*="facts"], [class*="facts"], [id*="nutrition"], [class*="nutrition"], ' +
  '[id*="ingredients"], [class*="accordion"], [class*="description"]';
const RENDERED_DETAILS =
  'details, [id*="facts"], [class*="facts"], [id*="nutrition"], [class*="nutrition"], ' +
  '[id*="ingredients"], [class*="accordion"], [class*="description"]';

export function productRoot(document: Document, context: PlatformContext): Element | null {
  return productRootOf(document, context.productSelector);
}

/** A rendered tab may have a hidden class; an inline display:none ancestor is an inactive product template. */
function inactiveTemplate(node: Element): boolean {
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    if (/display\s*:\s*none\b/i.test(parent.getAttribute("style") ?? "")) {
      return true;
    }
  }
  return false;
}

/** Use only readable description and accordion blocks owned by the rendered product root. */
export function renderedProductDetails(scope: ProductContentScope): string | null {
  const nodes = [...(scope.root?.querySelectorAll(RENDERED_DETAILS) ?? [])].filter(
    (node) =>
      allowedContent(node, scope.identity) &&
      !inactiveTemplate(node) &&
      !node.closest("[inert]") &&
      Boolean(pageText(ownContentHtml(node, scope.identity))),
  );
  const blocks = nodes.filter(
    (node) => !nodes.some((parent) => parent !== node && parent.contains(node)),
  );
  return blocks.map((node) => ownContentHtml(node, scope.identity)).join("\n") || null;
}

export function factsSection(scope: ProductContentScope, description: string | null) {
  const sections = [...(scope.root?.querySelectorAll(SECTIONS) ?? [])]
    .filter((node) => allowedContent(node, scope.identity) && !inactiveTemplate(node))
    .map((node) => ownContentHtml(node, scope.identity));
  const extra = scope.sections
    .filter((node) => !inactiveTemplate(node))
    .map((node) => ownContentHtml(node, scope.identity));
  const candidates = [...sections, description ?? "", ...extra].filter(
    (html) =>
      /supplement facts|nutrition facts|serving size/i.test(pageText(html)) ||
      nutritionInfoTableText(pageText(html, { rowCells: true })),
  );
  const joined = joinedFacts(candidates, extra);
  const nutrition = joinedNutrition(candidates, [...sections, ...extra]);
  const html =
    candidates.find((candidate) => completeFacts(candidate).complete) ??
    nutrition ??
    joined ??
    candidates[0] ??
    null;
  return { factsHtml: html, facts: completeFacts(html) };
}

/** A table and a sibling Ingredients tab are one product label when both belong to the same content scope. */
function joinedNutrition(candidates: string[], sections: string[]): string | null {
  const panel = candidates.find((html) =>
    nutritionInfoTableText(pageText(html, { rowCells: true })),
  );
  const ingredients = [
    ...new Map(
      sections
        .filter((html) => /^ingredients(?:\s*:|\s*\n+\s*ingredients\s*:)/i.test(pageText(html)))
        .map((html) => [pageText(html), html]),
    ).values(),
  ];
  if (!panel || ingredients.length !== 1) {
    return null;
  }
  const html = `${panel}\n${ingredients[0]}`;
  return completeFacts(html).complete ? html : null;
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
  if (
    result.text &&
    !nutritionInfoTableText(result.text) &&
    !/serving size\s*:?\s*\d/i.test(result.text)
  ) {
    missing.push(factsErrors.code("FACTS.SERVING_QUANTITY_MISSING"));
  }
  if (result.text && !/\b\d[\d,.]*\s*(?:kcal|mg|mcg|[µμ]g|g|iu|cfu|ml)\b/i.test(result.text)) {
    missing.push(factsErrors.code("FACTS.INGREDIENT_AMOUNTS_MISSING"));
  }
  return { ...result, complete: missing.length === 0, missing };
}

/** Only observed HTTPS URLs; image hosts need not be the store's own CDN. */
export function imageUrls(values: readonly string[], context: PlatformContext): string[] {
  const urls = values
    .filter(Boolean)
    .map((raw) => new URL(raw, context.url))
    .filter(
      (url) =>
        url.protocol === "https:" && !url.username && !url.password && !shopifyThemeAsset(url),
    )
    .map((url) => url.href);
  const result = observedImageSizes(urls);
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
      const responsive = ["srcset", "data-srcset"].flatMap((key) =>
        parseSrcset(node.getAttribute(key) ?? "").map((entry) => entry.url),
      );
      return [...sources, ...responsive].filter((value): value is string => Boolean(value));
    });
}

export function descriptionImages(document: Document, html: string | null): string[] {
  const fragment = document.createElement("div");
  fragment.innerHTML = html ?? "";
  return sectionImages(fragment);
}
