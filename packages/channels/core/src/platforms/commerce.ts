import type { CommerceEvidence } from "../adapter.js";
import { identifier, object, string } from "./json.js";
import type { JsonObject } from "./types.js";

export function amount(value: unknown, cents = false): string | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const numeric = Number(value);
  if (value === "" || !Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return cents ? (numeric / 100).toFixed(2) : String(value);
}

export function availability(value: unknown): string | null {
  if (typeof value === "boolean") {
    return value ? "in_stock" : "unavailable";
  }
  return string(value)?.split("/").pop() ?? null;
}

export function commerce(offer: JsonObject, product: JsonObject = {}): CommerceEvidence {
  const rating = object(product.aggregateRating);
  const price = amount(offer.price);
  const state = availability(offer.availability);
  return {
    codec: "public-product-commerce/1",
    sku: identifier(offer.sku ?? product.sku),
    price,
    currency: string(offer.priceCurrency),
    listPrice: amount(offer.compare_at_price),
    rating: amount(rating?.ratingValue),
    reviewCount: amount(rating?.reviewCount),
    availability: state,
    context: [],
    priceStatus: price !== null ? "observed" : "not_observed",
  };
}
