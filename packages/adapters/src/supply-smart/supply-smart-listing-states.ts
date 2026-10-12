import type {
  ListingStateAnswer,
  ListingStateBatch,
  ListingStateSender,
} from "@crawl-automation/app";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

/** Only what the crawler reads back; the full per-item answer is kept as the delivery record. */
const AnswerSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      clientRef: z.string(),
      status: z.enum(["ok", "failed", "unknown_listing"]),
    }),
  ),
});

/**
 * Delistings to Supply Smart through `product.ingestListingStateBatch` (SUPPLYSMAR-380): always `partial`, an unknown
 * listing is answered `unknown_listing` and nothing is created, a replay returns the first answer.
 */
export class SupplySmartListingStates implements ListingStateSender {
  constructor(private readonly rpc: SupplySmartRpc) {}

  async send(batch: ListingStateBatch, signal: AbortSignal): Promise<ListingStateAnswer[]> {
    const answer = await this.rpc.call(
      {
        api: "database",
        path: "product.ingestListingStateBatch",
        input: batch,
        answer: AnswerSchema,
      },
      signal,
    );
    return answer.results.map((result) => ({
      clientRef: result.clientRef,
      status: result.status,
      response: result,
    }));
  }
}
