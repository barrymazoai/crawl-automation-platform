import { ChannelIdSchema, Id, ListQuery, Source } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** Keep brand-scoped listing; channel-scoped listing can also narrow to a brand. */
export const ListSourcesSchema = ListQuery.extend({
  brandId: Id.optional(),
  channel: ChannelIdSchema.optional(),
  enabled: z.boolean().optional(),
  scanned: z.boolean().optional(),
}).refine((query) => query.brandId !== undefined || query.channel !== undefined, {
  message: "Provide brandId or channel",
});

export const SourceScanViewSchema = Source.extend({
  brandName: z.string(),
  lastScan: z
    .strictObject({
      scanId: z.uuid(),
      requestId: z.uuid(),
      state: z.enum(["queued", "running", "complete", "partial", "review"]),
      requestedAt: z.iso.datetime({ offset: true }),
      startedAt: z.iso.datetime({ offset: true }).nullable(),
      finishedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .nullable(),
  /** All queue rows for this source, including repeated batches and followers. */
  queueProductCount: z.number().int().nonnegative(),
});
export type SourceScanView = z.infer<typeof SourceScanViewSchema>;
