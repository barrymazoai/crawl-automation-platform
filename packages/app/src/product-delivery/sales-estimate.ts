import {
  AmazonSalesRankSchema,
  estimateMonthlyUnits,
  type AmazonSalesEstimate,
  type AmazonSalesRank,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";

const record = (value: unknown) => z.record(z.string(), z.unknown()).safeParse(value).data ?? {};

/** Below this root rank a badge-less single SKU is estimated from the curve; from it on, the floor applies. */
export const ESTIMATE_BELOW_RANK = 20_000;
/** The owner's floor for a listing Amazon shows no badge for: "fewer than 50", recorded as 25 (2026-10-27). */
export const FLOOR_UNITS = 25;

export type SalesEstimateSource = "badge" | "variation_child" | "rank_model" | "floor";
export interface SalesEstimateExtras {
  source: SalesEstimateSource;
  units: number;
  /** False when the capture predates rank parsing and no reparse supplied one: a backfill can find these rows. */
  rankRead: boolean;
  rank?: number;
  category?: string;
  estimate?: AmazonSalesEstimate;
}

interface SalesEstimateInput {
  channel: string;
  metrics: Record<string, unknown>;
  siblings: number;
  /** A rank reparsed from the retained original (resend of an older capture); undefined reads the metrics. */
  salesRank?: AmazonSalesRank | null | undefined;
  extras: Record<string, unknown>;
}

/** The capture's own root rank unless a reparse of the retained original supplied one (null: the page shows none). */
function rankOf(input: SalesEstimateInput): { rank: AmazonSalesRank | null; read: boolean } {
  if (input.salesRank !== undefined) {
    return { rank: input.salesRank, read: true };
  }
  const commerce = record(record(input.metrics["extras"])["commerce"]);
  const rank = AmazonSalesRankSchema.nullable().optional().safeParse(commerce["salesRank"]);
  return { rank: rank.data ?? null, read: rank.success && "salesRank" in commerce };
}

/** Which number Amazon's listing gets, by the owner's rules; `badge` keeps the metrics' own units. */
function decide(
  input: SalesEstimateInput,
  salesRank: AmazonSalesRank | null,
): Omit<SalesEstimateExtras, "rankRead"> {
  const badge = Number(input.metrics["unitsSold"]);
  const rank = salesRank ? { rank: salesRank.rank, category: salesRank.category } : {};
  if (Number.isSafeInteger(badge) && badge > 0) {
    return { source: "badge", units: badge, ...rank };
  }
  if (input.siblings > 0) {
    return { source: "variation_child", units: FLOOR_UNITS, ...rank };
  }
  const modelled =
    salesRank && salesRank.rank < ESTIMATE_BELOW_RANK ? estimateMonthlyUnits(salesRank) : null;
  return modelled
    ? { source: "rank_model", units: modelled.units, ...rank, estimate: modelled }
    : { source: "floor", units: FLOOR_UNITS, ...rank };
}

/**
 * Monthly units delivered for an Amazon listing (KAN-226, owner 2026-10-27): the page badge when it shows one;
 * otherwise a child of a variation family is "fewer than 50" (its family shares one rank, each child its own badge),
 * a single SKU with a root rank below 20,000 takes the curve, and everything else takes the floor. Supply Smart reads
 * `unitsSold` as is; `extras.salesEstimate` is where the crawler remembers which number is an estimate. `salesRank`
 * is the rank the decision used, so a reparsed rank also reaches the observation item.
 */
export function salesEstimateDelivery(input: SalesEstimateInput): {
  salesRank?: number | undefined;
  unitsSold?: number;
  unitsSoldPeriod?: "trailing_30d";
  extras: Record<string, unknown>;
} {
  if (input.channel !== "amazon") {
    return { extras: input.extras };
  }
  const { rank, read } = rankOf(input);
  const detail: SalesEstimateExtras = { ...decide(input, rank), rankRead: read };
  const extras = { ...input.extras, salesEstimate: detail };
  const salesRank = rank?.rank;
  return detail.source === "badge"
    ? { salesRank, extras }
    : { salesRank, unitsSold: detail.units, unitsSoldPeriod: "trailing_30d", extras };
}
