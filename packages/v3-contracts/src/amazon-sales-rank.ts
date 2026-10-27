import { z } from "zod";

/**
 * The page's root-category Best Sellers Rank ("#5,218 in Health & Household (See Top 100 in …)"), never a
 * subcategory rank. Null when the page shows no root rank or its detail layouts disagree.
 */
export const AmazonSalesRankSchema = z.strictObject({
  rank: z.number().int().positive(),
  category: z.string().min(1).max(200),
  rawText: z.string().max(2000),
  selector: z.enum(["#detailBullets_feature_div li", "#prodDetails tr"]),
});
export type AmazonSalesRank = z.infer<typeof AmazonSalesRankSchema>;
