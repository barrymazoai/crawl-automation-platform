import { expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresProductSync } from "./postgres-product-sync.js";

const input = {
  channel: "amazon" as const,
  listingDates: true as const,
  before: "2026-10-22T00:00:00Z",
  limit: 1,
  listingIds: ["B0013LAQS6"],
};

it("preview is SELECT-only and shares the settled-product and matched-brand scope", async () => {
  const answer = {
    reopened: 0,
    eligible: 1,
    selected: [{ listingId: "B0013LAQS6", variantId: null }],
  };
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => [answer]);
  const ledger = new PostgresProductSync({ query } as unknown as Queryable);
  expect(await ledger.reopen({ ...input, dryRun: true })).toEqual(answer);
  const [sql, values] = query.mock.calls[0] as [string, unknown[]];
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
  expect(sql).toContain("q.channel = 'amazon'");
  expect(sql).toContain("ps.status IN ('verified','present')");
  expect(sql).toContain("m.status='matched'");
  expect(values).toEqual([input.before, input.listingIds, input.limit]);
});

it("execution changes only selected sync watermarks with a cutoff guard; never history or the crawl queue", async () => {
  const result = {
    reopened: 1,
    eligible: 2,
    selected: [
      {
        listingId: "B0013LAQS6",
        variantId: null,
        runId: "original-run",
        sourceId: "original-source",
        url: "https://www.amazon.com/dp/B0013LAQS6",
      },
    ],
  };
  const query = vi.fn(async (_sql: string) => [result]);
  const ledger = new PostgresProductSync({ query } as unknown as Queryable);
  expect(await ledger.reopen({ ...input, dryRun: false })).toEqual(result);
  const [sql] = query.mock.calls[0] as [string];
  expect(sql.match(/UPDATE\s+\w+/gu)).toEqual(["UPDATE product_sync"]);
  expect(sql).toContain("ps.updated_at < $1::timestamptz");
  expect(sql).toContain("ps.material_at IS DISTINCT FROM '-infinity'::timestamptz");
  expect(sql).not.toContain("product_history");
  expect(sql).toContain("RETURNING picked.*");
  expect(sql).toContain("FROM moved");
  expect(sql).toContain("d.material_source_id::text AS source_id");
  expect(sql).toContain("d.material_url AS url");
});
