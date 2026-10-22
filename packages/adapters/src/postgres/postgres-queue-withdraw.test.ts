import type { Database, Queryable } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

const batchId = "44444444-4444-4444-8444-444444444444";
const queued = {
  itemId: "a".repeat(64),
  batchId,
  label: "Brand A",
  state: "queued",
  runId: null,
  openAttempt: false,
};
const running = {
  ...queued,
  itemId: "b".repeat(64),
  state: "running",
  runId: batchId,
  openAttempt: true,
};
const pending = {
  ...queued,
  itemId: "c".repeat(64),
  state: "pending",
  runId: batchId,
  openAttempt: false,
};

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const transaction = vi.fn(async (work: (tx: Queryable) => Promise<unknown>) => work({ query }));
  const store = new PostgresChannelQueueStore({ query, transaction } as unknown as Database);
  return { query, transaction, store };
}

it("previews exact channel rows under the same lock without mutating them", async () => {
  const { query, store, transaction } = fixture();
  query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([queued, running, pending])
    .mockResolvedValueOnce([{ count: 1 }]);
  expect(await store.withdraw({ channel: "dtc", batchIds: [batchId], dryRun: true })).toEqual({
    dryRun: true,
    matched: 3,
    withdrawn: 1,
    skipped: { running: 1, settled: 1, notFound: 0 },
    byBatch: [{ batchId, label: "Brand A", count: 1 }],
  });
  expect(transaction).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
  expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE OF q");
  expect(query.mock.calls.map(([sql]) => sql).join(" ")).not.toContain("UPDATE queue_item");
});

it("withdraws eligible IDs once with the reason code and protects claimed attempts", async () => {
  const { query, store } = fixture();
  query
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([queued, running])
    .mockResolvedValueOnce([{ item_id: queued.itemId }]);
  expect(
    await store.withdraw({
      channel: "dtc",
      itemIds: [queued.itemId, running.itemId],
      dryRun: false,
      reason: "duplicate",
    }),
  ).toMatchObject({ withdrawn: 1, skipped: { running: 1, settled: 0, notFound: 0 } });
  const [sql, values] = query.mock.calls[2] ?? [];
  expect(sql).toContain("state = 'withdrawn', reason = 'QUEUE.WITHDRAWN'");
  expect(sql).toContain("a.outcome = 'running'");
  expect(values).toEqual(["dtc", [queued.itemId], "duplicate"]);
  expect(query).toHaveBeenCalledTimes(3);
});
