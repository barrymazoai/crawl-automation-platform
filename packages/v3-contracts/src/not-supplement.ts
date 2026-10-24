import { z } from "zod";
import { ExecutionIdSchema } from "./artifacts.js";

/**
 * A store-filed product outside supplements. `reviewCode` keeps a label Review when the existing conditional rule
 * completes it; null also covers an owner-approved category that ends at capture before any label work.
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
