import {
  pageText,
  schemaBrand,
  schemaImages,
  string,
  object,
  type JsonObject,
} from "@crawl-automation/channels-core";
import { wholeFoodsStructured } from "./whole-foods-structured.js";

const text = (element: Element | null) => string(element?.textContent?.replace(/\s+/g, " "));

function factsSections(document: Document): Element[] {
  return [...document.querySelectorAll("main section")].filter((section) =>
    /^(ingredients|nutrition(?:al)?(?: facts| information)?|supplement facts)$/i.test(
      text(section.querySelector("h2, h3")) ?? "",
    ),
  );
}

function nutritionText(value: unknown): string | null {
  const nutrition = object(value);
  if (!nutrition) {
    return string(value);
  }
  return (
    Object.entries(nutrition)
      .flatMap(([key, entry]) => {
        const value = string(entry) ?? (typeof entry === "number" ? String(entry) : null);
        return key.startsWith("@") || !value ? [] : [`${key}: ${value}`];
      })
      .join("\n") || null
  );
}

function structuredFacts(product: JsonObject): string[] {
  const ingredients = Array.isArray(product.ingredients)
    ? product.ingredients.map(string).filter(Boolean).join(", ")
    : string(product.ingredients);
  const nutrition = nutritionText(product.nutrition);
  return [ingredients ? `Ingredients: ${ingredients}` : null, nutrition].filter(
    (value): value is string => !!value,
  );
}

function productImages(document: Document, product: JsonObject, url: string): string[] {
  const elements = document.querySelectorAll(
    'main [itemprop="image"], main > img, main [data-testid="product-image"]',
  );
  const candidates = [
    ...schemaImages(product.image),
    ...[...elements].map(
      (element) => element.getAttribute("src") ?? element.getAttribute("content") ?? "",
    ),
  ];
  return [
    ...new Set(
      candidates.flatMap((candidate) => {
        const image = candidate ? URL.parse(candidate, url) : null;
        return image &&
          ["https:", "http:"].includes(image.protocol) &&
          !image.username &&
          !image.password
          ? [image.href]
          : [];
      }),
    ),
  ].slice(0, 100);
}

/**
 * Real-page confirmation required: main nav a[href*="/grocery/search"] (brand), main section
 * h2/h3 (Ingredients/Nutrition), main [itemprop="image"], main > img and
 * main [data-testid="product-image"] (gallery). The nav and Ingredients section are documented
 * by existing hand-written fixtures; image selectors and structured-data paths are provisional.
 */
export function wholeFoodsContent(document: Document, target: { asin: string; url: string }) {
  const product = wholeFoodsStructured(document, target);
  const brands = [...document.querySelectorAll('main nav a[href*="/grocery/search"]')]
    .map(text)
    .filter((value): value is string => !!value);
  const sections = factsSections(document);
  const structured = structuredFacts(product);
  const facts = [...sections.map((section) => pageText(section.outerHTML)), ...structured];
  return {
    title: string(product.name),
    brandRaw:
      schemaBrand(product.brand) ?? (new Set(brands).size === 1 ? (brands[0] ?? null) : null),
    images: productImages(document, product, target.url),
    factsText: [...new Set(facts)].join("\n") || null,
    detailsHtml:
      [
        ...sections.map((section) => section.outerHTML),
        ...structured.map((value) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = value;
          return paragraph.outerHTML;
        }),
      ].join("\n") || null,
  };
}
