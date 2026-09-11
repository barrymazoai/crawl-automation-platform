import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CollectionSubmission, CollectionWorkflowInput } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "./postgres.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";
import { PostgresDeliveryScan } from "../src/storage/postgres-delivery-scan.js";
import { DeliveryRunner } from "../src/delivery/runner.js";
import { DeliveryCoordinator } from "../src/delivery/coordinator.js";
import { inputHash, workflowInput } from "../src/delivery/identity.js";
import { InspectionError, type ExecutionProof } from "../src/delivery/port.js";

let db: Awaited<ReturnType<typeof startTestDatabase>>;
let brands: PostgresBrands; let submissions: PostgresSubmissions; let journal: PostgresDelivery;
beforeAll(async () => {
  db = await startTestDatabase(); brands = new PostgresBrands(db.pool);
  submissions = new PostgresSubmissions(db.pool); journal = new PostgresDelivery(db.pool);
});
afterAll(async () => { if (db) await db.close(); });
async function fixture() {
  const brand = (await brands.create({ name: `Runner ${randomUUID()}`, note: "" }, randomUUID())).value;
  const source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://synthetic.example/products" }, randomUUID())).value;
  await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
  return (await submissions.accept(brand.id, source.id, { sourceRevision: 2 }, randomUUID())).value;
}
describe("real PostgreSQL bounded delivery scanning", () => {
  it("preserves microsecond keyset positions and excludes later arrivals from a fixed sweep", async () => {
    const expected = await Promise.all(Array.from({ length: 7 }, fixture));
    const scan = new PostgresDeliveryScan(db.pool); const end = (await scan.upperBound())!;
    const later = await fixture();
    let after = null; const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rows = await scan.page(after, end, 2);
      expect(rows.length).toBeLessThanOrEqual(2);
      if (!rows.length) break;
      expect(rows[0]!.createdAt).toMatch(/\.\d{6}Z$/);
      ids.push(...rows.map(r => r.requestId)); after = rows.at(-1)!;
    }
    expect(new Set(ids)).toEqual(new Set(expected.map(s => s.requestId)));
    expect(ids).not.toContain(later.requestId);
    await expect(scan.page(null, end, 101)).rejects.toThrow();
  });
  it("multiple readers and restart preserve one-shot intents; poison requests do not starve later ones", async () => {
    const accepted = await Promise.all(Array.from({ length: 5 }, fixture));
    const target = { clusterId: "runner-test", namespace: "test", taskQueue: "probe", workflowType: "Probe" };
    const starts = new Map<string, number>(); const proofs = new Map<string, ExecutionProof>();
    const unknown = accepted[0]!; const mismatch = accepted[1]!;
    await journal.begin(unknown.requestId, target, inputHash(workflowInput(unknown)));
    await journal.begin(mismatch.requestId, { ...target, namespace: "other" }, inputHash(workflowInput(mismatch)));
    const gateway = { target,
      start: async (s: CollectionSubmission, input: CollectionWorkflowInput) => {
        starts.set(s.requestId, (starts.get(s.requestId) ?? 0) + 1);
        proofs.set(s.requestId, { runId: randomUUID(), inputHash: inputHash(input), status: "COMPLETED", continued: false, terminalEventId: "9", closedAt: new Date().toISOString() });
        throw new Error("Injected lost successful Start response");
      },
      inspect: async (s: CollectionSubmission) => {
        const proof = proofs.get(s.requestId); if (!proof) throw new InspectionError("NOT_FOUND"); return proof;
      },
    };
    const make = () => new DeliveryRunner(new PostgresDeliveryScan(db.pool), new DeliveryCoordinator(submissions, journal, gateway),
      { batchSize: 2, concurrency: 2, intervalMs: 100 }, async () => false, () => {});
    const a = make(), b = make(); const signal = new AbortController().signal;
    for (let i = 0; i < 15; i++) await Promise.all([a.tick(signal), b.tick(signal)]);
    await make().tick(signal); // Fresh process-equivalent scan; same durable journal.
    expect(starts.has(unknown.requestId)).toBe(false); expect(starts.has(mismatch.requestId)).toBe(false);
    expect((await journal.get(unknown.requestId))?.lastIssue).toBe("NOT_FOUND");
    for (const s of accepted.slice(2)) {
      expect(starts.get(s.requestId)).toBe(1);
      expect((await journal.get(s.requestId))?.state).toBe("CLOSED");
      expect((await db.pool.query("SELECT 1 FROM source_submission_guard WHERE request_id=$1", [s.requestId])).rowCount).toBe(0);
    }
    expect([...starts.values()].every(n => n === 1)).toBe(true);
    const scan = new PostgresDeliveryScan(db.pool); const rows = await scan.page(null, (await scan.upperBound())!, 100);
    expect(new Set(rows.map(r => r.requestId))).toEqual(new Set([unknown.requestId, mismatch.requestId]));
  });
});
