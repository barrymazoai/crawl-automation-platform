import type { SupplySmartHealthFunctions } from "@crawl-automation/app";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

const LinkedSchema = z.array(z.looseObject({ id: z.string(), name: z.string() }));

/**
 * A product's health function links on the product database gateway: `product.getProductHealthFunctions` and
 * `product.removeProductHealthFunction`, which deletes only that one link. Never `deleteHealthFunction`: in Supply
 * Smart's database that cascades to every product's link.
 */
export class SupplySmartHealthFunctionsClient implements SupplySmartHealthFunctions {
  constructor(private readonly rpc: Pick<SupplySmartRpc, "call">) {}

  async list(productId: string, signal: AbortSignal): Promise<{ id: string; name: string }[]> {
    const linked = await this.rpc.call(
      {
        api: "database",
        path: "product.getProductHealthFunctions",
        input: { productId },
        answer: LinkedSchema,
      },
      signal,
    );
    return linked.map(({ id, name }) => ({ id, name }));
  }

  async unlink(productId: string, healthFunctionId: string, signal: AbortSignal): Promise<void> {
    await this.rpc.call(
      {
        api: "database",
        path: "product.removeProductHealthFunction",
        input: { productId, healthFunctionId },
        answer: z.unknown(),
      },
      signal,
    );
  }
}
