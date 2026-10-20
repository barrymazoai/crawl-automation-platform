import { expect, it, vi } from "vitest";
import { BrandRequestsApi } from "./brand-requests-api.js";

const ok = (data: unknown) =>
  new Response(JSON.stringify({ result: { data } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

it("claims through the operators' claimPending and flattens each outcome", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    ok([
      { requestId: "r1", run: { runId: "run-1", state: "running" } },
      { requestId: "r2", skipped: "retail_site", site: "gnc.com" },
      { requestId: "r3", error: "boom" },
    ]),
  );
  const api = new BrandRequestsApi("http://127.0.0.1:4188/trpc/", fetch);

  await expect(api.claimPending(1, new AbortController().signal)).resolves.toEqual([
    { requestId: "r1", runId: "run-1" },
    { requestId: "r2", skipped: "retail_site", site: "gnc.com" },
    { requestId: "r3", error: "boom" },
  ]);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("http://127.0.0.1:4188/trpc/brandEnrichment.claimPending");
  expect(init?.body).toBe(JSON.stringify({ limit: 1 }));
});

it("cancels a run through the operators' cancel and reports a refused call", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(ok({ runId: "run-1", cancellationRequested: true }))
    .mockResolvedValueOnce(new Response("{}", { status: 400 }));
  const api = new BrandRequestsApi("http://api.test", fetch);
  const signal = new AbortController().signal;

  await api.cancel("run-1", signal);
  expect(fetch.mock.calls[0]?.[0]).toBe("http://api.test/brandEnrichment.cancel");
  await expect(api.cancel("run-2", signal)).rejects.toMatchObject({
    code: "PRODUCT_SYNC.BRANDS_API_FAILED",
  });
});
