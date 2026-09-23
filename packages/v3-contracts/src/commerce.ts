import {z} from "zod";
import {PurchaseConditionsSchema} from "./purchase-conditions.js";

/** Optional public-page fields; omission keeps old retained captures readable. */
export const CommerceEvidenceSchema=z.strictObject({
  codec:z.literal("public-product-commerce/1"),
  sku:z.string().max(1000).nullable(),price:z.string().max(1000).nullable(),currency:z.string().max(20).nullable(),
  listPrice:z.string().max(1000).nullable(),rating:z.string().max(1000).nullable(),reviewCount:z.string().max(1000).nullable(),
  availability:z.string().max(1000).nullable(),context:z.array(z.string().max(4000)).max(20),
  // Public purchase badge, not an exact order count. Keep its qualifier and time window.
  salesVolume:z.strictObject({text:z.string().max(1000),lowerBound:z.string().regex(/^[1-9]\d*$/),
    approximate:z.boolean(),period:z.enum(['past_month','past_week']),selector:z.string().max(300)}).nullable().optional(),
  purchaseConditions:PurchaseConditionsSchema.optional(),
});
