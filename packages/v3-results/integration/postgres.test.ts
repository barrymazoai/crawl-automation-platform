import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startTestDatabase } from "../../../apps/v3-api/integration/postgres.js";
import { PostgresResultRegistry } from "../src/postgres.js";
import { prepare } from "../src/codec.js";
import { setup, signal } from "../src/testing.fixture.js";
let database: Awaited<ReturnType<typeof startTestDatabase>>, registry: PostgresResultRegistry;
beforeAll(async () => { database = await startTestDatabase(); registry = new PostgresResultRegistry(database.pool); });
afterAll(async () => { await database?.close(); });
describe("real isolated PostgreSQL immutable result registry", () => {
    it("concurrent duplicate registration yields one row and normalized JSON round-trips", async () => {
        const s = await setup(registry), record = await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        await Promise.all(Array.from({ length: 8 }, () => s.handoff.register(s.input, signal())));
        expect(await registry.read(s.input.operationId)).toEqual(record);
        expect((await database.pool.query("SELECT count(*) FROM processing_result WHERE operation_id=$1", [s.input.operationId])).rows[0].count).toBe("1");
    });
    it("different result for same operation conflicts without overwriting", async () => {
        const s = await setup(registry), p = prepare(s.input, s.output, "fixture-r2/1"), other = prepare(s.input, { ...s.output, text: "different" }, "fixture-r2/1");
        await registry.register(p.record);
        await expect(registry.register(other.record)).rejects.toMatchObject({ code: "RESULT.CONFLICT" });
        expect(await registry.read(s.input.operationId)).toEqual(p.record);
    });
    it("lost acknowledgement after real commit is confirmed by inspect with no new INSERT", async () => {
        let inserts = 0;
        const lost = { read: (id: string) => registry.read(id), register: async (record: Parameters<typeof registry.register>[0]) => { inserts++; await registry.register(record); throw Error("transport response lost"); } };
        const s = await setup(lost);
        await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        await expect(s.handoff.register(s.input, signal())).rejects.toMatchObject({ code: "RESULT.REGISTRATION_UNKNOWN" });
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ resultRegistered: true });
        await s.handoff.register(s.input, signal());
        expect(inserts).toBe(1);
    });
    it("database refuses UPDATE and DELETE of completed registration", async () => {
        const s = await setup(registry);
        const p = prepare(s.input, s.output, "fixture-r2/1");
        await registry.register(p.record);
        await expect(database.pool.query("UPDATE processing_result SET record_hash=$2 WHERE operation_id=$1", [s.input.operationId, "0".repeat(64)])).rejects.toThrow("cannot be modified");
        await expect(database.pool.query("DELETE FROM processing_result WHERE operation_id=$1", [s.input.operationId])).rejects.toThrow("cannot be modified");
    });
    it("read-only DB transaction can inspect durable facts without mutation", async () => {
        const s = await setup(registry);
        const p = prepare(s.input, s.output, "fixture-r2/1");
        await registry.register(p.record);
        const client = await database.pool.connect();
        try {
            await client.query("BEGIN READ ONLY");
            expect(await new PostgresResultRegistry(client).read(s.input.operationId)).toEqual(p.record);
        }
        finally {
            await client.query("ROLLBACK");
            client.release();
        }
    });
    it("malformed or tampered stored receipt cannot be accepted as a success", async () => {
        const s = await setup(registry), p = prepare(s.input, s.output, "fixture-r2/1");
        await database.pool.query("INSERT INTO processing_result(operation_id,record_hash,record) VALUES ($1,$2,$3)", [s.input.operationId, "0".repeat(64), JSON.stringify(p.record)]);
        await expect(registry.read(s.input.operationId)).rejects.toMatchObject({ code: "RESULT.INTEGRITY" });
    });
});
