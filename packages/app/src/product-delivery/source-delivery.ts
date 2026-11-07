import { z } from "zod";
import type {
  ProductDelivery,
  ProductDeliveryRequest,
  ProductDeliveryResult,
} from "../brand-enrichment/task-ports.js";
import { productDeliveryGroups } from "../brand-enrichment/product-delivery-groups.js";
import { productDeliveryErrors } from "./errors.js";

export const DTC_DELIVERY_TARGETS = ["production", "test"] as const;
export type DtcDeliveryTarget = (typeof DTC_DELIVERY_TARGETS)[number];

/**
 * KAN-259 (owner 2026-11-07): settled DTC products of crawler sources collected outside brand enrichment (CSV
 * batches through `brands.analyzeSite`) sent to an existing Supply Smart company. The target is always named;
 * a dry run (default) reads and maps only.
 */
export const DeliverDtcSourcesSchema = z.strictObject({
  companyId: z.uuid(),
  sourceIds: z.array(z.uuid()).min(1).max(20),
  target: z.enum(DTC_DELIVERY_TARGETS),
  dryRun: z.boolean().default(true),
});

export interface DtcPreviewDelivery extends ProductDelivery {
  preview(
    request: ProductDeliveryRequest,
    signal: AbortSignal,
  ): Promise<ProductDeliveryResult & { deliverable: number }>;
}

export class DtcSourceDelivery {
  constructor(
    private readonly deps: { deliveries: Partial<Record<DtcDeliveryTarget, DtcPreviewDelivery>> },
  ) {}

  async deliver(raw: unknown, signal = new AbortController().signal) {
    const input = DeliverDtcSourcesSchema.parse(raw);
    const delivery = this.deps.deliveries[input.target];
    if (!delivery) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.TARGET_MISSING", {
        details: { target: input.target },
      });
    }
    const sourceIds = [...new Set(input.sourceIds)];
    const groups = productDeliveryGroups(sourceIds, await delivery.catalogs(sourceIds, signal));
    const results = [];
    for (const group of groups) {
      signal.throwIfAborted();
      // One stable ingest run per company and catalog domain, so a repeated delivery reuses it.
      const request: ProductDeliveryRequest = {
        companyId: input.companyId,
        siteKey: group.siteKey,
        sourceIds: group.sourceIds,
        ingestRunId: `dtc-company-${input.companyId}-${group.siteKey}`,
      };
      const result = input.dryRun
        ? await delivery.preview(request, signal)
        : { ...(await delivery.deliver(request, signal)), deliverable: null };
      results.push({ siteKey: group.siteKey, sourceIds: group.sourceIds, ...result });
    }
    return {
      target: input.target,
      dryRun: input.dryRun,
      companyId: input.companyId,
      groups: results,
    };
  }
}
