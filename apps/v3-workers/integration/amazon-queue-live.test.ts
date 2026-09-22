import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { AmazonQueue, AmazonQueueRunner } from "../src/amazon-queue.js";
import { AmazonQueueTemporal } from "../src/amazon-queue-temporal.js";
import { AmazonLinkBatchSchema } from "../src/amazon-link-batches.js";

it("Mini: real PostgreSQL + Temporal resume an unknown acknowledgement and settle exact cancelled descendants", async () => {
  if (!/^(barrydeMac-mini|servers-Mac-mini)(?:\.|$)/.test(hostname())) throw Error("Run integration on Mac mini");
  const db = await startTestDatabase(), env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
  const taskQueue = "queue-proof-" + randomUUID(), workflowBundle = { codePath: join(dirname(fileURLToPath(import.meta.url)), "amazon-queue-workflows.cjs") };
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle }), run = worker.run(); run.catch(() => {});
  try {
    const brands = new PostgresBrands(db.pool), queue = new AmazonQueue(db.pool);
    const ports = new AmazonQueueTemporal(db.pool, db.pool, env.client, { clusterId: "queue-test", namespace: "default", taskQueue, workflowType: "BrandCollectionWorkflow" });
    const batch = async (suffix: string) => {
      const brand = (await brands.create({ name: "Queue temporal " + suffix, note: "" }, randomUUID())).value;
      const source = (await brands.createSource(brand.id, { channel: "amazon", region: "US", url: "https://www.amazon.com/" }, randomUUID())).value;
      await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
      return AmazonLinkBatchSchema.parse({ codec: "amazon-link-batch/1", requestId: randomUUID(),
        scope: { brandId: brand.id, sourceId: source.id, channel: "amazon", region: "US", rootUrl: source.url, scopeVersion: "source-revision-2" },
        candidateManifestSha256: "a".repeat(64), entries: [{ candidateId: "b".repeat(64), historyListingId: "c".repeat(64),
          entry: { listingId: "B000REPUY0", variantId: null, kind: "product", url: "https://www.amazon.com/dp/B000REPUY0" } }] });
    };
    await queue.add("real-fast", [await batch("fast")]); await queue.resume();
    let lost = true;
    await new AmazonQueueRunner(queue, { submit: async b => { await ports.submit(b); if (lost) { lost = false; throw Error("QUEUE.LOST_ACK"); } },
      inspect: b => ports.inspect(b), stop: b => ports.stop(b) }).tick(new AbortController().signal);
    const attempt = (await db.pool.query("SELECT * FROM amazon_queue_attempt")).rows[0];
    expect(attempt).toBeDefined();
    const cold = new AmazonQueueRunner(new AmazonQueue(db.pool), new AmazonQueueTemporal(db.pool, db.pool, env.client, ports.gateway.target));
    const tick = async () => { await db.pool.query("UPDATE amazon_queue_item SET next_check_at=clock_timestamp() WHERE state='running'"); await cold.tick(new AbortController().signal); };
    await vi.waitFor(async () => { await tick(); expect((await queue.status()).counts.completed).toBe(1); }, { timeout: 20000, interval: 100 });
    expect((await db.pool.query("SELECT count(*)::int n FROM amazon_queue_attempt")).rows[0].n).toBe(1);
    expect((await ports.journal.get(attempt.request_id))?.state).toBe("CLOSED");
    expect((await db.pool.query("SELECT 1 FROM source_submission_guard")).rowCount).toBe(0);
    await queue.add("real-slow", [await batch("slow")]); await tick();
    const slow = (await db.pool.query("SELECT * FROM amazon_queue_item WHERE state='running'")).rows[0];
    await vi.waitFor(async () => expect((await env.client.workflow.getHandle(`v3-collection-${slow.request_id}-product`).describe()).status.name).toBe("RUNNING"), { timeout: 10000 });
    await queue.pause(true);
    await vi.waitFor(async () => { await tick(); expect((await queue.status()).mode).toBe("paused"); }, { timeout: 20000, interval: 100 });
    expect((await db.pool.query("SELECT outcome,proof FROM amazon_queue_attempt WHERE request_id=$1", [slow.request_id])).rows[0]).toMatchObject({ outcome: "interrupted", proof: { heldPermits: 0, pageCleanup: "no-owned-pages" } });
    expect((await db.pool.query("SELECT state FROM amazon_queue_item WHERE item_id=$1", [slow.item_id])).rows[0].state).toBe("queued");
    expect((await ports.journal.get(slow.request_id))?.observedStatus).toBe("CANCELLED");
    expect((await db.pool.query("SELECT 1 FROM source_submission_guard")).rowCount).toBe(0);
  } finally { worker.shutdown(); await run; await env.teardown(); await db.close(); }
}, 120000);
