import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { CollectionSubmission, CollectionWorkflowInput, DeliveryTarget } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "./postgres.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import { inputHash, workflowInput } from "../src/delivery/identity.js";
import { InspectionError, type ExecutionProof, type WorkflowGateway } from "../src/delivery/port.js";
import { createApp } from "../src/http/app.js";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
let brands: PostgresBrands;
let submissions: PostgresSubmissions;
let journal: PostgresDelivery;
beforeAll(async () => {
  db = await startTestDatabase();
  brands = new PostgresBrands(db.pool);
  submissions = new PostgresSubmissions(db.pool);
  journal = new PostgresDelivery(db.pool);
});
afterAll(async () => { if (db) await db.close(); });
const target: DeliveryTarget = { clusterId: "isolated-test", namespace: "test", workflowType: "Probe", taskQueue: "test-probe" };
class FakeGateway implements WorkflowGateway {
  target = target;
  starts = 0;
  proof: ExecutionProof | null = null;
  lostResponse = false;
  unavailable = false;
  async start(_s: CollectionSubmission, input: CollectionWorkflowInput) {
    this.starts++;
    this.proof = { runId: randomUUID(), inputHash: inputHash(input), status: "RUNNING", continued: false, terminalEventId: null, closedAt: null };
    if (this.lostResponse) throw new Error("Injected lost Start response");
  }
  async inspect() {
    if (this.unavailable) throw new InspectionError("UNAVAILABLE");
    if (!this.proof) throw new InspectionError("NOT_FOUND");
    return this.proof;
  }
  finish() {
    if (!this.proof) throw new Error("No run");
    this.proof = { ...this.proof, status: "COMPLETED", terminalEventId: "11", closedAt: new Date().toISOString() };
  }
}
async function fixture() {
  const brand = (await brands.create({ name: `Delivery ${randomUUID()}`, note: "" }, randomUUID())).value;
  const source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://sample.example/products" }, randomUUID())).value;
  await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
  const submission = (await submissions.accept(brand.id, source.id, { sourceRevision: 2 }, randomUUID())).value;
  const gateway = new FakeGateway();
  const coordinator = new DeliveryCoordinator(submissions, journal, gateway);
  return { brand, source, submission, gateway, coordinator };
}
async function guard(f: Awaited<ReturnType<typeof fixture>>) {
  return submissions.active(f.brand.id, f.source.id);
}

describe("delivery coordinator with real atomic PostgreSQL journal", () => {
  it("concurrent coordinators authorize at most one Start", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => new DeliveryCoordinator(submissions, journal, f.gateway).reconcile(f.submission.requestId)));
    expect(f.gateway.starts).toBe(1);
    expect((await f.coordinator.reconcile(f.submission.requestId)).state).toBe("CONFIRMED");
    expect(await guard(f)).not.toBeNull();
  });
  it("a lost Start response is recovered by matching history, not another Start", async () => {
    const f = await fixture(); f.gateway.lostResponse = true;
    expect((await f.coordinator.reconcile(f.submission.requestId)).state).toBe("CONFIRMED");
    await new DeliveryCoordinator(submissions, new PostgresDelivery(db.pool), f.gateway).reconcile(f.submission.requestId);
    expect(f.gateway.starts).toBe(1);
  });
  it("crash after durable intent but before Start stays unknown and retains the source", async () => {
    const f = await fixture();
    await journal.begin(f.submission.requestId, target, inputHash(workflowInput(f.submission)));
    for (let i = 0; i < 3; i++) {
      expect(await f.coordinator.reconcile(f.submission.requestId)).toMatchObject({ state: "START_UNKNOWN", lastIssue: "NOT_FOUND" });
    }
    expect(f.gateway.starts).toBe(0);
    expect(await guard(f)).not.toBeNull();
  });
  it("crash after remote Start but before DB confirmation reconciles the same run", async () => {
    const f = await fixture();
    const input = workflowInput(f.submission);
    await journal.begin(f.submission.requestId, target, inputHash(input));
    await f.gateway.start(f.submission, input);
    expect(await f.coordinator.reconcile(f.submission.requestId)).toMatchObject({ state: "CONFIRMED", runId: f.gateway.proof!.runId });
    expect(f.gateway.starts).toBe(1);
  });
  it("network failure and later NotFound never release or re-submit even after previous confirmation", async () => {
    const f = await fixture();
    await f.coordinator.reconcile(f.submission.requestId);
    f.gateway.unavailable = true;
    expect((await f.coordinator.reconcile(f.submission.requestId)).lastIssue).toBe("UNAVAILABLE");
    f.gateway.unavailable = false; f.gateway.proof = null;
    expect((await f.coordinator.reconcile(f.submission.requestId)).lastIssue).toBe("NOT_FOUND");
    expect(f.gateway.starts).toBe(1);
    expect(await guard(f)).not.toBeNull();
  });
  it("checks input hash, run identity and full-chain terminal evidence", async () => {
    for (const [change, issue] of [
      [{ inputHash: "0".repeat(64) }, "IDENTITY_MISMATCH"],
      [{ runId: randomUUID() }, "RUN_CHANGED"],
      [{ status: "CONTINUED_AS_NEW", continued: true }, "CHAIN_CONTINUED"],
      [{ status: "COMPLETED", terminalEventId: null }, "UNCONFIRMED_TERMINAL"],
    ] as const) {
      const f = await fixture();
      await f.coordinator.reconcile(f.submission.requestId);
      const original = f.gateway.proof!;
      f.gateway.proof = { ...original, ...change };
      expect((await f.coordinator.reconcile(f.submission.requestId)).lastIssue).toBe(issue);
      expect(await guard(f)).not.toBeNull();
    }
  });
  it("atomically records terminal proof and releases exactly that request, never a newer request", async () => {
    const f = await fixture();
    await f.coordinator.reconcile(f.submission.requestId);
    f.gateway.finish();
    const closed = await f.coordinator.reconcile(f.submission.requestId);
    expect(closed).toMatchObject({ state: "CLOSED", observedStatus: "COMPLETED", terminalEventId: "11", lastIssue: null });
    expect(await guard(f)).toBeNull();
    const next = (await submissions.accept(f.brand.id, f.source.id, { sourceRevision: 2 }, randomUUID())).value;
    expect(await journal.record(f.submission.requestId, "UNAVAILABLE")).toEqual(closed);
    expect(await f.coordinator.reconcile(f.submission.requestId)).toEqual(closed);
    expect((await guard(f))?.requestId).toBe(next.requestId);
    expect(f.gateway.starts).toBe(1);
    const replay = await submissions.accept(f.brand.id, f.source.id, { sourceRevision: 2 }, f.submission.requestId);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(f.submission);
  });
  it("rolls back terminal proof if releasing its guard fails, then safely retries only reconciliation", async () => {
    const f = await fixture();
    await f.coordinator.reconcile(f.submission.requestId); f.gateway.finish();
    await db.pool.query(`CREATE FUNCTION fail_release_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$;
      CREATE TRIGGER fail_release_test BEFORE DELETE ON source_submission_guard FOR EACH ROW EXECUTE FUNCTION fail_release_test()`);
    try {
      await expect(f.coordinator.reconcile(f.submission.requestId)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect((await journal.get(f.submission.requestId))?.closedAt).toBeNull();
      expect(await guard(f)).not.toBeNull();
    } finally {
      await db.pool.query("DROP TRIGGER fail_release_test ON source_submission_guard; DROP FUNCTION fail_release_test()");
    }
    expect((await f.coordinator.reconcile(f.submission.requestId)).state).toBe("CLOSED");
    expect(f.gateway.starts).toBe(1);
  });
  it("refuses changing the persisted target and protects intent/terminal facts in SQL", async () => {
    const f = await fixture(); await f.coordinator.reconcile(f.submission.requestId);
    f.gateway.target = { ...target, namespace: "other" };
    await expect(f.coordinator.reconcile(f.submission.requestId)).rejects.toMatchObject({ code: "DELIVERY_IDENTITY_CONFLICT" });
    await expect(db.pool.query("UPDATE workflow_delivery SET input_hash=$2 WHERE request_id=$1", [f.submission.requestId, "f".repeat(64)])).rejects.toMatchObject({ code: "23514" });
    expect(f.gateway.starts).toBe(1);
  });
  it("provides authenticated read-only delivery status without starting work", async () => {
    const f = await fixture();
    const token = "delivery-query-test-not-production-secret";
    const app = createApp(brands, token, { submissions, delivery: journal });
    const path = `/api/v3/submissions/${f.submission.requestId}/delivery`;
    expect((await app.request(path)).status).toBe(401);
    expect(await (await app.request(path, { headers: { Authorization: `Bearer ${token}` } })).json()).toEqual({ item: null });
    const receipt = await f.coordinator.reconcile(f.submission.requestId);
    expect(await (await app.request(path, { headers: { Authorization: `Bearer ${token}` } })).json()).toEqual({ item: receipt });
    expect(f.gateway.starts).toBe(1);
  });
  it("latches identity/chain isolation across later matching terminal evidence and transient errors", async () => {
    for (const issue of ["IDENTITY_MISMATCH", "RUN_CHANGED", "CHAIN_CONTINUED"] as const) {
      const f = await fixture(); await f.coordinator.reconcile(f.submission.requestId);
      await journal.record(f.submission.requestId, issue);
      f.gateway.finish();
      for (const next of ["UNAVAILABLE", "NOT_FOUND", f.gateway.proof!] as const) {
        expect((await new PostgresDelivery(db.pool).record(f.submission.requestId, next)).lastIssue).toBe(issue);
      }
      expect((await f.coordinator.reconcile(f.submission.requestId)).state).toBe("CONFIRMED");
      expect(await guard(f)).not.toBeNull(); expect(f.gateway.starts).toBe(1);
    }
  });
});
