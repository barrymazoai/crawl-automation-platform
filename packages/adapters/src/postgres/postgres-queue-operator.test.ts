import type { Database, Queryable } from "@crawl-automation/platform";
import { RequeueSchema } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

const sourceId = "22222222-2222-4222-8222-222222222222";
const brandId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const instant = "2026-10-01T00:00:00.000Z";
const item = {
  itemId: "a".repeat(64),
  batch: requestId,
  state: "review",
  attempt: 2,
  runId: requestId,
  listingId: "B001",
  sourceId,
  updatedAt: new Date(instant),
  lastError: null,
  reason: "QUEUE.RUN_FAILED",
  followsItemId: null,
};

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const transaction = vi.fn(async (work: (tx: Queryable) => Promise<unknown>) => work({ query }));
  const database = { query, transaction } as unknown as Database;
  return { store: new PostgresChannelQueueStore(database), query, transaction };
}

describe("shared queue operator repository", () => {
  it("binds all filters and reads the identifiers needed for requeue with deterministic ordering", async () => {
    const { store, query } = fixture();
    query.mockResolvedValueOnce([item]);
    const filters = {
      channel: "amazon" as const,
      state: "review" as const,
      limit: 17,
      reasons: ["QUEUE.RUN_FAILED", "' OR true --"],
      updatedSince: instant,
      createdSince: instant,
      sourceIds: [sourceId],
      listingIds: ["B001"],
    };
    expect(await store.items(filters)).toEqual([{ ...item, updatedAt: instant }]);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(values).toEqual([
      "amazon",
      "review",
      17,
      filters.reasons,
      instant,
      instant,
      [sourceId],
      ["B001"],
    ]);
    expect(sql).toContain("reason = ANY($4)");
    expect(sql).toContain("updated_at >= $5");
    expect(sql).toContain("created_at >= $6");
    expect(sql).toContain("source_id = ANY($7)");
    expect(sql).toContain("listing_id = ANY($8)");
    expect(sql).toContain("ORDER BY updated_at DESC, item_id LIMIT $3");
    expect(sql).not.toContain(filters.reasons[1]);
    expect(sql).not.toMatch(/FOR UPDATE|INSERT|DELETE/);
  });

  it("leaves omitted filters unrestrictive, without substituting empty arrays", async () => {
    const { store, query } = fixture();
    expect(await store.items({ channel: "gnc", state: "running", limit: 5 })).toEqual([]);
    expect(query.mock.calls[0]?.[1]).toEqual(["gnc", "running", 5, null, null, null, null, null]);
  });

  it("previews the bounded selection, samples at most 20 and never writes", async () => {
    const { store, query, transaction } = fixture();
    const rows = Array.from({ length: 25 }, (_, index) => ({ ...item, itemId: String(index) }));
    query.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const input = RequeueSchema.parse({
      channel: "amazon",
      filter: { state: "review" },
      limit: 25,
    });
    const preview = await store.requeue(input);
    expect(preview).toMatchObject({ dryRun: true, count: 25 });
    expect("sample" in preview && preview.sample).toHaveLength(20);
    expect(transaction).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT $3 FOR UPDATE");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "amazon",
      "review",
      25,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(query.mock.calls.map(([sql]) => sql).join(" ")).not.toMatch(
      /\b(INSERT|DELETE|UPDATE queue)/,
    );
  });

  it("passes only the locked selection through the existing ID requeue path", async () => {
    const { store, query, transaction } = fixture();
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([{ state: "review" }])
      .mockResolvedValueOnce([]);
    const input = RequeueSchema.parse({
      filter: { state: "review", reasons: [item.reason], sourceIds: [sourceId] },
      limit: 1,
      dryRun: false,
    });
    expect(await store.requeue(input)).toEqual({ requeued: 1 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(query.mock.calls[2]?.[0]).toMatch(/SELECT state.*FOR UPDATE/);
    expect(query.mock.calls[2]?.[1]).toEqual(["amazon", [item.itemId]]);
    expect(query.mock.calls[3]?.[0]).toContain("state = 'queued', run_id = NULL, reason = NULL");
    expect(query.mock.calls[3]?.[1]).toEqual(["amazon", [item.itemId]]);
    expect(query.mock.calls.map(([sql]) => sql).join(" ")).not.toMatch(
      /queue_attempt|review_record/,
    );
  });

  it.each(["queued", "ready", "running", "following"])(
    "refuses explicit %s items without updating anything",
    async (state) => {
      const { store, query } = fixture();
      query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ state }]);
      await expect(
        store.requeue({ channel: "amazon", itemIds: [item.itemId] }),
      ).rejects.toMatchObject({ code: "QUEUE.REQUEUE_NOT_SETTLED" });
      expect(query).toHaveBeenCalledTimes(2);
    },
  );

  it("refuses missing IDs and makes an empty filter selection a no-op", async () => {
    const { store, query } = fixture();
    await expect(
      store.requeue({ channel: "amazon", itemIds: [item.itemId] }),
    ).rejects.toMatchObject({ code: "QUEUE.REQUEUE_NOT_SETTLED" });
    query.mockClear();
    expect(
      await store.requeue(
        RequeueSchema.parse({ filter: { state: "review" }, limit: 1, dryRun: false }),
      ),
    ).toEqual({ requeued: 0 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the shared mutation fails", async () => {
    const { store, query, transaction } = fixture();
    const error = new Error("database unavailable");
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([{ state: "review" }])
      .mockRejectedValueOnce(error);
    await expect(
      store.requeue(RequeueSchema.parse({ filter: { state: "review" }, limit: 1, dryRun: false })),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("summarizes all states and Review reasons per source, retaining zero-product sources", async () => {
    const { store, query } = fixture();
    const source = { sourceId, brandId, brandName: "Brand" };
    const empty = { ...source, sourceId: requestId };
    query.mockResolvedValueOnce([
      { ...source, state: "completed", reason: null, count: 2 },
      { ...source, state: "review", reason: "LABEL.MISSING", count: 3 },
      { ...source, state: "review", reason: null, count: 1 },
      { ...source, state: "running", reason: null, count: 1 },
      { ...empty, state: null, reason: null, count: 0 },
    ]);
    expect(
      await store.summary({
        channel: "amazon",
        sourceIds: [sourceId, requestId],
        createdSince: instant,
        requestId,
      }),
    ).toEqual([
      {
        ...source,
        total: 7,
        counts: { completed: 2, review: 4, running: 1 },
        reviewReasons: [
          { reason: "LABEL.MISSING", count: 3 },
          { reason: null, count: 1 },
        ],
      },
      { ...empty, total: 0, counts: {}, reviewReasons: [] },
    ]);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(values).toEqual(["amazon", [sourceId, requestId], instant, requestId]);
    expect(sql).toContain("LEFT JOIN queue_item");
    expect(sql).toContain("scan.scan_id = i.batch_id");
    expect(sql).toContain("scan.request_id = $4");
    expect(sql).toContain("count(i.item_id)::int");
    expect(sql).not.toMatch(/queue_attempt|revisit_batch_id|UPDATE|DELETE/);
  });
});
