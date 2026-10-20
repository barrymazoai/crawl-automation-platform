import { platformPageErrors } from "./errors.js";
import type { JsonObject } from "./types.js";

export function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function identifier(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return string(value);
}

export const records = (value: unknown): JsonObject[] =>
  (Array.isArray(value) ? value : [value]).map(object).filter((entry) => entry !== null);

export function parsePageJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw platformPageErrors.create("DTC.JSON_INVALID", { cause });
  }
}

/**
 * Every JSON script of the type that parses. A theme's broken block (tallyhealth.com 2026-10-20: a raw control
 * character inside a JSON-LD description) is skipped, not fatal: the product record the readers need is in another
 * block, and a missing record is reported by the reader as DTC.PRODUCT_MISSING / IDENTITY_UNVERIFIED.
 */
export function jsonScripts(document: Document, type: string): unknown[] {
  return [...document.querySelectorAll(`script[type="${type}"]`)]
    .map((script) => script.textContent?.trim() ?? "")
    .filter(Boolean)
    .flatMap((text) => {
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        return [];
      }
    });
}

/** Follow schema containers only; recommendation objects are not silently selected. */
export function graphRecords(value: unknown): JsonObject[] {
  return records(value).flatMap((record) => [record, ...records(record["@graph"])]);
}

export function schemaType(record: JsonObject, name: string): boolean {
  const types = record["@type"];
  return Array.isArray(types) ? types.includes(name) : types === name;
}
