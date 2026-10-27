import type {
  EnrichmentChange,
  EnrichmentOutcome,
  SupplySmartEnrichment,
} from "@crawl-automation/app";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

const CALL_SIZE = 20;
const RETRY_SIZE = 5;
const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

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

  /**
   * Supply Smart takes about 0.5 s a product, so a call of 100 passed the 60 s request timeout (2026-10-26, backfill
   * batch 5): calls go 20 products at a time. A call that still fails is tried once more in calls of 5; the update
   * is idempotent, so a write cut off by the timeout is safe to repeat. A second failure is thrown.
   */
  async update(
    changes: EnrichmentChange[],
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<EnrichmentOutcome[]> {
    const outcomes: EnrichmentOutcome[] = [];
    for (const chunk of chunks(changes, CALL_SIZE)) {
      try {
        outcomes.push(...(await this.call(chunk, dryRun, signal)));
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        for (const smaller of chunks(chunk, RETRY_SIZE)) {
          outcomes.push(...(await this.call(smaller, dryRun, signal)));
        }
      }
    }
    return outcomes;
  }

  private async call(
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
