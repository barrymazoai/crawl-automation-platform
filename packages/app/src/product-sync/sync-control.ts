import { z } from "zod";
import type { ProductSyncLedger } from "./ledger.js";

const channel = z.enum(["amazon", "gnc", "swanson", "wholefoods", "costco"]);

/** Listings found in Supply Smart before the ledger existed (read-only baseline, owner 2026-10-12). */
export const MarkPresentSchema = z.strictObject({
  channel,
  listings: z
    .array(
      z.strictObject({
        listingId: z.string().trim().min(1).max(200),
        variantId: z.string().trim().min(1).max(200).nullable(),
      }),
    )
    .min(1)
    .max(10_000),
});
export type MarkPresent = z.infer<typeof MarkPresentSchema>;

/**
 * Products to send again after a fix: failures with a reason, e.g. `PRODUCT_DELIVERY.MATERIAL_MISSING`, verified
 * products sent without a formula (`withoutLabel`), or attempts whose outcome never arrived (`unfinished`, a batch
 * cut off by a 429), 2026-10-12, the `present` baseline (listings Supply Smart had without our formula, 2026-10-13),
 * or verified products sent with a formula (`withLabel`: resend with the label confidence, 2026-10-16).
 * Exactly one of them.
 */
export const ReopenSyncSchema = z.union([
  z.strictObject({
    channel: channel.optional(),
    reason: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(20_000),
  }),
  z.strictObject({
    channel: channel.optional(),
    withoutLabel: z.literal(true),
    limit: z.number().int().min(1).max(20_000),
  }),
  z.strictObject({
    channel: channel.optional(),
    unfinished: z.literal(true),
    limit: z.number().int().min(1).max(20_000),
  }),
  z.strictObject({
    channel: channel.optional(),
    present: z.literal(true),
    limit: z.number().int().min(1).max(20_000),
  }),
  z.strictObject({
    channel: channel.optional(),
    withLabel: z.literal(true),
    limit: z.number().int().min(1).max(20_000),
  }),
]);
export type ReopenSync = z.infer<typeof ReopenSyncSchema>;

/** Database-only controls for the API; sending runs in the brand-enrichment worker's sweep. */
export class ProductSyncControl {
  constructor(private readonly deps: { ledger: ProductSyncLedger }) {}

  async status() {
    const [overview, ledger] = await Promise.all([
      this.deps.ledger.overview(),
      this.deps.ledger.counts(),
    ]);
    return { overview, ledger };
  }

  reopen(raw: ReopenSync) {
    const input = ReopenSyncSchema.parse(raw);
    const { channel: only, ...which } = input;
    return this.deps.ledger.reopen({ ...(only ? { channel: only } : {}), ...which });
  }

  markPresent(raw: MarkPresent) {
    const input = MarkPresentSchema.parse(raw);
    return this.deps.ledger.markPresent(
      input.listings.map((listing) => ({ channel: input.channel, ...listing })),
    );
  }
}
