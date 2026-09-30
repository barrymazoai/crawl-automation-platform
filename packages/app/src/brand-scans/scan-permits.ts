import { ResourceGateSchema, ResourceNeedSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { BrandListing, ListingScan } from "./scan-listing.js";

/** One scan holds one unit across its entire listing read (all pages and family expansion). */
export const BrandScanPermitSchema = z.strictObject({
  taskQueue: z.string().min(1).max(200),
  resourceQueue: ResourceGateSchema.shape.queue,
  resourceId: ResourceNeedSchema.shape.resourceId,
  maxWaitSeconds: ResourceGateSchema.shape.maxWaitSeconds,
});
export type BrandScanPermit = z.infer<typeof BrandScanPermitSchema>;

export interface GatedBrandListing {
  read(scan: ListingScan, signal: AbortSignal): Promise<BrandListing>;
}
