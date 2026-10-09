import type {
  DeliveryProduct,
  DeliverySnapshot,
  ProductDeliveryScan,
  ProductDeliveryReader,
  ProductDeliveryRequest,
  ProductDeliveryHold,
} from "@crawl-automation/app";
import { selectDeliverySettlement } from "@crawl-automation/app";
import { errorCodeOf, type ObjectStore, type Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import {
  DELIVERY_COLLECTIONS,
  DELIVERY_QUEUE,
  DELIVERY_SCANS,
  DELIVERY_HOLDS,
} from "./delivery-queries.js";
import { DeliveryMaterials } from "./delivery-materials.js";

interface QueueRow {
  item_id: string;
  batch_id: string;
  source_id: string;
  listing_id: string;
  variant_id: string | null;
  state: string;
  run_id: string | null;
  settled_at: Date | null;
  outcome: string | null;
}
interface ScanRow {
  settings: unknown;
  source_id: string;
  scan_id: string;
  state: string;
  started_at: Date | null;
  result: unknown;
}
const ScanResult = z.object({
  full: z.boolean(),
  capped: z.boolean().optional(),
  unresolvedFamilies: z.number(),
  products: z.number(),
  queued: z.number(),
  metrics: z.object({ recent: z.number().optional() }).optional(),
});

export class PostgresDeliveryReader implements ProductDeliveryReader {
  private readonly materials: DeliveryMaterials;
  constructor(private readonly deps: { database: Queryable; objects: Pick<ObjectStore, "read"> }) {
    this.materials = new DeliveryMaterials(deps);
  }

  async read(request: ProductDeliveryRequest, signal: AbortSignal): Promise<DeliverySnapshot> {
    signal.throwIfAborted();
    const queues = await this.deps.database.query<QueueRow>(DELIVERY_QUEUE, [request.sourceIds]);
    const scans = await this.deps.database.query<ScanRow>(DELIVERY_SCANS, [request.sourceIds]);
    const result: DeliverySnapshot = {
      products: [],
      review: 0,
      pending: 0,
      scans: scans.map(scanOf),
    };
    for (const queue of queues) {
      signal.throwIfAborted();
      if (queue.state === "review") {
        const selected = await this.settlement(queue, [], true);
        result.review += selected.review;
      } else if (queue.state === "completed" && queue.settled_at && queue.outcome === "completed") {
        const selected = await this.settlement(queue, await this.products(queue, signal), false);
        result.products.push(...selected.products);
        result.review += selected.review;
        result.pending += selected.pending;
      } else {
        result.pending += 1;
      }
    }
    return result;
  }

  private async settlement(queue: QueueRow, products: DeliveryProduct[], queueReview: boolean) {
    const holds = await this.deps.database.query<ProductDeliveryHold>(DELIVERY_HOLDS, [
      queue.run_id,
      queue.source_id,
    ]);
    return selectDeliverySettlement({ products, holds, queueReview });
  }

  private async products(queue: QueueRow, signal: AbortSignal): Promise<DeliveryProduct[]> {
    const rows = await this.deps.database.query<{ operation_id: string }>(DELIVERY_COLLECTIONS, [
      queue.run_id,
      queue.source_id,
    ]);
    const base = queueProduct(queue);
    if (!rows.length) {
      return [{ ...base, problem: "PRODUCT_DELIVERY.MATERIAL_MISSING" }];
    }
    const products: DeliveryProduct[] = [];
    for (const row of rows) {
      try {
        const material = await this.materials.read(row.operation_id, signal);
        products.push({
          ...base,
          operationId: row.operation_id,
          ...material,
          externalId:
            material.collection?.observation.variantId ??
            material.collection?.observation.listingId ??
            base.externalId,
        });
      } catch (error) {
        signal.throwIfAborted();
        products.push({
          ...base,
          operationId: row.operation_id,
          problem: errorCodeOf(error) ?? "PRODUCT_DELIVERY.MATERIAL_MISSING",
        });
      }
    }
    return products;
  }
}

function queueProduct(queue: QueueRow): DeliveryProduct {
  return {
    queueId: queue.item_id,
    batchId: queue.batch_id,
    sourceId: queue.source_id,
    externalId: queue.variant_id ?? queue.listing_id,
    collection: null,
    history: null,
    enrichment: null,
    product: null,
  };
}

function scanOf(row: ScanRow): ProductDeliveryScan {
  const parsed = ScanResult.safeParse(row.result);
  const result = parsed.success
    ? parsed.data
    : {
        full: false,
        unresolvedFamilies: 1,
        products: 0,
        queued: 0,
      };
  return {
    ...siteScope(row.settings),
    sourceId: row.source_id,
    scanId: row.scan_id,
    state: row.state,
    startedAt: row.started_at?.toISOString() ?? null,
    full: result.full,
    capped: result.capped ?? false,
    unresolvedFamilies: result.unresolvedFamilies,
    products: result.products,
    queued: result.queued,
    recent: result.metrics?.recent ?? 0,
  };
}

function siteScope(raw: unknown): Pick<ProductDeliveryScan, "siteKey" | "siteScope"> {
  const settings = z
    .object({
      siteKey: z.string(),
      kind: z.enum(["single-brand", "multi-brand"]).optional(),
      catalogUrl: z.url().optional(),
    })
    .safeParse(raw);
  if (!settings.success) {
    return { siteKey: null, siteScope: "unknown" };
  }
  return {
    siteKey: settings.data.siteKey,
    siteScope: settings.data.kind ?? (settings.data.catalogUrl ? "single-brand" : "unknown"),
  };
}
