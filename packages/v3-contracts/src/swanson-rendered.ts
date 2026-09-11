import { z } from "zod";
// Whitelisted DOM projection, never a serialized window/Shopify object or raw page scripts.
// A capture adapter must collect these fields together from one settled product page.
export const SwansonRenderedProductSchema = z.strictObject({
  url: z.string().url().max(4096), canonicalUrl: z.string().url().max(4096),
  title: z.string().trim().min(1).max(4000), capturedAt: z.iso.datetime(),
  selectedForms: z.array(z.strictObject({ productId: z.string().regex(/^\d+$/),
    variantIds: z.array(z.string().regex(/^\d+$/)).min(1).max(10) })).min(1).max(10),
  gallery: z.array(z.strictObject({ url: z.string().url().max(4096), alt: z.string().max(4000) })).max(100),
  sections: z.array(z.strictObject({ heading: z.enum(["Product Details", "Product Facts"]),
    text: z.string().max(500000) })).max(8),
  // Optional for historical captures. Public size/flavour controls, never purchase plans.
  variantPicker: z.strictObject({ unmapped: z.number().int().min(0), options: z.array(z.strictObject({
    group: z.string().min(1).max(1000), label: z.string().min(1).max(1000),
    url: z.string().url().max(4096), variantId: z.string().regex(/^\d+$/),
    selected: z.boolean(), available: z.boolean(),
  })).max(100) }).optional(),
});
export type SwansonRenderedProduct = z.infer<typeof SwansonRenderedProductSchema>;
