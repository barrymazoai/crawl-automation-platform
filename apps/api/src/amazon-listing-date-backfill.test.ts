import { expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresProductSync, RetainedListingDateOriginals } from "@crawl-automation/adapters";
import { ProductSyncControl, type ListingDateSelection } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { channels, fixture, fixtureHtml, reader, run } from "./amazon-listing-date.fixture.js";

it.each([
  { dryRun: true, reason: "missing" },
  { dryRun: false, reason: "missing" },
  { dryRun: true, reason: "identity_mismatch" },
  { dryRun: false, reason: "identity_mismatch" },
])(
  "backfill $dryRun counts unavailable selected originals ($reason) without fetching",
  async ({ dryRun, reason }) => {
    const good = fixture("B0013LAQS6");
    const bad = fixture("B0G963NB8Q");
    if (reason === "identity_mismatch") {
      bad.bytes = good.bytes;
      bad.history.raw["evidence"] = [good.archive];
    }
    const first = reader(good);
    const second = reader(bad);
    if (reason === "missing") {
      second.read.mockResolvedValue(null);
    }
    const selected: ListingDateSelection[] = [good, bad].map((sample) => ({
      listingId: sample.parsed.identity.listingId,
      variantId: null,
      runId: run.runId,
      sourceId: run.sourceId,
      url: sample.page.url,
    }));
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("AS eligible")) {
        return [{ reopened: dryRun ? 0 : 2, eligible: 20, selected }];
      }
      const saved = values?.[3] === good.page.url ? first : second;
      return saved.database.query(sql, values);
    });

    const database = { query } as Queryable;
    // The same object key can legitimately be referenced by both captures in the identity-mismatch case.
    // Use the capture URL to choose history; its hash-verified bytes remain the real saved original.
    const read = vi.fn(async (key: string) => {
      if (key === good.archive.objectKey) {
        return good.bytes;
      }
      return second.read(key);
    });
    const log = { warn: vi.fn() };
    const control = new ProductSyncControl({
      ledger: new PostgresProductSync(database),
      listingDateOriginals: new RetainedListingDateOriginals({
        database,
        objects: { read },
        channels,
        log,
      }),
    });
    const result = await control.reopen({
      channel: "amazon",
      listingDates: true,
      before: "2026-10-22T00:00:00Z",
      limit: 2,
      dryRun,
    });
    expect(result).toMatchObject({
      reopened: dryRun ? 0 : 2,
      eligible: 20,
      selected,
      originals: { checked: 2, noReadableOriginal: 1, warnings: [{ ...selected[1], reason }] },
    });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: run.runId, reason }),
      expect.any(String),
    );
    if (dryRun) {
      expect(query.mock.calls.every(([sql]) => !/\b(?:UPDATE|INSERT|DELETE)\b/u.test(sql))).toBe(
        true,
      );
    }
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("FROM product_history_source")),
    ).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
  },
);

const external = process.env["V3_AMAZON_DFA_DATA_DIR"];
const noDatePage = external ? join(external, "pages/B0GR1L7J9J.html") : "";
it.skipIf(!noDatePage || !existsSync(noDatePage))(
  "readable originals with no DFA are not counted as unavailable",
  async () => {
    const sample = fixtureHtml("B0GR1L7J9J", readFileSync(noDatePage));
    const prior = reader(sample);
    const inspector = new RetainedListingDateOriginals({
      database: prior.database,
      objects: { read: prior.read },
      channels,
      log: prior.log,
    });
    const result = await inspector.inspect(
      [
        {
          listingId: "B0GR1L7J9J",
          variantId: null,
          runId: run.runId,
          sourceId: run.sourceId,
          url: sample.page.url,
        },
      ],
      new AbortController().signal,
    );
    expect(result).toEqual({ checked: 1, noReadableOriginal: 0, warnings: [] });
    expect(prior.log.warn).not.toHaveBeenCalled();
  },
);
