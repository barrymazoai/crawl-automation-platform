import {
  AmazonListingDateSchema,
  ProductListingDateFieldsSchema,
  type AmazonListingDate,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { ListingDateWarning } from "./listing-date-read.js";

const record = (value: unknown) => z.record(z.string(), z.unknown()).safeParse(value).data ?? {};

/** A retained-original reparse overrides only DFA; all other captured metrics keep their old meaning. */
export function listingDateDelivery(input: {
  channel: string;
  metrics: Record<string, unknown>;
  dateFirstAvailable?: AmazonListingDate | null | undefined;
  dateFirstAvailableWarning?: ListingDateWarning | undefined;
}) {
  const extras = record(input.metrics["extras"]);
  if (input.channel !== "amazon") {
    return { extras };
  }
  if (input.dateFirstAvailableWarning) {
    const { amazonDfa: _dfa, ...original } = extras;
    return { extras: original };
  }
  const commerce = record(extras["commerce"]);
  const date = AmazonListingDateSchema.nullable().safeParse(
    input.dateFirstAvailable === undefined
      ? commerce["dateFirstAvailable"]
      : input.dateFirstAvailable,
  );
  if (!date.success) {
    return { extras };
  }
  // Noon UTC preserves the calendar day in US zones and China; the raw calendar date stays authoritative.
  const fields = date.data?.date
    ? ProductListingDateFieldsSchema.parse({
        listedAt: `${date.data.date}T12:00:00.000Z`,
        listedAtSource: "amazon_dfa",
      })
    : {};
  return {
    ...fields,
    extras: { ...extras, amazonDfa: date.data },
  };
}

/**
 * DFA, the sales rank and the units estimate go through observation ingest only; existing immutable label request
 * bodies must stay identical. The listing keeps `unitsSold` only when it is the page badge the metrics always carried.
 */
export function labelListing<
  T extends {
    extras: Record<string, unknown>;
    salesRank?: number | undefined;
    unitsSold?: number | undefined;
    unitsSoldPeriod?: string | undefined;
  },
>(channel: string, listing: T): T {
  if (channel !== "amazon") {
    return listing;
  }
  const { salesRank: _rank, ...rest } = listing;
  const estimate = record(listing.extras["salesEstimate"]);
  const extras = labelExtras(channel, listing.extras);
  if (!("source" in estimate) || estimate["source"] === "badge") {
    return { ...rest, extras } as T;
  }
  const { unitsSold: _units, unitsSoldPeriod: _period, ...original } = rest;
  return { ...original, extras } as T;
}

/** The extras part of `labelListing`. */
export function labelExtras(channel: string, extras: Record<string, unknown>) {
  if (channel !== "amazon") {
    return extras;
  }
  const { amazonDfa: _dfa, salesEstimate: _estimate, ...original } = extras;
  const commerce = record(original["commerce"]);
  if (!("dateFirstAvailable" in commerce) && !("salesRank" in commerce)) {
    return original;
  }
  const { dateFirstAvailable: _date, salesRank: _rank, ...rest } = commerce;
  return { ...original, commerce: rest };
}
