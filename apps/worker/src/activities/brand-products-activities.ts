import { z } from "zod";
import { BrandProductsAttemptSchema } from "@crawl-automation/v3-contracts";
import { productStep } from "@crawl-automation/app";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

/** Historical activities omit attempt; the products service defaults to one. */
export function brandProductsActivities(parts: WorkerParts) {
  return {
    brandProducts: guarded(
      "brandProducts",
      async (raw, signal) => {
        const { runId, attempt } = BrandProductsAttemptSchema.parse(raw);
        return (await parts.brandEnrichment).products.tick(runId, signal, attempt);
      },
      parts.log,
    ),
    brandProductsStop: guarded(
      "brandProductsStop",
      async (raw) => {
        const { runId, attempt } = BrandProductsAttemptSchema.parse(raw);
        await (await parts.brandEnrichment).products.stop(runId, attempt);
      },
      parts.log,
    ),
    brandProductFailure: guarded(
      "brandProductFailure",
      async (raw) => {
        const { runId, attempt, reason } = BrandProductsAttemptSchema.extend({
          reason: z.string(),
        }).parse(raw);
        await (
          await parts.brandEnrichment
        ).runs.saveStep({
          runId,
          step: productStep("products-failure", attempt),
          output: { reason },
          archiveKeys: [],
        });
      },
      parts.log,
    ),
  };
}
