import { z } from "zod";

/**
 * Monthly units from the root Best Sellers Rank (KAN-226, owner 2026-10-27). The curve is a table, not a formula:
 * interval-censored fits of 26,026 Health & Household single-SKU pages plus 563 Best Sellers head rows (research
 * rounds 2–3, Server 一 kan226-bsr-fit/round3_results.md and kan226-head/head_results.md). Holdout: 90.2% of pages
 * within one Amazon bucket, 41% in the exact bucket. Between nodes the curve is linear in log rank / log units.
 *
 * Other root categories reuse the shape with a factor from their own fits at the same rank (Beauty 2,997 vs 3,010 at
 * rank 10,000 → 1; Grocery 1,980 → 0.5; Pet 547 → 0.17). A category without a factor gets no estimate.
 */
export const AMAZON_SALES_CURVE = {
  model: "amazon-bsr-monthly/1",
  /** [root rank, monthly units median] for Health & Household. */
  nodes: [
    [100, 71_319],
    [300, 44_400],
    [1_000, 22_535],
    [3_000, 9_552],
    [10_000, 3_010],
    [20_000, 1_115],
    [30_000, 776],
    [64_000, 236],
    [100_000, 117],
    [284_000, 12],
    [1_000_000, 1],
  ],
  /** 80% of pages fall within units ÷ band … units × band; the head (rank < 20,000) is tighter. */
  band80: { head: 1.9, tail: 2.7, headBelowRank: 20_000 },
  categoryFactors: {
    "Health & Household": 1,
    "Beauty & Personal Care": 1,
    "Grocery & Gourmet Food": 0.5,
    "Pet Supplies": 0.17,
  },
} as const;

export const AmazonSalesEstimateSchema = z.strictObject({
  model: z.literal(AMAZON_SALES_CURVE.model),
  category: z.string().min(1).max(200),
  rank: z.number().int().positive(),
  factor: z.number().positive(),
  units: z.number().int().positive(),
  range80: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
});
export type AmazonSalesEstimate = z.infer<typeof AmazonSalesEstimateSchema>;

/** Null when the category has no factor or the rank is past the last node (the delivery floor applies). */
export function estimateMonthlyUnits(input: {
  category: string;
  rank: number;
}): AmazonSalesEstimate | null {
  const factor = (AMAZON_SALES_CURVE.categoryFactors as Record<string, number | undefined>)[
    input.category
  ];
  const { nodes, band80 } = AMAZON_SALES_CURVE;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!factor || !Number.isInteger(input.rank) || input.rank <= 0 || !first || !last) {
    return null;
  }
  if (input.rank > last[0]) {
    return null;
  }
  const rank = Math.max(input.rank, first[0]);
  const x = Math.log(rank);
  let median = Math.log(last[1]);
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const [rankA, unitsA] = nodes[index]!;
    const [rankB, unitsB] = nodes[index + 1]!;
    if (rank >= rankA && rank <= rankB) {
      const t = (x - Math.log(rankA)) / (Math.log(rankB) - Math.log(rankA));
      median = Math.log(unitsA) + t * (Math.log(unitsB) - Math.log(unitsA));
      break;
    }
  }
  const units = Math.max(1, Math.round(Math.exp(median) * factor));
  const band = input.rank < band80.headBelowRank ? band80.head : band80.tail;
  return AmazonSalesEstimateSchema.parse({
    model: AMAZON_SALES_CURVE.model,
    category: input.category,
    rank: input.rank,
    factor,
    units,
    range80: [Math.floor(units / band), Math.ceil(units * band)],
  });
}
