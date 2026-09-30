import type { CollectionScan, CollectionScanRequest } from "@crawl-automation/workflows";
import { appErrors } from "../errors.js";
import type { BrandScanStore } from "./ports.js";

/** A brand run's scan as its CollectionWorkflow sees it: its state and, once finished, what it queued. */
export class RunScans {
  constructor(private readonly store: Pick<BrandScanStore, "byRequest">) {}

  async scanOf(request: CollectionScanRequest): Promise<CollectionScan> {
    const scan = await this.store.byRequest(request.requestId, request.sourceId);
    if (!scan) {
      throw appErrors.create("RUN.SCAN_MISSING", { details: request });
    }
    return {
      scanId: scan.scanId,
      state: scan.state,
      queued: scan.result?.queued ?? null,
      code: scan.result?.code ?? null,
    };
  }
}
