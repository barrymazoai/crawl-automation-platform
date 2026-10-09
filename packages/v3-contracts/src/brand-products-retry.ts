import { z } from "zod";
import { BrandEnrichmentWorkflowSettingsSchema } from "./brand-enrichment-workflow.js";

/** Omitted on historical products activities; workers interpret omission as attempt one. */
export const BrandProductsAttemptSchema = z.object({
  runId: z.uuid(),
  attempt: z.number().int().min(1).optional(),
});
export type BrandProductsAttempt = z.infer<typeof BrandProductsAttemptSchema>;

export const BrandProductsRetryInputSchema = z.strictObject({
  runId: z.uuid(),
  attempt: z.number().int().min(2),
  settings: BrandEnrichmentWorkflowSettingsSchema,
});
export type BrandProductsRetryInput = z.infer<typeof BrandProductsRetryInputSchema>;
export type BrandProductsRetryRequest = Pick<BrandProductsRetryInput, "runId" | "attempt">;

export function brandProductsRetryWorkflowId(input: BrandProductsRetryRequest): string {
  return `brand-products-retry-${input.runId}-${input.attempt}`;
}
