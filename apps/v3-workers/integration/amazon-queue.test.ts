import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startTestDatabase } from "../../v3-api/integration/postgres.js";
import { AmazonQueue, AmazonQueueRunner, type QueueInspection } from "../src/amazon-queue.js";
import { AmazonLinkStore } from "../src/amazon-link-store.js";
import { AmazonLinkBatchSchema } from "../src/amazon-link-batches.js";
import { PostgresBrands } from "../../v3-api/src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../../v3-api/src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../../v3-api/src/storage/postgres-delivery.js";
import { PostgresDeliveryScan } from "../../v3-api/src/storage/postgres-delivery-scan.js";
import { inputHash, workflowInput } from "../../v3-api/src/delivery/identity.js";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { db = await startTestDatabase(); }, 60000);
afterAll(async () => { await db?.close(); }, 30000);
const fixture = (n: number) => AmazonLinkBatchSchema.parse({ codec: "amazon-link-batch/1", requestId: randomUUID(),
  scope: { brandId: randomUUID(), sourceId: randomUUID(), channel: "amazon", region: "US", rootUrl: "https://www.amazon.com/", scopeVersion: "source-revision-2" },
  candidateManifestSha256: "a".repeat(64), entries: Array.from({ length: n }, (_, i) => ({ candidateId: "b".repeat(64), historyListingId: "c".repeat(64),
    entry: { listingId: `B${String(i).padStart(9, "0")}`, variantId: null, kind: "product", url: `https://www.amazon.com/dp/B${String(i).padStart(9, "0")}` } })) });
const signal = () => new AbortController().signal;
const due = () => db.pool.query("UPDATE amazon_queue_item SET next_check_at=clock_timestamp() WHERE state='running'");

it("dynamic authorization is immutable, survives cold reads and does not use the legacy 2000-batch limit", async () => {
  const store = new AmazonLinkStore(db.pool), b = fixture(1);
  expect(await store.get(b.requestId)).toBeNull(); await store.put(b);
  expect(await new AmazonLinkStore(db.pool).get(b.requestId)).toEqual(b);
  await expect(store.put({ ...b, candidateManifestSha256: "f".repeat(64) })).rejects.toThrow("IDENTITY_CONFLICT");
  await expect(db.pool.query("UPDATE amazon_link_batch SET record=$2 WHERE request_id=$1", [b.requestId, b])).rejects.toThrow("immutable");
});

it("persists product caps, pause/drain/restart/requeue, and waits for cleanup after force pause", async () => {
  const queue = new AmazonQueue(db.pool), batch = fixture(10), extra = fixture(2);
  expect(await queue.add("lifecycle", [batch, extra])).toEqual({ added: 12 });
  expect(await queue.add("lifecycle", [batch, extra])).toEqual({ added: 0 });
  expect((await queue.status()).mode).toBe("paused");
  await queue.configure(2, 3);
  const calls = new Map<string, number>(), outcomes = new Map<string, QueueInspection>();
  let held: string | undefined;
  const ports = {
    submit: vi.fn(async b => { calls.set(b.requestId, (calls.get(b.requestId) ?? 0) + 1); }),
    inspect: vi.fn(async b => outcomes.get(b.requestId) ?? { status: "running" as const }),
    stop: vi.fn(async b => { outcomes.set(b.requestId, b.requestId === held ? { status: "cleanup-pending", reason: "held-resource" } : { status: "interrupted", proof: { stopped: true } }); }),
  };
  const runner = new AmazonQueueRunner(queue, ports);
  await runner.tick(signal()); expect(calls.size).toBe(0);
  await queue.resume(); await Promise.all([runner.tick(signal()), new AmazonQueueRunner(new AmazonQueue(db.pool), ports).tick(signal())]);
  expect(await queue.status()).toMatchObject({ counts: { running: 3, ready: 2, queued: 7 } }); expect(calls.size).toBe(3);
  await queue.pause(false, 0);
  expect(await queue.status()).toMatchObject({ mode: "draining", counts: { running: 3, queued: 9 } });
  for (const id of calls.keys()) outcomes.set(id, { status: "completed", proof: { settled: true } });
  await due(); await new AmazonQueueRunner(new AmazonQueue(db.pool), ports).tick(signal());
  expect(await queue.status()).toMatchObject({ mode: "paused", counts: { completed: 3, queued: 9 } }); expect(calls.size).toBe(3);
  const completed = (await db.pool.query("SELECT item_id,request_id FROM amazon_queue_item WHERE state='completed' ORDER BY item_id LIMIT 1")).rows[0];
  await queue.requeue([completed.item_id]);
  expect((await db.pool.query("SELECT outcome FROM amazon_queue_attempt WHERE request_id=$1", [completed.request_id])).rows[0].outcome).toBe("completed");
  await queue.resume(); await runner.tick(signal());
  const current = (await db.pool.query("SELECT item_id,request_id FROM amazon_queue_item WHERE state='running'")).rows;
  expect(current).toHaveLength(3); expect(current.every(r => r.request_id !== completed.request_id)).toBe(true);
  await expect(queue.requeue([current[0].item_id])).rejects.toThrow("NOT_SETTLED");
  held = current[0].request_id; await queue.pause(true); await runner.tick(signal());
  expect((await queue.status()).mode).toBe("stopping"); expect(ports.stop).toHaveBeenCalledTimes(3);
  expect((await queue.status()).counts.running).toBe(1); await expect(queue.resume()).rejects.toThrow("CLEANUP_PENDING");
  held = undefined; await due(); await runner.tick(signal());
  expect((await queue.status()).mode).toBe("paused"); expect((await queue.status()).counts.running).toBeUndefined();
  // Attempt history is never rewritten by requeue, even when an old outcome was Review.
  await expect(db.pool.query("UPDATE amazon_queue_attempt SET proof='{}' WHERE request_id=$1", [completed.request_id])).rejects.toThrow("immutable");
});

it("a poison item and a failed log sink do not stop other products, and DB tick errors do not kill the runner", async () => {
  const queue = new AmazonQueue(db.pool); await queue.configure(2, 3); await queue.resume();
  const submitted: string[] = [];
  const runner = new AmazonQueueRunner(queue, { submit: async b => { submitted.push(b.requestId); if (submitted.length === 1) throw Error("QUEUE.INJECTED"); },
    inspect: async () => ({ status: "completed", proof: { settled: true } }), stop: async () => {} }, () => { throw Error("log offline"); });
  await runner.tick(signal()); expect(submitted.length).toBeGreaterThan(1);
  expect((await queue.status()).attention).toBe(1);
  await queue.pause(false, 0); await due(); await runner.tick(signal());
  expect((await queue.status()).mode).toBe("paused");
  const ctl = new AbortController(), events: string[] = [];
  const broken = new AmazonQueueRunner({ pool: { query: async () => { throw Error("offline"); } } } as any,
    {} as any, e => { events.push(e.event); ctl.abort(); });
  await broken.run(ctl.signal); expect(events).toEqual(["QUEUE_TICK_FAILED"]);
});

it("pause waits for a dispatch already inside its critical section, then blocks every later Start", async () => {
  const queue = new AmazonQueue(db.pool); await queue.add("pause-race", [fixture(3)]); await queue.resume();
  let release!: () => void; const submitted: string[] = [];
  const runner = new AmazonQueueRunner(queue, { submit: async b => { submitted.push(b.requestId); await new Promise<void>(ok => { release = ok; }); },
    inspect: async () => ({ status: "running" }), stop: async () => {} });
  const tick = runner.tick(signal()); await vi.waitFor(() => expect(submitted).toHaveLength(1));
  let paused = false; const stopping = queue.pause(false, 0).then(() => { paused = true; });
  await new Promise(ok => setTimeout(ok, 20)); expect(paused).toBe(false); release(); await stopping; await tick;
  expect(submitted).toHaveLength(1); expect((await queue.status()).mode).toBe("draining");
  await queue.pause(true); await due();
  await new AmazonQueueRunner(queue, { submit: async () => { throw Error("No new Start"); }, inspect: async () => ({ status: "interrupted", proof: { stopped: true } }), stop: async () => {} }).tick(signal());
});

it("imports more than 2000 dynamic batches without changing or restarting workers", async () => {
  const queue = new AmazonQueue(db.pool), batch = fixture(1);
  const batches = Array.from({ length: 2001 }, (_, i) => ({ ...batch, requestId: randomUUID(), entries: [{ ...batch.entries[0]!, entry: {
    ...batch.entries[0]!.entry, listingId: `C${String(i).padStart(9, "0")}`, url: `https://www.amazon.com/dp/C${String(i).padStart(9, "0")}` } }] }));
  expect(await queue.add("large-dynamic", batches)).toEqual({ added: 2001 });
  expect((await queue.status()).mode).toBe("paused");
}, 60000);

it("host backpressure blocks new intake while already running work can settle; a grace deadline escalates", async () => {
  const queue=new AmazonQueue(db.pool);await queue.add('health-check',[fixture(4)]);await queue.configure(2,2);await queue.resume();
  let healthy=false,finished=false;const submit=vi.fn(async()=>{}),stop=vi.fn(async()=>{finished=true;});
  const runner=new AmazonQueueRunner(queue,{canStart:async()=>healthy,submit,stop,
    inspect:async()=>finished?{status:'interrupted',proof:{stopped:true}}:{status:'running'}});
  await runner.tick(signal());expect(submit).not.toHaveBeenCalled();
  healthy=true;await runner.tick(signal());expect((await queue.status()).counts.running).toBe(2);
  healthy=false;await queue.pause(false,900);
  await db.pool.query("UPDATE amazon_queue_control SET force_after=clock_timestamp()-interval '1 second' WHERE singleton");
  await due();await runner.tick(signal());
  expect(stop).toHaveBeenCalledTimes(2);expect(submit).toHaveBeenCalledTimes(2);
  expect((await queue.status()).mode).toBe('paused');
});

it("backs off existing unconfirmed deliveries for one hour while unrelated requests remain eligible", async () => {
  const brands = new PostgresBrands(db.pool), submissions = new PostgresSubmissions(db.pool), journal = new PostgresDelivery(db.pool);
  const brand = (await brands.create({ name: "Queue delivery probe", note: "" }, randomUUID())).value;
  const source = (await brands.createSource(brand.id, { channel: "amazon", region: "US", url: "https://www.amazon.com/" }, randomUUID())).value;
  await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
  const first = (await submissions.accept(brand.id, source.id, { sourceRevision: 2 }, randomUUID())).value;
  const next = (await submissions.accept(brand.id, source.id, { sourceRevision: 2 }, randomUUID())).value;
  const target = { clusterId: "test", namespace: "test", taskQueue: "test", workflowType: "Probe" };
  await journal.begin(first.requestId, target, inputHash(workflowInput(first))); await journal.record(first.requestId, "UNCONFIRMED_TERMINAL");
  const scan = new PostgresDeliveryScan(db.pool), end = (await scan.upperBound())!;
  expect((await scan.page(null, end, 100)).map(r => r.requestId)).toEqual([next.requestId]);
  // A fresh scanner is still backed off; no in-memory timer or process lifetime involved.
  expect((await new PostgresDeliveryScan(db.pool).page(null, end, 100)).map(r => r.requestId)).not.toContain(first.requestId);
  await db.pool.query("UPDATE workflow_delivery SET checked_at=clock_timestamp()-interval '61 minutes' WHERE request_id=$1", [first.requestId]);
  expect((await scan.page(null, end, 100)).map(r => r.requestId)).toContain(first.requestId);
  expect((await db.pool.query("SELECT 1 FROM source_submission_guard WHERE request_id=$1", [first.requestId])).rowCount).toBe(1);
});
