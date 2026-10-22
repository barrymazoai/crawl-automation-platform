import type { AmazonListingDate } from "@crawl-automation/v3-contracts";
import { format, isValid, parse } from "date-fns";
import { enUS } from "date-fns/locale";
import { z } from "zod";
import type { AmazonDocument, AmazonElement } from "./dom.js";

const clean = (text: string) =>
  text
    .replace(/[\u200e\u200f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/** Strict en-US calendar dates; a format round-trip excludes date-fns' abbreviated/short-year fallbacks. */
export function parseAmazonDate(raw: string): string | null {
  const text = clean(raw).toLowerCase();
  for (const pattern of ["MMMM d, yyyy", "MMMM d yyyy"]) {
    const parsed = parse(text, pattern, new Date(2000, 0, 1), { locale: enUS });
    if (isValid(parsed) && format(parsed, pattern, { locale: enUS }).toLowerCase() === text) {
      return z.iso.date().safeParse(format(parsed, "yyyy-MM-dd")).data ?? null;
    }
  }
  return null;
}

function dateRow(element: AmazonElement, selector: AmazonListingDate["selector"]) {
  const rawText = element.textContent ?? "";
  const label = element.querySelector(selector === "#prodDetails tr" ? "th" : ".a-text-bold");
  if (clean(label?.textContent ?? "").replace(/\s*:$/u, "") !== "Date First Available") {
    return null;
  }
  const value =
    selector === "#prodDetails tr"
      ? (element.querySelector("td")?.textContent ?? "")
      : clean(rawText).replace(/^Date First Available\s*:\s*/u, "");
  return { date: parseAmazonDate(value), rawText, selector };
}

/** Only the selected page's two product-detail layouts; no Publication date or keyword fallback. */
export function amazonListingDate(document: AmazonDocument): AmazonListingDate | null {
  const rows: AmazonListingDate[] = [];
  for (const selector of ["#detailBullets_feature_div li", "#prodDetails tr"] as const) {
    for (const element of document.querySelectorAll(selector)) {
      const row = dateRow(element, selector);
      if (row) {
        rows.push(row);
      }
    }
  }
  const first = rows[0];
  if (!first) {
    return null;
  }
  // Conflicting detail sections remain optional unknowns, with all wording retained.
  return new Set(rows.map((row) => row.date)).size === 1
    ? first
    : { ...first, date: null, rawText: rows.map((row) => row.rawText).join("\n") };
}
