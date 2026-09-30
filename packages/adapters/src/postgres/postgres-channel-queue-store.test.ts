import type { Database } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";

it("resolves formula ownership without requiring a root or brand URL", async () => {
  const query = vi.fn().mockResolvedValue([{ id: "source-1" }]);
  const database = { query } as unknown as Database;
  expect(await new PostgresChannelQueueStore(database).amazonSourceOf("brand-1")).toBe("source-1");
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY enabled DESC, created_at, id"),
    ["brand-1"],
  );
  expect(query.mock.calls[0]?.[0]).not.toContain("https://");
  query.mockResolvedValue([]);
  expect(await new PostgresChannelQueueStore(database).amazonSourceOf("brand-2")).toBeNull();
});
