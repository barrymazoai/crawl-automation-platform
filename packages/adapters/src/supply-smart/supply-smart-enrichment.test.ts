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

const change = (index: number) => ({
  productId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  add: { healthFunctions: ["Calm Support"], mainIngredients: [] },
  remove: { forms: [], healthFunctions: [], mainIngredients: [] },
});
const answer = (request: SupplySmartCall<z.ZodType>) => {
  const items = (request.input as { items: { productId: string }[] }).items;
  return request.answer.parse({
    dryRun: false,
    results: items.map(({ productId: id }) => ({
      productId: id,
      ok: true,
      result: {
        forms: kinds([], []),
        healthFunctions: kinds(["Calm Support"], []),
        mainIngredients: kinds([], []),
      },
    })),
  });
};
const sizes = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.map(
    ([request]) => (request as { input: { items: unknown[] } }).input.items.length,
  );

it("calls Supply Smart 20 products at a time, under its request timeout", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) => answer(request));
  const changes = Array.from({ length: 45 }, (_, index) => change(index));
  const outcomes = await new SupplySmartEnrichmentClient({ call } as never).update(
    changes,
    false,
    new AbortController().signal,
  );
  expect(sizes(call)).toEqual([20, 20, 5]);
  expect(outcomes.map((outcome) => outcome.productId)).toEqual(
    changes.map((item) => item.productId),
  );
});

it("tries a failed call once more in calls of 5, and a second failure is thrown", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) => answer(request));
  call.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
  const changes = Array.from({ length: 12 }, (_, index) => change(index));
  const client = new SupplySmartEnrichmentClient({ call } as never);
  expect(await client.update(changes, false, new AbortController().signal)).toHaveLength(12);
  expect(sizes(call)).toEqual([12, 5, 5, 2]);

  call.mockClear();
  call
    .mockRejectedValueOnce(new Error("timeout"))
    .mockRejectedValueOnce(new Error("timeout again"));
  await expect(client.update(changes, false, new AbortController().signal)).rejects.toThrow(
    "timeout again",
  );
  expect(sizes(call)).toEqual([12, 5]);
});
