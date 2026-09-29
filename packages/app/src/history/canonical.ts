import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level: the form the history hashes. It is the same as the earlier history
 * store's, so listing and observation IDs stay the same across both.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** The SHA-256 of a value's canonical JSON. */
export const canonicalHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** A trimmed non-empty string, or null. */
export const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** A plain decimal string (`12`, `-3.50`), or null for anything else. */
export function decimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const string = String(value).trim();
  return /^-?\d+(?:\.\d+)?$/u.test(string) && Number.isFinite(Number(string)) ? string : null;
}

/** An ISO time with a timezone, as a trend point needs; null when the time cannot be placed. */
export function timestamp(value: unknown): string | null {
  const string = text(value);
  if (!string || !/T|\s\d{2}:\d{2}/u.test(string) || !/(Z|[+-]\d{2}(?::?\d{2})?)$/u.test(string)) {
    return null;
  }
  const time = Date.parse(string);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
