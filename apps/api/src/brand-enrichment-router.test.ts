import { expect, it, vi } from "vitest";
import { appWith, post, query } from "./testing/app-with.js";
const requestId = "11111111-1111-4111-8111-111111111111";
it("starts brand enrichment through the unauthenticated facade", async () => {
  const start = vi.fn(async () => ({ runId: requestId }));
  const response = await appWith({ brandEnrichment: { start } }).request(
    "/trpc/brandEnrichment.start",
    post({ requestId }),
  );
  expect(response.status).toBe(200);
  expect(start).toHaveBeenCalledWith({ requestId });
});
it("an absent optional config returns the registered NOT_CONFIGURED error", async () => {
  const response = await appWith({}).request(`/trpc/brandEnrichment.list${query({})}`);
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("BRAND_ENRICHMENT.NOT_CONFIGURED");
});
it("rejects an unbounded claim request before calling the service", async () => {
  const claimPending = vi.fn();
  const response = await appWith({ brandEnrichment: { claimPending } }).request(
    "/trpc/brandEnrichment.claimPending",
    post({ limit: 1000 }),
  );
  expect(response.status).toBe(400);
  expect(claimPending).not.toHaveBeenCalled();
});
