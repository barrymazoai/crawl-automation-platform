import { NotSupplementSchema } from "@crawl-automation/v3-contracts";
import type { ProductIdentity } from "../adapter.js";
import type { CaptureRequest } from "./capture-request.js";

/** End a trusted store-category exclusion before source planning and formula work. */
export function neverCollectResult(
  request: CaptureRequest,
  parsed: { neverCollect?: string[]; identity: ProductIdentity },
) {
  return parsed.neverCollect?.length
    ? NotSupplementSchema.parse({
        status: "not-supplement",
        operationId: request.operationId,
        ...parsed.identity,
        reason: "PRODUCT.NOT_SUPPLEMENT",
        policy: "store-category/1",
        categories: parsed.neverCollect,
        reviewCode: null,
      })
    : null;
}
