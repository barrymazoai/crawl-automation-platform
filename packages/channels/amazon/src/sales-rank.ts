import type { AmazonSalesRank } from "@crawl-automation/v3-contracts";
import type { AmazonDocument, AmazonElement } from "./dom.js";

type Selector = AmazonSalesRank["selector"];

const clean = (text: string) => text.replace(/[‎‏]/gu, "").replace(/\s+/gu, " ").trim();

/** The root entry carries Amazon's "(See Top 100 in <category>)" link; subcategory entries do not. */
const ROOT =
  /#(?<rank>\d{1,3}(?:,\d{3})*|\d+) in (?<category>[^(#]+?) \(See Top 100 in \k<category>\)/u;

function isRankRow(element: AmazonElement, selector: Selector): boolean {
  const label = element.querySelector(selector === "#prodDetails tr" ? "th" : ".a-text-bold");
  return clean(label?.textContent ?? "").replace(/\s*:$/u, "") === "Best Sellers Rank";
}

function rowText(element: AmazonElement, selector: Selector): string {
  const cell = selector === "#prodDetails tr" ? element.querySelector("td") : element;
  return clean(cell?.textContent ?? "");
}

function rootRank(text: string, selector: Selector): AmazonSalesRank | null {
  const groups = text.match(ROOT)?.groups;
  const rank = Number((groups?.["rank"] ?? "").replaceAll(",", ""));
  const category = groups?.["category"]?.trim();
  return category && Number.isSafeInteger(rank) && rank > 0
    ? { rank, category, rawText: text.slice(0, 2000), selector }
    : null;
}

/** Only the selected page's two product-detail layouts, same as the listing date; no keyword fallback. */
export function amazonSalesRank(document: AmazonDocument): AmazonSalesRank | null {
  const rows: AmazonSalesRank[] = [];
  for (const selector of ["#detailBullets_feature_div li", "#prodDetails tr"] as const) {
    for (const element of document.querySelectorAll(selector)) {
      const row = isRankRow(element, selector)
        ? rootRank(rowText(element, selector), selector)
        : null;
      if (row) {
        rows.push(row);
      }
    }
  }
  const first = rows[0];
  if (!first) {
    return null;
  }
  // Detail sections that disagree leave the rank unknown rather than picking one.
  const distinct = new Set(rows.map((row) => `${row.rank}|${row.category}`));
  return distinct.size === 1 ? first : null;
}
