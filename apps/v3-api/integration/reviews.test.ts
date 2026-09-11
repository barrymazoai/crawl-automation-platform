import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { PostgresReviews, ReviewInspector, digest, inspectRegistration } from "@crawl-automation/v3-review";
import { fixture } from "../../../packages/v3-review/src/testing.fixture.js";
import { startTestDatabase } from "./postgres.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery, PostgresDeliveryReader } from "../src/storage/postgres-delivery.js";
import { DeliveryReviewer } from "../src/delivery/reviewer.js";
import { inputHash, workflowInput } from "../src/delivery/identity.js";
import { createApp } from "../src/http/app.js";
import { setup as resultSetup, signal } from "../../../packages/v3-results/src/testing.fixture.js";
import { PostgresResultRegistry } from "../../../packages/v3-results/src/postgres.js";
import { observationIdentity } from "@crawl-automation/v3-contracts";
let db: Awaited<ReturnType<typeof startTestDatabase>>, reviews: PostgresReviews;
const token = "synthetic-review-test-token-".repeat(3);
beforeAll(async () => { db = await startTestDatabase(); reviews = new PostgresReviews(db.pool); });
afterAll(async () => { await db?.close(); });
const record = () => fixture(randomUUID());
const app = () => createApp(new PostgresBrands(db.pool), token, { reviews, reviewInspector: new ReviewInspector(reviews) });
function request(path: string, method = "GET", authorized = true) {
    return app().request(`/api/v3/reviews${path}`, { method, headers: authorized ? { authorization: `Bearer ${token}` } : {} });
}
describe.sequential("passive Review with real isolated PostgreSQL and authenticated HTTP", () => {
    it("concurrent identical append registers one immutable full record", async () => {
        const r = record();
        r.candidate!.value = { unicode: "完整营养成分", large: "x".repeat(40000), nested: [1, false, null, { z: "value" }] };
        const receipts = await Promise.all(Array.from({ length: 8 }, () => reviews.append(r)));
        expect(receipts.every(receipt => receipt.registered)).toBe(true);
        expect(await new PostgresReviews(db.pool).read(r.reviewId)).toEqual(r);
        expect((await db.pool.query("SELECT count(*) FROM review_record WHERE review_id=$1", [r.reviewId])).rows[0].count).toBe("1");
    });
    it("same ID with changed candidate conflicts; a different event for the same operation appends", async () => {
        const r = record();
        await reviews.append(r);
        await expect(reviews.append({ ...r, candidate: null })).rejects.toMatchObject({ code: "REVIEW.CONFLICT" });
        expect(await reviews.read(r.reviewId)).toEqual(r);
        const next = { ...r, reviewId: randomUUID() };
        await reviews.append(next);
        expect(await reviews.read(next.reviewId)).toEqual(next);
    });
    it("lost response after real commit does not report success; independent read proves registration without INSERT", async () => {
        const r = record();
        let inserts = 0;
        const query = async (sql: string, params: unknown[]) => {
            const result = await db.pool.query(sql, params);
            if (sql.startsWith("INSERT")) {
                inserts++;
                throw Error("lost acknowledgement after COMMIT");
            }
            return result;
        };
        const lost = new PostgresReviews({ query: query as pg.Pool["query"] });
        await expect(lost.append(r)).rejects.toMatchObject({ code: "REVIEW.REGISTRATION_UNKNOWN" });
        expect(await inspectRegistration(reviews, r)).toMatchObject({ registered: true, mutatesState: false });
        expect(inserts).toBe(1);
    });
    it("database outage and missing registration are never counted as success", async () => {
        const unavailable = new PostgresReviews({ query: (async () => { throw Error("private-connection-canary"); }) as pg.Pool["query"] });
        const r = record();
        await expect(unavailable.append(r)).rejects.toMatchObject({ code: "REVIEW.REGISTRATION_UNKNOWN" });
        await expect(unavailable.get(r.reviewId)).rejects.toMatchObject({ code: "REVIEW.UNAVAILABLE" });
        expect(await inspectRegistration(reviews, r)).toMatchObject({ registered: false });
        const response = await createApp(new PostgresBrands(db.pool), token, { reviews: unavailable }).request("/api/v3/reviews", { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("canary");
    });
    it("requires authentication, validates filters and offers no write/retry/delete route", async () => {
        const r = record();
        await reviews.append(r);
        for (const path of ["", "/summary", `/${r.reviewId}`, `/${r.reviewId}/inspection`])
            expect((await request(path, "GET", false)).status).toBe(401);
        for (const [path, method] of [["", "POST"], [`/${r.reviewId}`, "PATCH"], [`/${r.reviewId}`, "DELETE"], ["/retry-all", "POST"], [`/${r.reviewId}/retry`, "POST"]])
            expect((await request(path!, method!)).status).toBe(404);
        expect((await request("?limit=101")).status).toBe(400);
        expect((await request("?category=INVALID")).status).toBe(400);
        expect((await request("?unknown=1")).status).toBe(400);
        expect((await request("/missing")).status).toBe(404);
        expect((await request(`/${r.reviewId}/inspection`)).status).toBe(200);
        expect((await request(`/${r.reviewId}`)).headers.get("cache-control")).toBe("no-store");
    });
    it("detail/list retain classification and payload hashes without exposing raw error or full candidate bytes", async () => {
        const r = record();
        await reviews.append(r);
        const detail = await (await request(`/${r.reviewId}`)).json();
        expect(detail).toMatchObject({ failure: r.failure, candidate: { retained: true }, rawError: { retained: true }, recordHash: digest(r) });
        expect(JSON.stringify(detail)).not.toContain("canary");
        expect(JSON.stringify(detail)).not.toContain("Complete Formula");
        expect(await reviews.read(r.reviewId)).toEqual(r);
    });
    it("bounded keyset pagination and all filters work without modifying records", async () => {
        const requestId = randomUUID();
        for (let i = 0; i < 5; i++) {
            const r = record();
            r.failure.requestId = requestId;
            r.observation!.requestId = requestId;
            r.failure.executionFact = "not_executed";
            r.failure.blockedBy = "upstream-1";
            await reviews.append(r);
        }
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
            const q = new URLSearchParams({ requestId, limit: "2", category: "PROCESSING", code: "RESULT.REGISTRATION_UNKNOWN", stage: "ocr.file/register", operationId: "operation-001",
                executionFact: "not_executed", blockedBy: "upstream-1", brandId: "brand-001", sourceId: "source-001", ...(cursor ? { before: cursor } : {}) });
            const response = await request(`?${q}`);
            expect(response.status).toBe(200);
            const page = await response.json();
            ids.push(...page.items.map((item: {
                reviewId: string;
            }) => item.reviewId));
            cursor = page.nextCursor;
            expect(page.items.length).toBeLessThanOrEqual(2);
        } while (cursor);
        expect(ids.length).toBe(5);
        expect(new Set(ids).size).toBe(5);
        expect(ids).toEqual([...ids].sort().reverse());
        const summary = await (await request("/summary")).json();
        expect(summary.total).toBe(Number((await db.pool.query("SELECT count(*) FROM review_record")).rows[0].count));
    });
    it("actual DeliveryReviewer is read-only inside a READ ONLY transaction and never releases the source guard", async () => {
        const brands = new PostgresBrands(db.pool), submissions = new PostgresSubmissions(db.pool), journal = new PostgresDelivery(db.pool);
        const brand = (await brands.create({ name: `Review ${randomUUID()}`, note: "" }, randomUUID())).value;
        const source = (await brands.createSource(brand.id, { channel: "dtc", region: "US", url: "https://synthetic.example" }, randomUUID())).value;
        await brands.toggleSource(brand.id, source.id, { enabled: true, revision: 1 }, randomUUID());
        const submission = (await submissions.accept(brand.id, source.id, { sourceRevision: 2 }, randomUUID())).value;
        const target = { clusterId: "isolated", namespace: "test", taskQueue: "test", workflowType: "Probe" };
        await journal.begin(submission.requestId, target, inputHash(workflowInput(submission)));
        const r = record();
        r.observation = null;
        r.failure.requestId = submission.requestId;
        r.failure.stage = "workflow.delivery";
        r.failure.category = "SCHEDULER";
        r.failure.code = "SCHEDULER.DELIVERY_UNKNOWN";
        r.failure.executionFact = "unknown";
        r.inspection = { kind: "workflow-delivery", requestId: submission.requestId };
        await reviews.append(r);
        const before = await journal.get(submission.requestId), client = await db.pool.connect();
        let inspectCalls = 0;
        try {
            await client.query("BEGIN READ ONLY");
            const readStore = new PostgresReviews(client);
            const reviewer = new DeliveryReviewer({ get: id => submissions.get(id) }, new PostgresDeliveryReader(client), {
                target, inspect: async () => { inspectCalls++; throw Error("private-transport-canary"); },
            });
            const inspector = new ReviewInspector(readStore, { delivery: reviewer });
            for (let i = 0; i < 3; i++)
                expect(await inspector.inspect(r.reviewId)).toMatchObject({ status: "INSPECTED", delivery: { decision: "HOLD", hasIssue: true }, mutatesState: false });
            expect(await readStore.list({ limit: 1 })).toHaveProperty("items");
            await expect(readStore.append(record())).rejects.toMatchObject({ code: "REVIEW.REGISTRATION_UNKNOWN" });
        }
        finally {
            await client.query("ROLLBACK");
            client.release();
        }
        expect(inspectCalls).toBe(3);
        expect(await journal.get(submission.requestId)).toEqual(before);
        expect(await submissions.active(brand.id, source.id)).not.toBeNull();
    });
    it("actual OCR handoff inspection reads completion evidence without upload, registration or reprocessing", async () => {
        const s = await resultSetup(new PostgresResultRegistry(db.pool));
        const completed = await s.handoff.capture(s.input, s.output, signal());
        const r = record();
        r.observation = observationIdentity(s.input);
        r.failure = { ...r.failure, requestId: s.input.requestId, observationId: s.input.observationId,
            operationId: s.input.operationId, inputFingerprint: s.input.inputFingerprint, evidenceKey: completed.completion.objectKey };
        r.inspection = { kind: "ocr-result", input: s.input };
        r.candidate = { schema: "ocr-output/1", value: s.output };
        await reviews.append(r);
        const inspector = new ReviewInspector(reviews, { result: { inspect: (input, abort) => s.handoff.inspect(input, abort ?? signal()) } });
        const writes = s.remote.writes;
        for (let i = 0; i < 3; i++)
            expect(await inspector.inspect(r.reviewId)).toMatchObject({ status: "INSPECTED", result: { computedLocal: true, artifactDurable: false, resultRegistered: false }, mutatesState: false });
        expect(s.remote.writes).toBe(writes);
        expect(await new PostgresResultRegistry(db.pool).read(s.input.operationId)).toBeNull();
        expect(await reviews.read(r.reviewId)).toEqual(r);
    });
    it("database trigger prohibits update/delete, and corrupted journal hashes fail closed", async () => {
        const r = record();
        await reviews.append(r);
        await expect(db.pool.query("UPDATE review_record SET record_hash=$2 WHERE review_id=$1", [r.reviewId, "0".repeat(64)])).rejects.toThrow("cannot be modified");
        await expect(db.pool.query("DELETE FROM review_record WHERE review_id=$1", [r.reviewId])).rejects.toThrow("cannot be modified");
        const corrupted = record();
        await db.pool.query("INSERT INTO review_record(review_id,record_hash,record) VALUES($1,$2,$3)", [corrupted.reviewId, "0".repeat(64), JSON.stringify(corrupted)]);
        await expect(reviews.get(corrupted.reviewId)).rejects.toMatchObject({ code: "REVIEW.INTEGRITY" });
        expect((await request(`/${corrupted.reviewId}`)).status).toBe(500);
    });
});
