import type { SupplySmartProductFacts, SupplySmartProducts } from "@crawl-automation/app";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

/**
 * Only the fields the removal decision reads; the detail view carries much more. All are required: an answer without
 * them is unexpected and stops the removal, never read as "no listings" or "no formula".
 */
const DetailSchema = z.looseObject({
  source: z.string(),
  formulaId: z.string().nullable(),
  productChannels: z.array(z.looseObject({ id: z.string(), channel: z.string() })),
  formulaObservations: z.array(z.unknown()),
});

/**
 * Products on the product database gateway: `product.getDetail` and `product.delete`, which deletes the product with
 * its listings, images, snapshots and observations. An unknown ID is an error there, never an empty answer.
 */
export class SupplySmartProductsClient implements SupplySmartProducts {
  constructor(private readonly rpc: Pick<SupplySmartRpc, "call">) {}

  async facts(productId: string, signal: AbortSignal): Promise<SupplySmartProductFacts> {
    const detail = await this.rpc.call(
      {
        api: "database",
        path: "product.getDetail",
        input: { id: productId },
        answer: DetailSchema,
      },
      signal,
    );
    return {
      source: detail.source,
      listings: detail.productChannels.map(({ id, channel }) => ({ id, channel })),
      formulaId: detail.formulaId,
      formulaObservations: detail.formulaObservations.length,
    };
  }

  async delete(productId: string, signal: AbortSignal): Promise<void> {
    await this.rpc.call(
      { api: "database", path: "product.delete", input: { id: productId }, answer: z.unknown() },
      signal,
    );
  }
}
