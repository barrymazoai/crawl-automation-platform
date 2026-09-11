import { beforeAll, afterAll, it, expect } from "vitest";
import { startTestDatabase } from "../../../apps/v3-api/integration/postgres.js";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { TextLocalStore } from "../src/files.js";
import { TextHandoff, PostgresTextRegistry } from "../src/handoff.js";
import { TextModule } from "../src/module.js";
import { fixture, signal } from "../src/testing.fixture.js";
import { join } from "node:path";
let database: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => { database = await startTestDatabase(); });
afterAll(async () => { await database?.close(); });
async function setup() {
    const f = fixture(), registry = new PostgresTextRegistry(database.pool), reviews = new PostgresReviews(database.pool);
    const local = await TextLocalStore.open(join(database.root, f.input.operationId));
    const handoff = new TextHandoff(local, f.remote, registry, f.evidence, "fixture/1");
    return { ...f, registry, reviews, local, handoff, module: new TextModule({ ...f.deps, handoff, reviews }) };
}
it("persists and revalidates JSONB identities, with immutable SQL result rows", async () => {
    const f = await setup();
    const outcome = await f.module.run(f.input, signal());
    expect(outcome.status).toBe("registered");
    expect((await f.registry.read(f.input.operationId))?.input).toEqual(f.input);
    expect(await f.module.run(f.input, signal())).toEqual(outcome);
    expect(f.calls()).toBe(1);
    expect(await f.handoff.inspect(f.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: true });
    await expect(database.pool.query("UPDATE processing_result SET record=record WHERE operation_id=$1", [f.input.operationId])).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("DELETE FROM processing_result WHERE operation_id=$1", [f.input.operationId])).rejects.toMatchObject({ code: "23514" });
});
it("preserves invalid model output privately while public Review remains sanitized", async () => {
    const f = await setup();
    f.provider.interpret = async () => "private malformed model output";
    const outcome = await f.module.run(f.input, signal());
    expect(outcome.status).toBe("review");
    if (outcome.status !== "review")
        throw Error("expected review");
    const record = await f.reviews.read(outcome.reviewId);
    expect(record?.candidate?.value).toEqual({ rawResponse: "private malformed model output" });
    expect(JSON.stringify(await f.reviews.get(outcome.reviewId))).not.toContain("private malformed");
    expect(await f.registry.read(f.input.operationId)).toBeNull();
});
it("simulates a committed INSERT whose acknowledgement is lost; readback resolves it", async () => {
    const f = await setup();
    const registry = new PostgresTextRegistry(database.pool);
    const handoff = new TextHandoff(f.local, f.remote, { read: id => registry.read(id), register: async (record) => { await registry.register(record); throw Error("lost ack"); } }, f.evidence, "fixture/1");
    expect((await new TextModule({ ...f.deps, handoff, reviews: f.reviews }).run(f.input, signal())).status).toBe("registered");
    expect(f.calls()).toBe(1);
});
