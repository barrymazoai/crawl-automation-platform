import { isDeepStrictEqual } from "node:util";
import { DomUtils } from "htmlparser2";
import type { Element } from "./gnc-dom.js";
import { gncPageErrors } from "./gnc-page-errors.js";

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** A non-empty trimmed string, or null. */
export const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const MAX_OBJECTS = 2000;

const typesOf = (record: JsonRecord) =>
  Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];

/** Product and ProductGroup records in the page's JSON-LD, including @graph and hasVariant members. */
export function jsonLdProducts(elements: Element[]) {
  const products: JsonRecord[] = [];
  const groups: JsonRecord[] = [];
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++visited > MAX_OBJECTS || depth > 20) {
      throw gncPageErrors.create("GNC.JSON_LIMIT");
    }
    if (Array.isArray(value)) {
      value.forEach((member) => visit(member, depth + 1));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const types = typesOf(value);
    if (types.includes("Product")) {
      products.push(value);
    }
    if (types.includes("ProductGroup")) {
      groups.push(value);
    }
    for (const key of ["@graph", "hasVariant"]) {
      if (value[key]) {
        visit(value[key], depth + 1);
      }
    }
  };
  for (const script of elements) {
    if (script.name === "script" && script.attribs.type === "application/ld+json") {
      visit(parseJson(DomUtils.getText(script)), 0);
    }
  }
  return { products, groups };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw gncPageErrors.create("GNC.JSON_INVALID", { cause: error });
  }
}

/** The one product record for the SKU; two different records for the same SKU are ambiguous. */
export function productRecord(products: JsonRecord[], sku: string): JsonRecord {
  const matches = products.filter((product) => String(product.sku ?? "") === sku);
  const product = matches[0];
  if (!product) {
    throw gncPageErrors.create("GNC.SKU_UNVERIFIED", { details: { sku } });
  }
  if (matches.some((other) => !isDeepStrictEqual(other, product))) {
    throw gncPageErrors.create("GNC.SKU_AMBIGUOUS", { details: { sku } });
  }
  return product;
}

/** The members of the product group that contains this SKU (its sizes and flavours). */
export function groupMembers(groups: JsonRecord[], sku: string): JsonRecord[] {
  return groups.flatMap((group) => {
    const members = Array.isArray(group.hasVariant) ? group.hasVariant.filter(isRecord) : [];
    return members.some((member) => String(member.sku ?? "") === sku) ? members : [];
  });
}
