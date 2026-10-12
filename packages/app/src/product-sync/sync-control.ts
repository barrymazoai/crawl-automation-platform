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

  markPresent(raw: MarkPresent) {
    const input = MarkPresentSchema.parse(raw);
    return this.deps.ledger.markPresent(
      input.listings.map((listing) => ({ channel: input.channel, ...listing })),
    );
  }
}
