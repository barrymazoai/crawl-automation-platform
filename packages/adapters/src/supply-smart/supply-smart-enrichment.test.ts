import { expect, it, vi } from "vitest";
import type { z } from "zod";
import type { SupplySmartCall } from "./supply-smart-rpc.js";
import { SupplySmartEnrichmentClient } from "./supply-smart-enrichment.js";

const productId = "c980a97c-9cae-4985-bb5b-a18c50df94f1";
const missing = "0b7f3c51-8d55-4a4f-a5c8-3e5c4d1f2a90";
const kinds = (added: string[], removed: string[]) => ({
  added,
  removed,
  unchanged: [],
  ignored: [],
});

it("sends one batch to product.updateEnrichmentBatch and reads each product's outcome", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) =>
    request.answer.parse({
      dryRun: true,
      results: [
        {
          productId,
          ok: true,
          result: {
            productId,
            dryRun: true,
            forms: kinds(["Tablet"], ["Chewable"]),
            healthFunctions: kinds(["Muscle Recovery"], ["support optimal protein synthesis"]),
            mainIngredients: kinds([], []),
            created: { forms: [], healthFunctions: ["Muscle Recovery"], ingredients: [] },
            unknownCategories: [],
          },
        },
        {
          productId: missing,
          ok: false,
          error: { code: "NOT_FOUND", message: "Product not found" },
        },
      ],
    }),
  );
  const changes = [
    {
      productId,
      add: { productForm: "tablet", healthFunctions: ["Muscle Recovery"], mainIngredients: [] },
      remove: {
        forms: ["chewable"],
        healthFunctions: ["support optimal protein synthesis"],
        mainIngredients: [],
      },
    },
  ];
  const outcomes = await new SupplySmartEnrichmentClient({ call } as never).update(
    changes,
    true,
    new AbortController().signal,
  );
  expect(call.mock.calls[0]?.[0]).toMatchObject({
    api: "database",
    path: "product.updateEnrichmentBatch",
    input: { items: changes, dryRun: true },
  });
  expect(outcomes).toEqual([
    {
      productId,
      ok: true,
      added: { forms: ["Tablet"], healthFunctions: ["Muscle Recovery"], mainIngredients: [] },
      removed: {
        forms: ["Chewable"],
        healthFunctions: ["support optimal protein synthesis"],
        mainIngredients: [],
      },
    },
    { productId: missing, ok: false, code: "NOT_FOUND", message: "Product not found" },
  ]);
});
