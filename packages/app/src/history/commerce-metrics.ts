import { decimal, text } from "./canonical.js";

/** One metrics point: the fields the history and the product service read, plus everything else kept raw. */
export interface Metrics {
  price: string | null;
  currency: string | null;
  listPrice: string | null;
  rating: string | null;
  reviewCount: string | null;
  salesRank: string | null;
  inStock: boolean | null;
  unitsSold: string | null;
  unitsSoldPeriod: string | null;
  extras: Record<string, unknown> | null;
}

type Row = Record<string, unknown>;

const IN_STOCK = [
  /^(?:https?:\/\/schema.org\/)?InStock\.?$/i,
  /^In stock\.?$/i,
  /^Only [1-9]\d* left in stock(?:\s*-\s*order soon\.?)?$/i,
  /^available$/i,
];
const OUT_OF_STOCK = [
  /^(?:https?:\/\/schema.org\/)?(?:OutOfStock|SoldOut)$/i,
  /^(?:Out of stock|Sold out)\.?$/i,
  /^Currently unavailable\.(?: We don't know when or if this item will be back in stock\.)?$/i,
  /^unavailable$/i,
];

function currency(value: unknown): string | null {
  const string = text(value)?.toUpperCase();
  return string && /^[A-Z]{3}$/.test(string) ? string : null;
}

/** A price with its currency sign and thousands separators removed. */
function amount(value: unknown): string | null {
  const string = text(value);
  if (!string) {
    return decimal(value);
  }
  const plain = string
    .replace(/^(?:US\$|USD\s*|\$|£|€)\s*/u, "")
    .replace(/(?<=\d),(?=\d{3}(?:,|\.|$))/gu, "");
  return decimal(plain);
}

/** In stock as the page words it; null when the wording is not recognised. */
function inStock(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  const string = text(value)?.replace(/\s+/gu, " ").trim();
  if (!string) {
    return null;
  }
  if (IN_STOCK.some((pattern) => pattern.test(string))) {
    return true;
  }
  return OUT_OF_STOCK.some((pattern) => pattern.test(string)) ? false : null;
}

const COUNT = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const COUNT_WORDING = new RegExp(
  `^(?:\\((${COUNT})\\)|(${COUNT}))(?:\\s+(?:global\\s+)?(?:ratings|reviews))?$`,
  "i",
);

/** `(1,234)`, `1234 ratings` or a number, as a plain count. */
function reviewCount(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return countFromWords(text(value));
}

function countFromWords(words: string | null): string | null {
  const match = words?.match(COUNT_WORDING);
  const digits = (match?.[1] ?? match?.[2])?.replaceAll(",", "");
  return digits && Number.isSafeInteger(Number(digits)) ? String(Number(digits)) : null;
}

function rating(value: unknown): string | null {
  const stars = text(value)?.match(/^(\d+(?:\.\d+)?)\s+out of\s+5\s+stars$/i)?.[1];
  return decimal(value) ?? decimal(stars);
}

/** The store a channel's prices belong to (Whole Foods: `wholefoods-store:10259`), when the page names one. */
function storeOf(context: unknown): Record<string, string> | null {
  const entries = Array.isArray(context) ? context.filter((item) => typeof item === "string") : [];
  const id = entries.find((item) => /^[a-z]+-store:/u.test(item));
  const label = entries.find((item) => /^[a-z]+-store-label:/u.test(item));
  if (!id) {
    return null;
  }
  const store: Record<string, string> = { id: id.slice(id.indexOf(":") + 1) };
  if (label) {
    store["label"] = label.slice(label.indexOf(":") + 1);
  }
  return store;
}

/** Units sold as the page states them (e.g. Amazon's "1K+ bought in past month"). */
function salesOf(metrics: Metrics, value: unknown): void {
  const sales = value && typeof value === "object" ? (value as Row) : null;
  if (!sales) {
    return;
  }
  metrics.unitsSold = decimal(sales["lowerBound"]);
  metrics.unitsSoldPeriod = sales["period"] === "past_month" ? "trailing_30d" : "unknown";
  metrics.extras = { ...metrics.extras, salesVolume: sales };
}

/**
 * The metrics of one page's commerce evidence, by the same rules as the earlier history projection: nothing is
 * inferred, a value the page does not show stays null, and the whole commerce record is kept in `extras`.
 */
export function commerceMetrics(raw: unknown): Metrics {
  const commerce = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Row) : {};
  const metrics: Metrics = {
    price: amount(commerce["price"]),
    currency: currency(commerce["currency"]),
    listPrice: amount(commerce["listPrice"]),
    rating: rating(commerce["rating"]),
    reviewCount: reviewCount(commerce["reviewCount"]),
    salesRank: null,
    inStock: inStock(commerce["availability"]),
    unitsSold: null,
    unitsSoldPeriod: null,
    extras: { commerce },
  };
  salesOf(metrics, commerce["salesVolume"]);
  const store = storeOf(commerce["context"]);
  if (store) {
    metrics.extras = { ...metrics.extras, store };
  }
  if (commerce["purchaseConditions"] !== undefined) {
    metrics.extras = { ...metrics.extras, purchaseConditions: commerce["purchaseConditions"] };
  }
  return metrics;
}
