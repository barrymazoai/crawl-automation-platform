import { expect, it, vi } from "vitest";
import type { z } from "zod";
import type { SupplySmartCall } from "./supply-smart-rpc.js";
import { SupplySmartProductsClient } from "./supply-smart-products.js";

const id = "c980a97c-9cae-4985-bb5b-a18c50df94f1";

it("reads the facts the removal decides on from the product detail view", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) =>
    request.answer.parse({
      id,
      name: "Ghost Not A Phase Shaker",
      source: "enrichment",
      formulaId: null,
      productChannels: [{ id: "listing-1", channel: "gnc", externalId: "610673" }],
      formulaObservations: [],
      productImages: [{ url: "https://example.test/1.jpg" }],
    }),
  );
  const client = new SupplySmartProductsClient({ call } as never);
  expect(await client.facts(id, new AbortController().signal)).toEqual({
    source: "enrichment",
    listings: [{ id: "listing-1", channel: "gnc" }],
    formulaId: null,
    formulaObservations: 0,
  });
  expect(call.mock.calls[0]?.[0]).toMatchObject({
    api: "database",
    path: "product.getDetail",
    input: { id },
  });
});

it("an answer without the decision fields is unexpected, never read as no formula", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) =>
    request.answer.parse({ id, source: "enrichment", formulaId: null, productChannels: [] }),
  );
  await expect(
    new SupplySmartProductsClient({ call } as never).facts(id, new AbortController().signal),
  ).rejects.toThrow();
});

it("deletes through product.delete", async () => {
  const call = vi.fn(async () => ({ message: "Product deleted" }));
  await new SupplySmartProductsClient({ call } as never).delete(id, new AbortController().signal);
  expect(call).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ api: "database", path: "product.delete", input: { id } }),
    expect.any(AbortSignal),
  );
});
