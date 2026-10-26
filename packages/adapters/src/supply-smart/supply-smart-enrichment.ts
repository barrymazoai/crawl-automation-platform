import type {
  EnrichmentChange,
  EnrichmentOutcome,
  SupplySmartEnrichment,
} from "@crawl-automation/app";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

const ChangesSchema = z.looseObject({
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
const BatchSchema = z.looseObject({
  dryRun: z.boolean(),
  results: z.array(
    z.union([
      z.looseObject({
        productId: z.string(),
        ok: z.literal(true),
        result: z.looseObject({
          forms: ChangesSchema,
          healthFunctions: ChangesSchema,
          mainIngredients: ChangesSchema,
        }),
      }),
      z.looseObject({
        productId: z.string(),
        ok: z.literal(false),
        error: z.looseObject({ code: z.string(), message: z.string() }),
      }),
    ]),
  ),
});

/**
 * `product.updateEnrichmentBatch` on the product database gateway (SUPPLYSMAR-464, service key only): each product
 * its own transaction. `add` finds or creates vocabulary as ingest does; `remove` deletes link rows only, never a
 * form, health function or ingredient. Idempotent, no operation ID.
 */
export class SupplySmartEnrichmentClient implements SupplySmartEnrichment {
  constructor(private readonly rpc: Pick<SupplySmartRpc, "call">) {}

  async update(
    changes: EnrichmentChange[],
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<EnrichmentOutcome[]> {
    const answer = await this.rpc.call(
      {
        api: "database",
        path: "product.updateEnrichmentBatch",
        input: { items: changes, dryRun },
        answer: BatchSchema,
      },
      signal,
    );
    return answer.results.map((entry) =>
      entry.ok
        ? {
            productId: entry.productId,
            ok: true,
            added: {
              forms: entry.result.forms.added,
              healthFunctions: entry.result.healthFunctions.added,
              mainIngredients: entry.result.mainIngredients.added,
            },
            removed: {
              forms: entry.result.forms.removed,
              healthFunctions: entry.result.healthFunctions.removed,
              mainIngredients: entry.result.mainIngredients.removed,
            },
          }
        : {
            productId: entry.productId,
            ok: false,
            code: entry.error.code,
            message: entry.error.message,
          },
    );
  }
}
