import {
  MARKETPLACE_CHANNELS,
  type MarketplacePage,
  type MarketplaceProduct,
  type MarketplaceReadRequest,
} from "@crawl-automation/app/marketplace-mapping";
import { errorCodeOf } from "@crawl-automation/platform";
import { z } from "zod";
import {
  MarketplaceMaterials,
  type MarketplaceReaderDependencies,
} from "./marketplace-materials.js";
import { MARKETPLACE_QUEUE } from "./marketplace-queries.js";
export type { MarketplaceReaderDependencies } from "./marketplace-materials.js";

interface QueueRow {
  item_id: string;
  listing_id: string;
  variant_id: string | null;
  url: string;
  run_id: string;
  source_id: string;
  brand_id: string;
  brand: string;
  material_at: string;
}
const Request = z.object({
  channel: z.enum(MARKETPLACE_CHANNELS),
  limit: z.number().int().min(1).max(200),
  after: z
    .object({ listingId: z.string().min(1), variantId: z.string().min(1).nullable() })
    .optional(),
  pending: z.boolean().optional(),
});

/** Read-only keyset pages of settled marketplace products. No fetch, RPC, retry or database writes. */
export class PostgresMarketplaceReader {
  private readonly materials: MarketplaceMaterials;
  constructor(private readonly deps: MarketplaceReaderDependencies) {
    this.materials = new MarketplaceMaterials(deps);
  }
  async read(raw: MarketplaceReadRequest, signal: AbortSignal): Promise<MarketplacePage> {
    const request = Request.parse(raw);
    signal.throwIfAborted();
    const rows = await this.deps.database.query<QueueRow>(MARKETPLACE_QUEUE, [
      request.channel,
      request.after?.listingId ?? null,
      request.after?.variantId ?? null,
      request.limit + 1,
      request.pending ?? false,
    ]);
    const products: MarketplaceProduct[] = [];
    for (const row of rows.slice(0, request.limit)) {
      signal.throwIfAborted();
      products.push(await this.product(row, request.channel, signal));
    }
    const last = products.at(-1);
    return {
      products,
      after:
        rows.length > request.limit && last
          ? { listingId: last.listingId, variantId: last.variantId }
          : null,
    };
  }
  private async product(
    row: QueueRow,
    channel: MarketplaceProduct["channel"],
    signal: AbortSignal,
  ) {
    const base: MarketplaceProduct = {
      channel,
      queueId: row.item_id,
      listingId: row.listing_id,
      variantId: row.variant_id,
      url: row.url,
      runId: row.run_id,
      sourceId: row.source_id,
      brandId: row.brand_id,
      brand: row.brand,
      materialAt: row.material_at,
      collection: null,
      history: null,
      enrichment: null,
      product: null,
    };
    try {
      return await this.materials.read(base, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Keep the real reason and advance the cursor; siblings must remain deliverable.
      return {
        ...base,
        problem: errorCodeOf(error) ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  }
}
