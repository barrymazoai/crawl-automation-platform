import {z} from "zod";

/** Optional public-page fields; omission keeps old retained captures readable. */
export const CommerceEvidenceSchema=z.strictObject({
  codec:z.literal("public-product-commerce/1"),
  sku:z.string().max(1000).nullable(),price:z.string().max(1000).nullable(),currency:z.string().max(20).nullable(),
  listPrice:z.string().max(1000).nullable(),rating:z.string().max(1000).nullable(),reviewCount:z.string().max(1000).nullable(),
  availability:z.string().max(1000).nullable(),context:z.array(z.string().max(4000)).max(20),
});
