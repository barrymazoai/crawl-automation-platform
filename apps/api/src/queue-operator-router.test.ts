import { describe, expect, it, vi } from "vitest";
import { appWith, post, query } from "./testing/app-with.js";

const sourceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const filter = { state: "review", reasons: ["QUEUE.RUN_FAILED"], sourceIds: [sourceId] };

describe("queue operator API without authentication", () => {
  it("returns filtered Review items and their source, attempt and update time", async () => {
    const item = {
      itemId: "a".repeat(64),
      listingId: "B001",
      sourceId,
      state: "review",
      reason: "QUEUE.RUN_FAILED",
      attempt: 1,
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const items = vi.fn(async () => [item]);
    const input = {
      channel: "amazon",
      ...filter,
      listingIds: ["B001"],
      limit: 3,
      updatedSince: "2026-10-01T08:00:00+08:00",
      createdSince: "2026-09-30T00:00:00Z",
    };
    const response = await appWith({ queue: { items } }).request(
      `/trpc/queue.items${query(input)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: [item] } });
    expect(items).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("previews a bounded filter by default and requires explicit false to execute", async () => {
    const preview = { dryRun: true, count: 5, sample: [] };
    const requeue = vi.fn().mockResolvedValueOnce(preview).mockResolvedValueOnce({ requeued: 5 });
    const app = appWith({ queue: { requeue } });
    const input = { channel: "amazon", filter, limit: 10_000 };
    const response = await app.request("/trpc/queue.requeue", post(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: preview } });
    expect(requeue).toHaveBeenCalledExactlyOnceWith({ ...input, dryRun: true });
    const execute = await app.request("/trpc/queue.requeue", post({ ...input, dryRun: false }));
    expect(execute.status).toBe(200);
    expect(await execute.json()).toEqual({ result: { data: { requeued: 5 } } });
    expect(requeue).toHaveBeenLastCalledWith({ ...input, dryRun: false });
  });

  it("preserves explicit item IDs and exposes per-request summaries as a query", async () => {
    const requeue = vi.fn(async () => ({ requeued: 1 }));
    const summary = vi.fn(async () => []);
    const app = appWith({ queue: { requeue, summary } });
    const ids = { channel: "gnc", itemIds: ["a".repeat(64)] };
    expect((await app.request("/trpc/queue.requeue", post(ids))).status).toBe(200);
    expect(requeue).toHaveBeenCalledExactlyOnceWith(ids);
    const input = {
      channel: "amazon",
      sourceIds: [sourceId],
      requestId,
      createdSince: "2026-10-01T00:00:00Z",
    };
    expect((await app.request(`/trpc/queue.summary${query(input)}`)).status).toBe(200);
    expect(summary).toHaveBeenCalledExactlyOnceWith(input);
    expect((await app.request("/trpc/queue.summary", post(input))).status).toBe(405);
  });

  it.each([
    { filter: { state: "running" }, limit: 1 },
    { filter: { state: "queued" }, limit: 1 },
    { filter: { state: "completed" }, limit: 1 },
    { filter: {}, limit: 1 },
    { filter, limit: 0 },
    { filter, limit: 10_001 },
    { filter, limit: 1.5 },
    { filter },
    { filter, limit: 1, dryRun: "false" },
    { filter, limit: 1, itemIds: ["a".repeat(64)] },
    { filter: { ...filter, sourceIds: [] }, limit: 1 },
    { filter: { ...filter, updatedSince: "yesterday" }, limit: 1 },
    { itemIds: [] },
  ])("rejects unsafe requeue input before calling the service: %j", async (input) => {
    const requeue = vi.fn();
    const response = await appWith({ queue: { requeue } }).request(
      "/trpc/queue.requeue",
      post(input),
    );
    expect(response.status).toBe(400);
    expect(requeue).not.toHaveBeenCalled();
  });

  it.each([
    ["items", { reasons: [] }],
    ["items", { sourceIds: ["invalid"] }],
    ["items", { listingIds: [] }],
    ["items", { reasons: [""] }],
    ["items", { updatedSince: "2026-10-01" }],
    ["items", { createdSince: "2026-02-30T00:00:00Z" }],
    ["items", { limit: 10_001 }],
    ["items", { channel: "unknown" }],
    ["summary", { requestId: "invalid" }],
    ["summary", { sourceIds: [] }],
    ["summary", { createdSince: "2026-10-01T00:00:00" }],
  ])("validates %s filters: %j", async (method, input) => {
    const call = vi.fn();
    const response = await appWith({ queue: { [method]: call } }).request(
      `/trpc/queue.${method}${query(input)}`,
    );
    expect(response.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });
});
