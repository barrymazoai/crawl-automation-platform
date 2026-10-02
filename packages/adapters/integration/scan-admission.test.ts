import { randomUUID } from "node:crypto";
import { ListingStateService, QueueChannelSchema } from "@crawl-automation/app";
import { PostgresListingStates } from "../src/postgres/postgres-listing-states.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScanAdmissionFixture } from "./scan-admission-fixture.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

// Explicit opt-in on the authorized test host only; never a production connection.
describe.skipIf(process.env.CRAWLER_TEST_POSTGRES !== "1")("brand discovery SKU admission", () => {
  let postgres: TemporaryPostgres;
  let fixture: ScanAdmissionFixture;
  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    fixture = new ScanAdmissionFixture(postgres.database);
    await fixture.seed();
  }, 120_000);
  beforeEach(async () => {
    await postgres.database.query(
      "TRUNCATE link_batch, queue_item, queue_attempt, queue_scan_admission CASCADE",
    );
  });
  afterAll(async () => postgres?.stop());

  it.each(QueueChannelSchema.options)("accumulates only unseen SKUs on %s", async (channel) => {
    const first = fixture.batch(["one", "two"], channel);
    expect(await fixture.queue.addScanDiscovery(first)).toEqual({
      added: 2,
      following: 0,
      recent: 0,
    });
    await fixture.finish(first);
    expect(await fixture.queue.addScanDiscovery(fixture.batch(["one", "two"], channel))).toEqual({
      added: 0,
      following: 0,
      recent: 2,
    });
    const next = fixture.batch(["one", "two", "three", "three"], channel);
    expect(await fixture.queue.addScanDiscovery(next)).toEqual({
      added: 1,
      following: 0,
      recent: 2,
    });
    expect(await postgres.database.query("SELECT item_id FROM queue_item")).toHaveLength(3);
    expect(await postgres.database.query("SELECT run_id FROM queue_attempt")).toHaveLength(2);
  });

  it.each(["completed", "review"] as const)(
    "skips recent %s and admits after expiry",
    async (state) => {
      const first = fixture.batch();
      await fixture.queue.addScanDiscovery(first);
      // An old creation date cannot make a newly settled item eligible.
      await postgres.database.query("UPDATE queue_item SET created_at = now() - interval '3 days'");
      await fixture.finish(first, state);
      const skipped = fixture.batch();
      expect(await fixture.queue.addScanDiscovery(skipped)).toEqual({
        added: 0,
        following: 0,
        recent: 1,
      });
      await fixture.age(first, 25);
      // Replaying the old scan never extends the window or admits its skipped products later.
      expect(await fixture.queue.addScanDiscovery(skipped)).toEqual({
        added: 0,
        following: 0,
        recent: 1,
      });
      expect(await fixture.queue.addScanDiscovery(fixture.batch())).toEqual({
        added: 1,
        following: 0,
        recent: 0,
      });
    },
  );

  it("honors custom windows and zero restores cross-batch admission", async () => {
    const first = fixture.batch();
    await fixture.queue.addScanDiscovery(first);
    await fixture.finish(first);
    await fixture.age(first, 25);
    expect(await fixture.service(48).addScanDiscovery(fixture.batch())).toEqual({
      added: 0,
      following: 0,
      recent: 1,
    });
    await fixture.age(first, 0);
    expect(await fixture.service(0).addScanDiscovery(fixture.batch())).toEqual({
      added: 1,
      following: 0,
      recent: 0,
    });
    expect(await fixture.service(0).addScanDiscovery(fixture.batch())).toEqual({
      added: 0,
      following: 1,
      recent: 0,
    });
  });

  it("keeps active followers ahead of recent terminals and settles them without another attempt", async () => {
    const first = fixture.batch();
    await fixture.queue.addScanDiscovery(first);
    await fixture.finish(first);
    const explicit = fixture.batch();
    await fixture.queue.add(explicit);
    for (const state of ["queued", "ready", "running"] as const) {
      const control = {
        channel: "wholefoods" as const,
        mode: "running" as const,
        readyLimit: 20,
        runningLimit: 20,
      };
      if (state === "ready") {
        await fixture.dispatch.fillReady(control);
      }
      if (state === "running") {
        await fixture.dispatch.claim(control);
      }
      expect(await fixture.queue.addScanDiscovery(fixture.batch())).toEqual({
        added: 0,
        following: 1,
        recent: 0,
      });
    }
    const [leader] = await fixture.dispatch.running("wholefoods");
    expect(leader).toBeDefined();
    if (!leader) {
      throw new Error("missing active leader");
    }
    await fixture.dispatch.settle(leader, { state: "completed", reason: null });
    expect((await fixture.store.status("wholefoods")).counts).toEqual({ completed: 5 });
    expect(await postgres.database.query("SELECT * FROM queue_attempt")).toHaveLength(2);
  });

  it("keeps revisit/explicit lists and explicit requeue outside the window", async () => {
    const first = fixture.batch();
    await fixture.queue.addScanDiscovery(first);
    const [done] = await fixture.finish(first, "review");
    expect(done).toBeDefined();
    const revisit = { ...fixture.batch(), label: "revisit after brand scan: fixture" };
    const listings = new ListingStateService({
      store: new PostgresListingStates(postgres.database),
      queue: fixture.queue,
    });
    const { products, ...batch } = revisit;
    expect(await listings.requestRevisits({ ...batch, scope: "full", listings: products })).toEqual(
      { queued: 1 },
    );
    await fixture.finish(revisit);
    expect(await fixture.queue.add(fixture.batch())).toEqual({ added: 1 });
    await fixture.finish(first);
    expect(
      await fixture.queue.requeue({ channel: "wholefoods", itemIds: [done?.itemId ?? ""] }),
    ).toEqual({ requeued: 1 });
  });

  it("does not extend terminal skips to formula-pending items", async () => {
    const first = fixture.batch();
    await fixture.queue.addScanDiscovery(first);
    await fixture.finish(first, "pending");
    expect(await fixture.queue.addScanDiscovery(fixture.batch())).toEqual({
      added: 1,
      following: 0,
      recent: 0,
    });
  });

  it("uses channel and variant identity, ignoring source and changed URLs", async () => {
    const first = fixture.batch();
    await fixture.queue.addScanDiscovery(first);
    await fixture.finish(first);
    const otherSource = randomUUID();
    await postgres.database.query(
      `INSERT INTO brand_source (id, brand_id, channel, url)
       SELECT $1, brand_id, channel, 'https://example.test/another-brand' FROM brand_source WHERE id = $2`,
      [otherSource, first.products[0]?.sourceId],
    );
    const changed = fixture.batch();
    changed.products = changed.products.map((product) => ({
      ...product,
      sourceId: otherSource,
      url: `${product.url}?new=1`,
    }));
    expect(await fixture.queue.addScanDiscovery(changed)).toEqual({
      added: 0,
      following: 0,
      recent: 1,
    });
    const variant = fixture.batch();
    variant.products = variant.products.map((product) => ({ ...product, variantId: "large" }));
    expect(await fixture.queue.addScanDiscovery(variant)).toEqual({
      added: 1,
      following: 0,
      recent: 0,
    });
    expect(await fixture.queue.addScanDiscovery(fixture.batch(["one"], "gnc"))).toEqual({
      added: 1,
      following: 0,
      recent: 0,
    });
  });

  it("serializes simultaneous overlapping scans and replays their immutable admission counts", async () => {
    const old = fixture.batch(["old"]);
    await fixture.queue.addScanDiscovery(old);
    await fixture.finish(old);
    const batches = Array.from({ length: 4 }, () => fixture.batch(["old", "one", "two"]));
    const results = await Promise.all(
      batches.map((batch) => fixture.queue.addScanDiscovery(batch)),
    );
    expect(results.reduce((sum, result) => sum + result.added, 0)).toBe(2);
    expect(results.reduce((sum, result) => sum + result.following, 0)).toBe(6);
    expect(results.every((result) => result.recent === 1)).toBe(true);
    await fixture.finish(old);
    expect(
      await Promise.all(batches.map((batch) => fixture.service(0).addScanDiscovery(batch))),
    ).toEqual(results);
    expect(await postgres.database.query("SELECT * FROM queue_attempt")).toHaveLength(3);
    await expect(
      fixture.queue.addScanDiscovery({ ...batches[0], label: "changed" } as typeof old),
    ).rejects.toMatchObject({ code: "QUEUE.IMPORT_CONFLICT" });
    expect(await postgres.database.query("SELECT * FROM queue_scan_admission")).toHaveLength(5);
    await expect(
      postgres.database.query("UPDATE queue_scan_admission SET recent = 0"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back both the batch and queue items when the admission receipt cannot commit", async () => {
    await expect(
      fixture.store.add(fixture.batch(), { recentScanSkipHours: 8_761 }),
    ).rejects.toMatchObject({ code: "23514" });
    for (const table of ["link_batch", "queue_item", "queue_scan_admission"]) {
      expect(await postgres.database.query(`SELECT * FROM ${table}`)).toEqual([]);
    }
  });
});
