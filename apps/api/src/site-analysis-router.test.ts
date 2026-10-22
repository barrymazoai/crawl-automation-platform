import { expect, it, vi } from "vitest";
import { appWith, post, query } from "./testing/app-with.js";
const requestId = "11111111-1111-4111-8111-111111111111";
it("starts site analysis through an unauthenticated mutation", async () => {
  const analyze = vi.fn(async () => ({ analysisId: requestId }));
  const response = await appWith({ siteAnalyses: { analyze } }).request(
    "/trpc/brands.analyzeSite",
    post({ requestId, url: "https://shop.example/" }),
  );
  expect(response.status).toBe(200);
  expect(analyze).toHaveBeenCalledWith({ requestId, url: "https://shop.example/" });
});
it("reads persisted analysis state and results", async () => {
  const get = vi.fn(async () => ({ analysisId: requestId, state: "completed" }));
  const response = await appWith({ siteAnalyses: { get } }).request(
    `/trpc/brands.siteAnalysis${query({ analysisId: requestId })}`,
  );
  expect(response.status).toBe(200);
  expect(get).toHaveBeenCalledWith(requestId);
});
it.each([undefined, ["Alpha"]])("applies all or selected brands: %j", async (brands) => {
  const apply = vi.fn(async () => ({ created: [], matched: [], skipped: [] }));
  const input = { requestId, analysisId: requestId, ...(brands ? { brands } : {}) };
  const response = await appWith({ siteAnalyses: { apply } }).request(
    "/trpc/brands.applySiteAnalysis",
    post(input),
  );
  expect(response.status).toBe(200);
  expect(apply).toHaveBeenCalledWith(input);
});
it("passes a settings correction to the service and rejects correction with enqueue", async () => {
  const apply = vi.fn(async () => ({ created: [], matched: [], skipped: [] }));
  const app = appWith({ siteAnalyses: { apply } });
  const input = { requestId, analysisId: requestId, replaceSettings: true };
  expect((await app.request("/trpc/brands.applySiteAnalysis", post(input))).status).toBe(200);
  expect(apply).toHaveBeenCalledExactlyOnceWith(input);
  expect(
    (
      await app.request(
        "/trpc/brands.applySiteAnalysis",
        post({
          ...input,
          enqueue: true,
        }),
      )
    ).status,
  ).toBe(400);
  expect(apply).toHaveBeenCalledOnce();
});
it.each([
  "http://shop.example/",
  "https://user:pass@shop.example/",
  "https://localhost/",
  "https://127.0.0.1/",
])("rejects invalid site address %s", async (url) => {
  const analyze = vi.fn();
  const response = await appWith({ siteAnalyses: { analyze } }).request(
    "/trpc/brands.analyzeSite",
    post({ requestId, url }),
  );
  expect(response.status).toBe(400);
  expect(analyze).not.toHaveBeenCalled();
});
