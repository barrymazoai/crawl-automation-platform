import { ChannelIdSchema, ResourceGateSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** A listing snapshot; no product processing or queue mutation runs in this workflow. */
export const BrandListingRequestSchema = z.strictObject({
  scanId: z.uuid(),
  source: z.strictObject({
    sourceId: z.uuid(),
    channel: ChannelIdSchema,
    url: z.url(),
    brandName: z.string().optional(),
  }),
});
export const BrandListingInputSchema = BrandListingRequestSchema.extend({
  resources: ResourceGateSchema,
  gapAfterSeconds: z.number().int().nonnegative().default(0),
  cooldownSeconds: z.number().int().nonnegative().default(0),
});
export type BrandListingRequest = z.infer<typeof BrandListingRequestSchema>;
