import {
  canonicalHash,
  productDeliveryErrors,
  type DeliveryHistory,
  type DeliveryProduct,
} from "@crawl-automation/app";
import type { Queryable, ObjectStore } from "@crawl-automation/platform";
import { z } from "zod";
import { PostgresCollectedProducts } from "../postgres/postgres-collected-products.js";
import { deliveryEnrichment } from "./delivery-enrichment.js";
import { DELIVERY_HISTORY } from "./delivery-queries.js";
import { retainedProjection } from "./retained-projection.js";

const History = z.object({
  capturedAt: z.iso.datetime({ offset: true }),
  listing: z.object({ channel: z.literal("dtc"), externalId: z.string(), url: z.url() }),
  owner: z.object({ runId: z.string(), sourceId: z.string() }),
  capture: z.object({ variantId: z.string().nullable() }),
  metrics: z.record(z.string(), z.unknown()),
  evidence: z.array(z.object({ objectKey: z.string(), sha256: z.string() })),
});

export class DeliveryMaterials {
  constructor(private readonly deps: { database: Queryable; objects: Pick<ObjectStore, "read"> }) {}

  async read(
    operationId: string,
    signal: AbortSignal,
  ): Promise<Pick<DeliveryProduct, "collection" | "history" | "product" | "enrichment">> {
    const collection = await new PostgresCollectedProducts(this.deps.database).read(operationId);
    if (!collection) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
    }
    const history = await this.history(collection.observation);
    const enrichment = await deliveryEnrichment(this.deps.database, collection);
    const title = enrichment?.subject.titleEvidence;
    const references = [
      ...(title ? [{ objectKey: title.sourceId, sha256: title.sha256 }] : []),
      ...(history?.evidence ?? []),
    ];
    const product = await retainedProjection({ objects: this.deps.objects, references }, signal);
    return { collection, history, enrichment, product };
  }

  private async history(owner: {
    requestId: string;
    sourceId: string;
    listingId: string;
    variantId: string | null;
  }): Promise<DeliveryHistory | null> {
    const rows = await this.deps.database.query<{ record: unknown; body_hash: string }>(
      DELIVERY_HISTORY,
      [owner.requestId, owner.sourceId, owner.listingId, owner.variantId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    if (canonicalHash(row.record) !== row.body_hash) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    return History.parse(row.record);
  }
}
