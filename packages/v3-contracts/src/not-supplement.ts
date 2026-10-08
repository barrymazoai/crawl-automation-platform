import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";

/**
 * Owner 2026-10-08: a product its store files outside supplements (the breadcrumb is kept) whose label step went to
 * Review. It is done without a formula; its product data was recorded at capture. `reviewCode` keeps what the label
 * step reported.
 */
export const NotSupplementSchema = z.strictObject({
  status: z.literal("not-supplement"),
  operationId: ExecutionIdSchema,
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
  reason: z.literal("PRODUCT.NOT_SUPPLEMENT"),
  policy: z.literal("store-category/1"),
  categories: z.array(z.string().min(1).max(200)).min(1).max(20),
  reviewCode: z.string().min(1).max(200).nullable(),
});
export type NotSupplement = z.infer<typeof NotSupplementSchema>;
