import { ListSourcesSchema } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { PostgresBrandStore } from "./postgres-brand-store.js";

const sourceId = "22222222-2222-4222-8222-222222222222";
const brandId = "33333333-3333-4333-8333-333333333333";
const scanId = "44444444-4444-4444-8444-444444444444";
const instant = "2026-10-01T00:00:00.000Z";
const row = {
  id: sourceId,
  brandId,
  brandName: "Brand",
  channel: "amazon",
  region: "US",
  url: "https://www.amazon.com/s?brand=test",
  enabled: false,
  revision: 7,
  createdAt: new Date(instant),
  updatedAt: new Date(instant),
  scanId,
  requestId: scanId,
  scanState: "queued",
  requestedAt: new Date(instant),
  startedAt: null,
  finishedAt: null,
  queueProductCount: 4,
};

describe("source listing repository", () => {
  it("binds channel, enabled and scanned, returns revisions and latest scan facts, and pages before counts", async () => {
    const query = vi.fn().mockResolvedValue([row, row]);
    const store = new PostgresBrandStore({ query } as unknown as Database);
    const result = await store.sources(
      ListSourcesSchema.parse({
        channel: "amazon",
        enabled: false,
        scanned: true,
        limit: 1,
        offset: 2,
      }),
    );
    expect(result).toEqual({
      items: [
        {
          id: sourceId,
          brandId,
          brandName: "Brand",
          channel: "amazon",
          region: "US",
          url: row.url,
          enabled: false,
          revision: 7,
          createdAt: instant,
          updatedAt: instant,
          lastScan: {
            scanId,
            requestId: scanId,
            state: "queued",
            requestedAt: instant,
            startedAt: null,
            finishedAt: null,
          },
          queueProductCount: 4,
        },
      ],
      limit: 1,
      offset: 2,
      hasMore: true,
    });
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(values).toEqual([null, "amazon", false, true, "", 2, 2]);
    expect(sql).toContain("EXISTS (");
    expect(sql).toContain("scan.source_id = s.id) = $4");
    expect(sql).toContain("ORDER BY requested_at DESC, scan_id DESC LIMIT 1");
    expect(sql).toContain("ORDER BY s.created_at, s.id LIMIT $6 OFFSET $7");
    expect(sql).toContain("WHERE i.source_id = s.id");
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/);
  });

  it("supports old brand queries, never-scanned sources and ISO strings from adapters", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ...row,
        createdAt: instant,
        updatedAt: instant,
        scanId: null,
        requestId: null,
        scanState: null,
        requestedAt: null,
        queueProductCount: 0,
      },
    ]);
    const store = new PostgresBrandStore({ query } as unknown as Database);
    const result = await store.sources(
      ListSourcesSchema.parse({ brandId, scanned: false, q: "test" }),
    );
    expect(result.items[0]).toMatchObject({ id: sourceId, lastScan: null, queueProductCount: 0 });
    expect(result.hasMore).toBe(false);
    expect(query.mock.calls[0]?.[1]).toEqual([brandId, null, null, false, "test", 26, 0]);
  });

  it("returns an empty page with the requested offset", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const store = new PostgresBrandStore({ query } as unknown as Database);
    expect(await store.sources(ListSourcesSchema.parse({ channel: "gnc", offset: 40 }))).toEqual({
      items: [],
      limit: 25,
      offset: 40,
      hasMore: false,
    });
  });
});
