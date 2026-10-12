import { expect, it, vi } from "vitest";
import { z } from "zod";
import { SupplySmartRpc, supplySmartStatus } from "./supply-smart-rpc.js";

const settings = {
  bizRpcUrl: "https://supply-smart.test/api/rpc",
  databaseRpcUrl: "https://supply-smart.test/api/database/rpc",
  apiKey: "test-key",
  timeoutMs: 5_000,
  requestsPerMinute: 600,
  rateLimitRetries: 3,
  rateLimitBackoffMs: 1,
};
const call = {
  api: "database" as const,
  path: "company.resolve" as const,
  input: { name: "Solgar" },
  answer: z.object({ status: z.string() }),
};
// The gateway's own 429 body (product-database-gateway.ts), not an oRPC error envelope.
const rateLimited = () => new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 });
const answer = () =>
  new Response(JSON.stringify({ json: { status: "matched" }, meta: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

it("waits and retries a 429, then returns the answer", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(rateLimited())
    .mockResolvedValueOnce(rateLimited())
    .mockResolvedValueOnce(answer());
  const rpc = new SupplySmartRpc(settings, fetch);
  await expect(rpc.call(call, new AbortController().signal)).resolves.toEqual({
    status: "matched",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("never repeats other failures and keeps their status for callers (409 link conflict)", async () => {
  const conflict = new Response(
    JSON.stringify({
      json: { defined: false, code: "CONFLICT", status: 409, message: "owner exists", data: {} },
    }),
    { status: 409 },
  );
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(conflict);
  const rpc = new SupplySmartRpc(settings, fetch);
  const error = await rpc
    .call(call, new AbortController().signal)
    .catch((caught: unknown) => caught);
  expect(supplySmartStatus(error)).toBe(409);
  expect(fetch).toHaveBeenCalledOnce();
});

it("gives up after the configured retries and reports the 429", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => rateLimited());
  const rpc = new SupplySmartRpc(settings, fetch);
  const error = await rpc
    .call(call, new AbortController().signal)
    .catch((caught: unknown) => caught);
  expect(supplySmartStatus(error)).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(4);
});
