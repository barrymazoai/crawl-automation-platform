import { z } from "zod";

/** Public storefront client key, supplied by the owner's private API and worker configuration. */
export const SwansonBrandScanSettingsSchema = z.strictObject({
  constructorKey: z.string().trim().min(1).max(200),
});
export type SwansonBrandScanSettings = z.infer<typeof SwansonBrandScanSettingsSchema>;
