import type { Database } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { PostgresDeliveryScan } from "./delivery-scan.js";

it("scans collections without legacy attempt joins and excludes retained link authorizations", async () => {
  const cursor = {
    createdAt: "2026-09-30T00:00:00.123456Z",
    requestId: "11111111-1111-4111-8111-111111111111",
  };
  const query = vi.fn().mockResolvedValue([cursor]);
  const scan = new PostgresDeliveryScan({ query } as unknown as Database);
  expect(await scan.upperBound()).toEqual(cursor);
  expect(await scan.page(null, cursor, 20)).toEqual([cursor]);
  expect(query.mock.calls[1]?.[1]).toEqual([cursor.createdAt, cursor.requestId, null, null, 20]);
  for (const [sql] of query.mock.calls) {
    expect(sql).toContain("FROM collection_submission");
    expect(sql).toContain("JOIN source_submission_guard");
    expect(sql).toContain("d.closed_at IS NULL");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM amazon_link_batch");
    expect(sql).not.toContain("amazon_queue_");
  }
});
