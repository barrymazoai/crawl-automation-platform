import { canonicalHash, productDeliveryErrors } from "@crawl-automation/app";
import type {
  MarketplaceHistory,
  MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { MARKETPLACE_HISTORY } from "./marketplace-queries.js";

const History = z.object({
  codec: z.literal("v3-capture-history/1"),
  observationId: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  listing: z.object({ channel: z.string(), externalId: z.string(), url: z.url() }),
  owner: z.object({
    runId: z.string(),
    sourceId: z.string(),
    brandId: z.string(),
    operationId: z.string(),
  }),
  capture: z.object({ variantId: z.string().nullable() }),
  metrics: z.record(z.string(), z.unknown()),
  evidence: z.array(z.object({ objectKey: z.string(), sha256: z.string() })),
});

/** The same immutable capture selection and hash check for sync and bounded DFA inspection. */
export async function marketplaceHistory(
  database: Queryable,
  input: Pick<MarketplaceProduct, "channel" | "runId" | "sourceId" | "url" | "variantId">,
): Promise<MarketplaceHistory> {
  const rows = await database.query<{ record: unknown; body_hash: string }>(MARKETPLACE_HISTORY, [
    input.channel,
    input.runId,
    input.sourceId,
    input.url,
    input.variantId,
  ]);
  const row = rows[0];
  if (!row) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
  }
  if (rows.length > 1 || canonicalHash(row.record) !== row.body_hash) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
  return History.parse(row.record);
}
