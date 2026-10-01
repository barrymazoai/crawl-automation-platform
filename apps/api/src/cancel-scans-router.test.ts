import { expect, it, vi } from "vitest";
import { appWith, post } from "./testing/app-with.js";

const scanId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

it.each([
  { scanIds: [scanId] },
  { requestId },
  { channel: "wholefoods" },
  { scanIds: [scanId], requestId, channel: "wholefoods" },
])("accepts scoped cancellation without authentication: %j", async (input) => {
  const counts = { cancelled: 2, cancellationRequested: 1 };
  const cancel = vi.fn(async () => counts);
  const app = appWith({ brandScans: { cancel } });
  const response = await app.request("/trpc/brands.cancelScans", post(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { data: counts } });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(input);
});

it.each([
  {},
  { scanIds: [] },
  { scanIds: ["invalid"] },
  { requestId: "invalid" },
  { channel: "unknown" },
  { channel: "wholefoods", all: true },
  { scanIds: Array<string>(1001).fill(scanId) },
])("rejects invalid or unscoped cancellation %# before the service", async (input) => {
  const cancel = vi.fn();
  const app = appWith({ brandScans: { cancel } });
  const response = await app.request("/trpc/brands.cancelScans", post(input));
  expect(response.status).toBe(400);
  expect(cancel).not.toHaveBeenCalled();
});
