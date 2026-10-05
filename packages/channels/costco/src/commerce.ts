import { object, type CommerceEvidence, type JsonObject } from "@crawl-automation/channels-core";
import { schemaCommerce } from "@crawl-automation/channels-core";
import { costcoPriceData } from "./page-data.js";
import type { CostcoStore } from "./store.js";

export interface CostcoPrice {
  label: string;
  price: string;
  text: string;
  source: "page" | "page-data";
}

function priceLabel(node: Element, text: string): string {
  return (
    node.querySelector('[data-testid^="Text_priceFullfillment_"]')?.textContent?.trim() ||
    text.split("$")[0]?.trim() ||
    "unlabelled"
  );
}

/** Keep labels with amounts: member/online/warehouse prices are not interchangeable. */
export function costcoPrices(document: Document, listingId: string): CostcoPrice[] {
  return [...shownPrices(document), ...dataPrices(document, listingId)];
}

function shownPrices(document: Document): CostcoPrice[] {
  return [...document.querySelectorAll('[data-testid^="PriceGroup_"]')].flatMap((node) => {
    const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const price = /\$([\d,]+(?:\.\d{2})?)/.exec(text)?.[1]?.replaceAll(",", "");
    const label = priceLabel(node, text);
    return price ? [{ label, price, text, source: "page" as const }] : [];
  });
}

function dataPrices(document: Document, listingId: string): CostcoPrice[] {
  const data = costcoPriceData(document, listingId);
  const fields = { onlinePrice: "Online Price", deliveredPrice: "Delivered Price" };
  return Object.entries(fields).flatMap(([field, label]) => {
    const value = data?.[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return [];
    }
    return [
      {
        label,
        price: String(value),
        text: `${field}=${value}; warehouseNumber=${String(data?.warehouseNumber ?? "")}`,
        source: "page-data" as const,
      },
    ];
  });
}

export function costcoCommerce(input: {
  product: JsonObject;
  listingId: string;
  itemNumber: string | null;
  prices: CostcoPrice[];
  store: CostcoStore;
  storeVerified: boolean;
  /** A non-default child: the page carries only the default child's price, so this child's price is unknown. */
  otherChild?: boolean;
}): CommerceEvidence {
  const { product, listingId, itemNumber, prices, store, storeVerified } = input;
  const offer = object(product.offers) ?? {};
  const base = schemaCommerce(offer, product);
  const selected = input.otherChild ? undefined : shownPrice(prices);
  const price = childPrice(input.otherChild, selected?.price ?? base.price);
  return {
    ...base,
    // The server HTML's JSON-LD always says OutOfStock; real stock is loaded later by the page (2026-10-01).
    availability: null,
    sku: listingId,
    price,
    priceStatus: price !== null ? "observed" : "not_observed",
    context: [
      `costco-store:${store.storeId}`,
      `costco-store-label:${store.label}`,
      `costco-postal-code:${store.postalCode}`,
      `costco-warehouse-verified:${storeVerified}`,
      `costco-price-source:${selected?.source ?? "jsonld"}`,
      ...(itemNumber ? [`costco-item:${itemNumber}`] : []),
      ...(input.otherChild ? ["costco-child-price:not-in-page"] : []),
      ...prices.map((entry) => `costco-price:${entry.label}:${entry.price}`),
    ],
  };
}

function shownPrice(prices: CostcoPrice[]): CostcoPrice | undefined {
  return (
    prices.find((entry) => entry.source === "page") ??
    prices.find((entry) => entry.label === "Delivered Price")
  );
}

/** A non-default child's price is not in the page; it stays unknown rather than borrowing the default's. */
function childPrice(otherChild: boolean | undefined, price: string | null): string | null {
  return otherChild ? null : price;
}
