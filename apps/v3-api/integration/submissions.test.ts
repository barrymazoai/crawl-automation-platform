import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { CollectionSubmission } from "@crawl-automation/v3-contracts";
import { createApp } from "../src/http/app.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { startTestDatabase } from "./postgres.js";

const token = "isolated-submission-test-not-a-production-secret";
let db: Awaited<ReturnType<typeof startTestDatabase>>;
let brands: PostgresBrands;
let submissions: PostgresSubmissions;
let app: ReturnType<typeof createApp>;
const makeApp = (enabled = true) => createApp(brands, token, { submissions, acceptSubmissions: enabled });
beforeAll(async () => {
  db = await startTestDatabase();
  brands = new PostgresBrands(db.pool);
  submissions = new PostgresSubmissions(db.pool);
  app = makeApp();
});
afterAll(async () => { if (db) await db.close(); });
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
async function fixture(enabled = true) {
  const brand = (await brands.create({ name: `Submission ${randomUUID()}`, note: "" }, randomUUID())).value;
  let source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://sample.example/products" }, randomUUID())).value;
  if (enabled) source = (await brands.toggleSource(brand.id, source.id, { enabled: true, revision: source.revision }, randomUUID())).value;
  return { brand, source, path: `/api/v3/brands/${brand.id}/sources/${source.id}/submissions` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function submit(f: Fixture, key = randomUUID(), input: unknown = { sourceRevision: f.source.revision }, target = app) {
  return target.request(f.path, { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify(input) });
}
async function counts(requestId: string) {
  return (await db.pool.query(
    `SELECT (SELECT count(*)::int FROM api_request_receipt WHERE request_id=$1) AS receipts,
     (SELECT count(*)::int FROM collection_submission WHERE request_id=$1) AS submissions,
     (SELECT count(*)::int FROM source_submission_guard WHERE request_id=$1) AS guards`, [requestId],
  )).rows[0];
}

describe("durable submission intake with real PostgreSQL", () => {
  it("exposes authenticated, explicit intake capabilities without guessing a Temporal UI", async () => {
    expect((await app.request("/api/v3/collection-capabilities")).status).toBe(401);
    expect(await (await makeApp(false).request("/api/v3/collection-capabilities", { headers })).json()).toEqual({
      submissionIntakeEnabled: false, environment: "local-v3", temporalUi: [],
    });
    expect(await (await app.request("/api/v3/collection-capabilities", { headers })).json()).toMatchObject({ submissionIntakeEnabled: true });
    expect(() => createApp(brands, token, { collectionUi: { environment: "local-v3", temporalUi: [{ clusterId: "bad", baseUrl: "https://user:password@example.com" }] } })).toThrow();
  });
  it("is disabled by default and unauthenticated requests cannot reach intake", async () => {
    const f = await fixture(), key = randomUUID();
    expect((await app.request(f.path, { method: "POST" })).status).toBe(401);
    const closed = createApp(brands, token, { submissions });
    const response = await submit(f, key, undefined, closed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SUBMISSIONS_DISABLED" } });
    expect(await counts(key)).toEqual({ receipts: 0, submissions: 0, guards: 0 });
    expect(await (await closed.request("/healthz")).json()).toMatchObject({ collectionEnabled: false, submissionIntakeEnabled: false });
  });
  it("accepts one request atomically, with a snapshot and a readback Location", async () => {
    const f = await fixture(), key = randomUUID();
    const response = await submit(f, key);
    expect(response.status).toBe(202);
    expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    const value = CollectionSubmission.parse(await response.json());
    expect(value).toMatchObject({ requestId: key, workflowId: `v3-collection-${key}`, state: "PENDING_DELIVERY",
      snapshot: { brandId: f.brand.id, brandName: f.brand.name, sourceId: f.source.id, sourceRevision: f.source.revision } });
    const read = await app.request(response.headers.get("Location")!, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(value);
    expect(await counts(key)).toEqual({ receipts: 1, submissions: 1, guards: 1 });
  });
  it("eight parallel clicks with the same key return one identical receipt", async () => {
    const f = await fixture(), key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(f, key)));
    expect(responses.map(r => r.status)).toEqual(Array(8).fill(202));
    expect(responses.filter(r => r.headers.get("Idempotency-Replayed") === "false")).toHaveLength(1);
    const values = await Promise.all(responses.map(r => r.json()));
    expect(values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
    expect(await counts(key)).toEqual({ receipts: 1, submissions: 1, guards: 1 });
  });
  it("different concurrent request IDs for one source admit exactly one and roll back losers", async () => {
    const f = await fixture(), keys = Array.from({ length: 8 }, () => randomUUID());
    const responses = await Promise.all(keys.map(key => submit(f, key)));
    expect(responses.filter(r => r.status === 202)).toHaveLength(1);
    expect(responses.filter(r => r.status === 409)).toHaveLength(7);
    for (const [index, response] of responses.entries()) {
      if (response.status === 409) {
        expect(await response.json()).toMatchObject({ error: { code: "SOURCE_BUSY" } });
        expect(await counts(keys[index]!)).toEqual({ receipts: 0, submissions: 0, guards: 0 });
      }
    }
  });
  it("allows independent sources of the same Brand to submit concurrently", async () => {
    const f = await fixture();
    const source = (await brands.createSource(f.brand.id, { channel: "amazon", region: "US", url: "https://www.amazon.com/stores/example" }, randomUUID())).value;
    const enabled = (await brands.toggleSource(f.brand.id, source.id, { enabled: true, revision: 1 }, randomUUID())).value;
    const other = { ...f, source: enabled, path: `/api/v3/brands/${f.brand.id}/sources/${source.id}/submissions` };
    expect((await Promise.all([submit(f), submit(other)])).map(r => r.status)).toEqual([202, 202]);
  });
  it("rejects disabled, stale and wrong-Brand sources without leaving receipts", async () => {
    const f = await fixture(false), key = randomUUID();
    expect(await (await submit(f, key)).json()).toMatchObject({ error: { code: "SOURCE_DISABLED" } });
    const source = (await brands.toggleSource(f.brand.id, f.source.id, { enabled: true, revision: 1 }, randomUUID())).value;
    expect(await (await submit(f, key)).json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const wrong = { ...f, source, path: f.path.replace(f.brand.id, randomUUID()) };
    expect((await submit(wrong, key)).status).toBe(404);
    expect(await counts(key)).toEqual({ receipts: 0, submissions: 0, guards: 0 });
  });
  it("recovers a discarded response after API reconstruction and freezes its original configuration", async () => {
    const f = await fixture(), key = randomUUID();
    await submit(f, key); // Simulate caller discarding/losing the successful response.
    const original = await submissions.get(key);
    await brands.update(f.brand.id, { name: `Renamed ${randomUUID()}`, note: "", revision: 1 }, randomUUID());
    let changed = (await brands.updateSource(f.brand.id, f.source.id, { channel: "dtc", region: "US", url: "https://changed.example/new", revision: f.source.revision }, randomUUID())).value;
    changed = (await brands.toggleSource(f.brand.id, f.source.id, { enabled: false, revision: changed.revision }, randomUUID())).value;
    const reconstructed = createApp(new PostgresBrands(db.pool), token, { submissions: new PostgresSubmissions(db.pool), acceptSubmissions: true });
    const replay = await submit(f, key, undefined, reconstructed);
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(original);
    expect((await submissions.active(f.brand.id, f.source.id))?.requestId).toBe(key);
    expect(original.snapshot.url).toBe("https://sample.example/products");
    expect(original.snapshot.brandName).toBe(f.brand.name);
    // Disable/enable is configuration, never a guard release or implicit cancellation.
    changed = (await brands.toggleSource(f.brand.id, f.source.id, { enabled: true, revision: changed.revision }, randomUUID())).value;
    expect(await (await submit({ ...f, source: changed })).json()).toMatchObject({ error: { code: "SOURCE_BUSY" } });
  });
  it("rejects changing input or operation under the same request ID", async () => {
    const f = await fixture(), key = randomUUID();
    await submit(f, key);
    expect(await (await submit(f, key, { sourceRevision: f.source.revision + 1 })).json()).toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
    const other = await fixture();
    expect(await (await submit(other, key)).json()).toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
    await expect(brands.create({ name: "Should not be inserted", note: "" }, key)).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    const brandKey = randomUUID();
    await brands.create({ name: `Reserved ${brandKey}`, note: "" }, brandKey);
    expect(await (await submit(other, brandKey)).json()).toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
  });
  it("rejects client-controlled execution fields, missing IDs and non-JSON input", async () => {
    const f = await fixture();
    expect((await submit(f, randomUUID(), { sourceRevision: 2, taskQueue: "another-worker" })).status).toBe(400);
    expect((await app.request(f.path, { method: "POST", headers, body: '{"sourceRevision":2}' })).status).toBe(400);
    expect((await app.request(f.path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": randomUUID() }, body: "{}" })).status).toBe(415);
  });
  it("waits for a concurrent source edit and rejects the now-stale revision", async () => {
    const f = await fixture(), key = randomUUID();
    const editor = await db.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await editor.query("BEGIN");
      await editor.query("UPDATE brand_source SET url='https://edited.example/products' WHERE id=$1", [f.source.id]);
      pending = submit(f, key);
      let observedWait = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const waiting = await db.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF s FOR SHARE OF b%'",
        );
        if (waiting.rowCount) { observedWait = true; break; }
        await delay(10);
      }
      expect(observedWait).toBe(true);
      await editor.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
      expect(await counts(key)).toEqual({ receipts: 0, submissions: 0, guards: 0 });
    } finally {
      await editor.query("ROLLBACK");
      editor.release();
      await pending;
    }
  });
  it("returns a scoped active receipt, distinguishing missing source and no accepted request", async () => {
    const f = await fixture();
    expect(await (await app.request(`${f.path}/active`, { headers })).json()).toEqual({ item: null });
    await submit(f);
    const response = await app.request(`${f.path}/active`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ item: { state: "PENDING_DELIVERY", snapshot: { sourceId: f.source.id } } });
    expect((await app.request(`${f.path.replace(f.brand.id, randomUUID())}/active`, { headers })).status).toBe(404);
    expect((await app.request(`/api/v3/submissions/${randomUUID()}`, { headers })).status).toBe(404);
  });
  it("rolls back receipt and snapshot if the final guard insert fails, then can retry the same ID", async () => {
    const f = await fixture(), key = randomUUID();
    await db.pool.query(`CREATE FUNCTION fail_guard_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$;
      CREATE TRIGGER fail_guard_test BEFORE INSERT ON source_submission_guard FOR EACH ROW EXECUTE FUNCTION fail_guard_test()`);
    try {
      expect((await submit(f, key)).status).toBe(500);
      expect(await counts(key)).toEqual({ receipts: 0, submissions: 0, guards: 0 });
    } finally {
      await db.pool.query("DROP TRIGGER fail_guard_test ON source_submission_guard; DROP FUNCTION fail_guard_test()");
    }
    expect((await submit(f, key)).status).toBe(202);
    expect(await counts(key)).toEqual({ receipts: 1, submissions: 1, guards: 1 });
  });
  it("the database rejects mutation of accepted snapshots and guards for the wrong source", async () => {
    const f = await fixture(), other = await fixture(), key = randomUUID();
    await submit(f, key);
    await expect(db.pool.query("UPDATE collection_submission SET snapshot='{}' WHERE request_id=$1", [key])).rejects.toMatchObject({ code: "23514" });
    // Use a real receipt to show the composite FK rejects mismatched ownership.
    await expect(db.pool.query("UPDATE source_submission_guard SET source_id=$2 WHERE request_id=$1", [key, other.source.id])).rejects.toMatchObject({ code: "23503" });
    expect((await submissions.get(key)).snapshot.sourceId).toBe(f.source.id);
  });
  it("exposes the same pending receipt over a real HTTP socket", async () => {
    const f = await fixture(), key = randomUUID();
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected local TCP listener");
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(base + f.path, { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ sourceRevision: f.source.revision }) });
      expect(response.status).toBe(202);
      const get = await fetch(base + response.headers.get("Location"), { headers });
      expect(await get.json()).toEqual(await response.json());
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
