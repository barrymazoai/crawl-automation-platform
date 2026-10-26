import { expect, it, vi } from "vitest";
import type { z } from "zod";
import type { SupplySmartCall } from "./supply-smart-rpc.js";
import { SupplySmartHealthFunctionsClient } from "./supply-smart-health-functions.js";

const productId = "c980a97c-9cae-4985-bb5b-a18c50df94f1";
const healthFunctionId = "0b7f3c51-8d55-4a4f-a5c8-3e5c4d1f2a90";

it("lists a product's linked health functions and unlinks one, never deleting the health function", async () => {
  const call = vi.fn(async (request: SupplySmartCall<z.ZodType>) =>
    request.answer.parse(
      request.path === "product.getProductHealthFunctions"
        ? [{ id: healthFunctionId, name: "supports healthy joints", description: null }]
        : { message: "HealthFunction removed from product successfully" },
    ),
  );
  const client = new SupplySmartHealthFunctionsClient({ call } as never);
  const signal = new AbortController().signal;
  expect(await client.list(productId, signal)).toEqual([
    { id: healthFunctionId, name: "supports healthy joints" },
  ]);
  await client.unlink(productId, healthFunctionId, signal);
  expect(call.mock.calls.map(([request]) => [request.path, request.input])).toEqual([
    ["product.getProductHealthFunctions", { productId }],
    ["product.removeProductHealthFunction", { productId, healthFunctionId }],
  ]);
});
