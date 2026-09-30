import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresQueueStore } from "./postgres-queue-store.js";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";
import { PostgresQueueDispatch } from "./postgres-queue-dispatch.js";

interface TemporaryPostgres {
  database: Database;
  stop(): Promise<void>;
}

const hasPostgres = (() => {
  try {
    for (const executable of ["initdb", "pg_ctl"]) {
      execFileSync(executable, ["--version"], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPostgres || process.env.V3_TEST_SKIP_POSTGRES === "1")(
  "Amazon shared queue migration on isolated Unix-socket PostgreSQL",
  () => {
    let postgres: TemporaryPostgres | undefined;
    let database: Database;
    let sourceId: string;
    let brandId: string;
    let migration: string;
    let preview: PostgresQueueStore;

    beforeAll(async () => {
      const { startTemporaryPostgres } = await vi.importActual<{
        startTemporaryPostgres(): Promise<TemporaryPostgres>;
      }>("../../integration/temporary-postgres.js");
      postgres = await startTemporaryPostgres();
      database = postgres.database;
      preview = new PostgresQueueStore(database);
      migration = await readFile(
        new URL("../../../../database/v3/034_amazon_queue_to_shared.sql", import.meta.url),
        "utf8",
      );
      const [brand] = await database.query<{ id: string }>(
        "INSERT INTO brand (name) VALUES ('Amazon queue migration test') RETURNING id",
      );
      brandId = brand?.id ?? "";
      const [source] = await database.query<{ id: string }>(
        `INSERT INTO brand_source (brand_id, channel, url, enabled)
         VALUES ($1, 'amazon', 'https://www.amazon.com/', true) RETURNING id`,
        [brandId],
      );
      sourceId = source?.id ?? "";
    }, 120_000);

    afterAll(async () => {
      await postgres?.stop();
    }, 60_000);

    beforeEach(async () => {
      // This is a private test cluster; preserve the fixture source but reset both queue histories.
      await database.query(
        "TRUNCATE queue_item, link_batch, amazon_queue_item, amazon_link_batch CASCADE",
      );
    });

    function legacyInput(index: number) {
      const listingId = `B${String(index).padStart(9, "0")}`;
      return {
        codec: "amazon-link-batch/1",
        requestId: randomUUID(),
        scope: {
          sourceId,
          brandId,
          channel: "amazon",
          region: "US",
          rootUrl: "https://www.amazon.com/",
          scopeVersion: "source-revision-1",
        },
        candidateManifestSha256: "b".repeat(64),
        entries: [
          {
            entry: {
              listingId,
              url: `https://www.amazon.com/dp/${listingId}`,
              variantId: null,
              kind: "product",
            },
            candidateId: "c".repeat(64),
            historyListingId: "d".repeat(64),
          },
        ],
      };
    }

    async function seed(options: {
      index: number;
      state: string;
      attempt?: number;
      withRequest?: boolean;
      history?: boolean;
    }) {
      const itemId = options.index.toString(16).padStart(64, "0");
      const input = legacyInput(options.index);
      await database.query(
        `INSERT INTO amazon_queue_item
         (item_id, campaign_id, input, state, attempt, request_id, created_at)
         VALUES ($1, 'campaign-1', $2, $3, $4, $5, '2026-09-24T00:00:00Z')`,
        [
          itemId,
          input,
          options.state,
          options.attempt ?? 0,
          options.withRequest ? input.requestId : null,
        ],
      );
      if (options.history) {
        await database.query("INSERT INTO amazon_link_batch (request_id, record) VALUES ($1, $2)", [
          input.requestId,
          input,
        ]);
        await database.query(
          `INSERT INTO amazon_queue_attempt (request_id, item_id, attempt, outcome, proof, settled_at)
           VALUES ($1, $2, 1, 'review', '{"reason":"retained"}', clock_timestamp())`,
          [input.requestId, itemId],
        );
      }
      return itemId;
    }

    async function migrate() {
      await database.transaction(async (tx) => {
        await tx.query(migration.replace(/\bBEGIN;/, "").replace(/COMMIT;\s*$/, ""));
      });
    }

    async function legacySnapshot() {
      return database.query(`SELECT
        (SELECT jsonb_agg(i ORDER BY item_id) FROM amazon_queue_item i) AS items,
        (SELECT jsonb_agg(a ORDER BY request_id) FROM amazon_queue_attempt a) AS attempts,
        (SELECT jsonb_agg(b ORDER BY request_id) FROM amazon_link_batch b) AS batches,
        (SELECT jsonb_agg(c) FROM amazon_queue_control c) AS control`);
    }

    it("copies queued and ready once, retaining URLs, sources, age and legacy bytes", async () => {
      const queued = await seed({ index: 1, state: "queued" });
      const ready = await seed({ index: 2, state: "ready" });
      const before = await legacySnapshot();
      expect(await preview.migrationPreview()).toEqual({ pending: 2, alreadyCopied: 0 });
      await migrate();
      const items = await database.query<{ item_id: string }>(
        `SELECT item_id, channel, source_id, url, listing_id, variant_id, state, attempt, run_id,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM queue_item ORDER BY item_id`,
      );
      expect(items).toHaveLength(2);
      expect(items.map((row) => row.item_id)).toEqual([queued, ready]);
      expect(items).toEqual(
        [1, 2].map((index) => ({
          item_id: index.toString(16).padStart(64, "0"),
          channel: "amazon",
          source_id: sourceId,
          url: `https://www.amazon.com/dp/B00000000${index}`,
          listing_id: `B00000000${index}`,
          variant_id: null,
          state: "queued",
          attempt: 0,
          run_id: null,
          created_at: "2026-09-24T00:00:00Z",
        })),
      );
      const batches = await database.query("SELECT * FROM link_batch ORDER BY batch_id");
      expect(batches).toHaveLength(2);
      expect(batches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "amazon",
            label: "Legacy Amazon: campaign-1",
            item_count: 1,
          }),
        ]),
      );
      await migrate();
      expect(await database.query("SELECT * FROM link_batch ORDER BY batch_id")).toEqual(batches);
      expect(await database.query("SELECT item_id FROM queue_item")).toHaveLength(2);
      expect(await preview.migrationPreview()).toEqual({ pending: 0, alreadyCopied: 2 });
      expect(await legacySnapshot()).toEqual(before);
      expect(await database.query("SELECT * FROM queue_attempt")).toEqual([]);
      expect(
        await database.query("SELECT mode FROM queue_control WHERE channel = 'amazon'"),
      ).toEqual([{ mode: "paused" }]);
    });

    it("excludes running, completed, Review, requeued attempts and any retained attempt history", async () => {
      await seed({ index: 1, state: "running", attempt: 1, withRequest: true });
      await seed({ index: 2, state: "completed" });
      await seed({ index: 3, state: "review" });
      await seed({ index: 4, state: "queued", attempt: 1 });
      await seed({ index: 5, state: "ready", withRequest: true });
      await seed({ index: 6, state: "queued", history: true });
      const pending = await seed({ index: 7, state: "queued" });
      const before = await legacySnapshot();
      expect(await preview.migrationPreview()).toEqual({ pending: 1, alreadyCopied: 0 });
      await migrate();
      expect(await database.query("SELECT item_id FROM queue_item")).toEqual([
        { item_id: pending },
      ]);
      expect(await legacySnapshot()).toEqual(before);
      expect(await preview.migrationPreview()).toEqual({ pending: 0, alreadyCopied: 1 });
    });

    it("keeps the copy marker after dispatch and consumes existing Whole Foods formula requests", async () => {
      const legacyId = await seed({ index: 1, state: "queued" });
      const shared = new PostgresChannelQueueStore(database);
      const list = {
        batchId: randomUUID(),
        label: "Whole Foods unknown ASIN",
        products: [
          {
            sourceId,
            url: "https://www.amazon.com/dp/B000000099",
            listingId: "B000000099",
            variantId: null,
          },
        ],
      };
      expect(await shared.holdAmazonProducts(list)).toEqual({ added: 1 });
      expect(await shared.add({ ...list, channel: "amazon" })).toEqual({ added: 0 });
      await migrate();
      const dispatch = new PostgresQueueDispatch(database);
      const control = {
        channel: "amazon" as const,
        mode: "running" as const,
        readyLimit: 20,
        runningLimit: 40,
      };
      await dispatch.fillReady(control);
      const claimed = await dispatch.claim(control);
      expect(claimed).toHaveLength(2);
      expect(claimed.map((item) => item.url).sort()).toEqual([
        "https://www.amazon.com/dp/B000000001",
        "https://www.amazon.com/dp/B000000099",
      ]);
      for (const item of claimed) {
        await dispatch.settle(item, { state: "completed", reason: null });
      }
      await shared.requeue({ channel: "amazon", itemIds: [legacyId] });
      const before = await database.query("SELECT * FROM queue_item ORDER BY item_id");
      await migrate();
      expect(await database.query("SELECT * FROM queue_item ORDER BY item_id")).toEqual(before);
      expect(await preview.migrationPreview()).toEqual({ pending: 0, alreadyCopied: 1 });
      expect(await database.query("SELECT * FROM queue_attempt")).toHaveLength(2);
    });

    it("fails atomically for a foreign source instead of skipping an eligible item", async () => {
      await seed({ index: 1, state: "queued" });
      const invalid = await seed({ index: 2, state: "queued" });
      await database.query(
        `UPDATE amazon_queue_item SET input = jsonb_set(input, '{scope,sourceId}', to_jsonb($2::text))
         WHERE item_id = $1`,
        [invalid, randomUUID()],
      );
      const before = await legacySnapshot();
      await expect(migrate()).rejects.toMatchObject({ code: "23514" });
      expect(await database.query("SELECT * FROM queue_item")).toEqual([]);
      expect(await database.query("SELECT * FROM link_batch")).toEqual([]);
      expect(await legacySnapshot()).toEqual(before);
    });
  },
);
