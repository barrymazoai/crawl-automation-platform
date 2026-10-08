import { NotSupplementSchema } from "@crawl-automation/v3-contracts";
import { patched } from "@temporalio/workflow";
import { z } from "zod";
import type { CaptureResult, ProductPipelineInput } from "./pipeline-model.js";

/**
 * Owner 2026-10-08: a label Review for a product its store files outside supplements finishes it without a formula.
 * Only new histories (marker) and only captures that carry the store's breadcrumb.
 */
export function notSupplement(
  input: ProductPipelineInput,
  captured: Extract<CaptureResult, { status: "captured" }>,
  result: unknown,
) {
  const review = z
    .object({
      status: z.literal("review"),
      code: z.string().optional(),
      codes: z.array(z.string()).optional(),
    })
    .passthrough();
  const parsed = review.safeParse(result);
  if (!captured.nonSupplement || !parsed.success || !patched("not-supplement-v1")) {
    return null;
  }
  const { listingId, variantId } = captured.sourcePlan.owner;
  return NotSupplementSchema.parse({
    status: "not-supplement",
    operationId: input.operationId,
    listingId,
    variantId,
    reason: "PRODUCT.NOT_SUPPLEMENT",
    policy: "store-category/1",
    categories: captured.nonSupplement,
    reviewCode: parsed.data.code ?? parsed.data.codes?.[0] ?? null,
  });
}
