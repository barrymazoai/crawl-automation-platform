import type { Database } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

it("resolves formula ownership without requiring a root or brand URL", async () => {
  const query = vi.fn().mockResolvedValue([{ id: "source-1" }]);
  const database = { query } as unknown as Database;
  expect(await new PostgresChannelQueueStore(database).amazonSourceOf("brand-1")).toBe("source-1");
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY enabled DESC, created_at, id"),
    ["brand-1", "amazon"],
  );
  expect(query.mock.calls[0]?.[0]).not.toContain("https://");
  query.mockResolvedValue([]);
  expect(await new PostgresChannelQueueStore(database).amazonSourceOf("brand-2")).toBeNull();
  // KAN-243: the same lookup on another storefront, for the cross-market check's recapture.
  await new PostgresChannelQueueStore(database).brandSourceOf("amazon", "brand-3");
  expect(query).toHaveBeenLastCalledWith(expect.any(String), ["brand-3", "amazon"]);
});
