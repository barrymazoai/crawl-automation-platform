import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ListSourcesSchema, RequeueSchema } from "@crawl-automation/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBrandStore } from "../src/postgres/postgres-brand-store.js";
import { QueueOperatorFixture, operatorTime } from "./queue-operator-fixture.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPostgres || process.env.V3_TEST_SKIP_POSTGRES === "1")(
  "queue operator queries against PostgreSQL",
  () => {
    let postgres: TemporaryPostgres;
    let fixture: QueueOperatorFixture;
    let brands: PostgresBrandStore;

    beforeAll(async () => {
      postgres = await startTemporaryPostgres();
      fixture = new QueueOperatorFixture(postgres.database);
      brands = new PostgresBrandStore(postgres.database);
      await fixture.seed();
    }, 120_000);

    afterAll(async () => {
      await postgres?.stop();
    });

    it("combines reason, source, listing and inclusive time filters; ties order by item ID", async () => {
      const input = {
        channel: "gnc" as const,
        state: "review" as const,
        limit: 10,
        reasons: ["QUEUE.RUN_FAILED"],
        sourceIds: [fixture.sourceId],
        createdSince: operatorTime,
        updatedSince: "2026-10-01T08:00:00+08:00",
      };
      const items = await fixture.queue.items(input);
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.itemId)).toEqual(items.map((item) => item.itemId).sort());
      expect(items[0]).toMatchObject({
        sourceId: fixture.sourceId,
        state: "review",
        attempt: 1,
        reason: "QUEUE.RUN_FAILED",
        updatedAt: operatorTime,
      });
      expect(await fixture.queue.items({ ...input, listingIds: ["retry-1"] })).toEqual([
        expect.objectContaining({ listingId: "retry-1" }),
      ]);
      expect(await fixture.queue.items({ ...input, createdSince: "2026-10-01T00:00:01Z" })).toEqual(
        [],
      );
      expect(await fixture.queue.items({ ...input, updatedSince: "2026-10-01T00:00:01Z" })).toEqual(
        [],
      );
      expect(await fixture.queue.items({ ...input, sourceIds: [fixture.emptySource] })).toEqual([]);
      expect(await fixture.queue.items({ ...input, channel: "swanson" })).toEqual([]);
      expect(await fixture.queue.items({ ...input, limit: 1 })).toEqual([items[0]]);
    });

    it("reports exact scan discovery batches, excluding other requests and missing-listing revisits", async () => {
      const summary = await fixture.queue.summary({ channel: "gnc", requestId: fixture.requestId });
      expect(summary).toHaveLength(2);
      expect(summary.find((row) => row.sourceId === fixture.sourceId)).toMatchObject({
        brandId: fixture.brandId,
        brandName: "Operator test brand",
        total: 6,
        counts: { completed: 1, review: 3, running: 1, queued: 1 },
        reviewReasons: [
          { reason: "QUEUE.RUN_FAILED", count: 2 },
          { reason: "CAPTURE.NOT_FOUND", count: 1 },
        ],
      });
      expect(summary.find((row) => row.sourceId === fixture.emptySource)).toMatchObject({
        total: 0,
        counts: {},
        reviewReasons: [],
      });
      const all = await fixture.queue.summary({ channel: "gnc", sourceIds: [fixture.sourceId] });
      expect(all).toMatchObject([{ total: 9, counts: { following: 1 } }]);
      expect(await fixture.queue.summary({ channel: "gnc", requestId: randomUUID() })).toEqual([]);
      const recent = await fixture.queue.summary({
        channel: "gnc",
        sourceIds: [fixture.sourceId],
        createdSince: "2026-10-02T00:00:00Z",
      });
      expect(recent).toMatchObject([{ total: 0, counts: {}, reviewReasons: [] }]);
    });

    it("lists scan facts without multiplicative queue counts and exposes revisions usable for toggling", async () => {
      const page = await brands.sources(ListSourcesSchema.parse({ channel: "gnc", scanned: true }));
      expect(page.items).toHaveLength(2);
      const source = page.items.find((item) => item.id === fixture.sourceId);
      expect(source).toMatchObject({
        brandId: fixture.brandId,
        brandName: "Operator test brand",
        queueProductCount: 9,
        enabled: true,
        lastScan: {
          scanId: fixture.laterScanId,
          state: "queued",
          requestedAt: "2026-10-02T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
      });
      expect(page.items.find((item) => item.id === fixture.emptySource)).toMatchObject({
        queueProductCount: 0,
        lastScan: { state: "queued" },
      });
      const unscanned = await brands.sources(
        ListSourcesSchema.parse({ channel: "gnc", scanned: false }),
      );
      expect(unscanned.items).toMatchObject([{ id: fixture.unscannedSource, lastScan: null }]);
      const enabled = await brands.sources(
        ListSourcesSchema.parse({ channel: "gnc", enabled: true }),
      );
      expect(enabled.items.map((item) => item.id)).toEqual([fixture.sourceId]);
      if (!source) {
        throw new Error("source fixture missing");
      }
      const toggle = {
        brandId: fixture.brandId,
        sourceId: source.id,
        revision: source.revision,
        enabled: false,
        requestId: randomUUID(),
      };
      expect(await brands.toggleSource(toggle)).toMatchObject({
        enabled: false,
        revision: source.revision + 1,
      });
      await expect(
        brands.toggleSource({ ...toggle, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "BRAND.REVISION_CONFLICT" });
    });

    it("keeps brand listing compatible and pages sources with stable offsets", async () => {
      const input = { channel: "gnc" as const, brandId: fixture.brandId };
      const all = await brands.sources(ListSourcesSchema.parse(input));
      const first = await brands.sources(ListSourcesSchema.parse({ ...input, limit: 1 }));
      const second = await brands.sources(
        ListSourcesSchema.parse({ ...input, limit: 1, offset: 1 }),
      );
      expect(first).toMatchObject({ items: [all.items[0]], hasMore: true, offset: 0 });
      expect(second).toMatchObject({ items: [all.items[1]], hasMore: true, offset: 1 });
      const byBrand = await brands.sources(ListSourcesSchema.parse({ brandId: fixture.brandId }));
      expect(byBrand.items).toHaveLength(4);
      expect(await brands.sources(ListSourcesSchema.parse({ ...input, offset: 10 }))).toMatchObject(
        { items: [], hasMore: false },
      );
    });

    it("previews without writes, serializes bounded requeues and preserves attempts and active items", async () => {
      const database = fixture.database;
      const attempts = await database.query("SELECT * FROM queue_attempt ORDER BY run_id");
      const before = await database.query("SELECT * FROM queue_item ORDER BY item_id");
      const input = RequeueSchema.parse({
        channel: "gnc",
        filter: { state: "review", reasons: ["QUEUE.RUN_FAILED"], sourceIds: [fixture.sourceId] },
        limit: 1,
      });
      const preview = await fixture.queue.requeue(input);
      expect(preview).toMatchObject({ dryRun: true, count: 1 });
      expect(await database.query("SELECT * FROM queue_item ORDER BY item_id")).toEqual(before);
      const [left, right] = await Promise.all([
        fixture.queue.requeue({ ...input, dryRun: false }),
        fixture.queue.requeue({ ...input, dryRun: false }),
      ]);
      expect(left).toEqual({ requeued: 1 });
      expect(right).toEqual({ requeued: 1 });
      expect(await fixture.queue.requeue({ ...input, dryRun: false })).toEqual({ requeued: 0 });
      expect(await database.query("SELECT * FROM queue_attempt ORDER BY run_id")).toEqual(attempts);
      const after = await database.query("SELECT * FROM queue_item ORDER BY item_id");
      const unchanged = before.filter(
        (row) => !String(Reflect.get(row, "listing_id")).startsWith("retry-"),
      );
      expect(
        after.filter((row) => !String(Reflect.get(row, "listing_id")).startsWith("retry-")),
      ).toEqual(unchanged);
      const reviews = await fixture.queue.items({ channel: "gnc", state: "review", limit: 10 });
      expect(reviews.map((item) => item.reason)).toEqual(["CAPTURE.NOT_FOUND"]);
      const queued = await fixture.queue.items({ channel: "gnc", state: "queued", limit: 10 });
      const retried = queued.filter((item) => item.listingId?.startsWith("retry-"));
      expect(retried).toHaveLength(2);
      expect(
        retried.every((item) => item.attempt === 1 && item.runId === null && item.reason === null),
      ).toBe(true);
    });

    it("rejects running and queued IDs atomically through the original requeue path", async () => {
      const running = await fixture.queue.items({ channel: "gnc", state: "running", limit: 10 });
      const review = await fixture.queue.items({ channel: "gnc", state: "review", limit: 10 });
      const queued = await fixture.queue.items({ channel: "gnc", state: "queued", limit: 10 });
      for (const active of [running[0], queued[0]]) {
        await expect(
          fixture.queue.requeue({
            channel: "gnc",
            itemIds: [review[0]?.itemId ?? "", active?.itemId ?? ""],
          }),
        ).rejects.toMatchObject({ code: "QUEUE.REQUEUE_NOT_SETTLED" });
      }
      expect(await fixture.queue.items({ channel: "gnc", state: "review", limit: 10 })).toEqual(
        review,
      );
    });
  },
);
