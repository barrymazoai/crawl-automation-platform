import type { Queryable } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresQueueStore } from "./postgres-queue-store.js";

it("reads migration counts in one query without locking or changing legacy history", async () => {
  const counts = { pending: 3, alreadyCopied: 2 };
  const query = vi.fn().mockResolvedValue([counts]);
  const store = new PostgresQueueStore({ query } as Queryable);
  expect(await store.migrationPreview()).toEqual(counts);
  expect(query).toHaveBeenCalledOnce();
  const sql = query.mock.calls[0]?.[0];
  expect(sql).toMatch(/^SELECT/);
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK)\b/);
  expect(sql).toContain("i.attempt = 0 AND i.request_id IS NULL");
  expect(sql).toContain("NOT EXISTS (SELECT 1 FROM amazon_queue_attempt");
  expect(store).not.toHaveProperty("add");
  expect(store).not.toHaveProperty("resume");
  expect(store).not.toHaveProperty("requeue");
});
