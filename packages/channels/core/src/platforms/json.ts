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

export function jsonScripts(document: Document, type: string): unknown[] {
  return [...document.querySelectorAll(`script[type="${type}"]`)]
    .map((script) => script.textContent?.trim() ?? "")
    .filter(Boolean)
    .map(parsePageJson);
}

/** Follow schema containers only; recommendation objects are not silently selected. */
export function graphRecords(value: unknown): JsonObject[] {
  return records(value).flatMap((record) => [record, ...records(record["@graph"])]);
}

export function schemaType(record: JsonObject, name: string): boolean {
  const types = record["@type"];
  return Array.isArray(types) ? types.includes(name) : types === name;
}
