import type { BrandRequests } from "@crawl-automation/app";
import { BrandRequestListSchema, type BrandRequestUpdate } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { supplySmartStatus, type SupplySmartRpc } from "./supply-smart-rpc.js";

/** `brandEnrichment/serviceList` and `serviceUpdateStatus` on the biz API. */
export class SupplySmartBrandRequests implements BrandRequests {
  constructor(private readonly rpc: SupplySmartRpc) {}

  async pending(limit: number, signal: AbortSignal) {
    const answer = await this.rpc.call(
      {
        api: "biz",
        path: "brandEnrichment.serviceList",
        input: { status: "pending", sort: "oldest", page: 1, pageSize: limit },
        answer: BrandRequestListSchema,
      },
      signal,
    );
    return answer.requests;
  }

  async update(update: BrandRequestUpdate, signal: AbortSignal) {
    try {
      await this.rpc.call(
        {
          api: "biz",
          path: "brandEnrichment.serviceUpdateStatus",
          input: update,
          answer: z.unknown(),
        },
        signal,
      );
      return { claimed: true };
    } catch (error) {
      if (update.status === "in_progress" && supplySmartStatus(error) === 409) {
        return { claimed: false };
      }
      throw error;
    }
  }
}
