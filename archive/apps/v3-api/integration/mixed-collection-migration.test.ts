import { it, expect } from "vitest";
import { startTestDatabase } from "./postgres.js";
import { loadMigrations, migrate } from "../src/bootstrap/schema.js";
import { backup } from "../src/bootstrap/backup.js";
import { mixedFixture } from "../../../packages/v3-product/src/mixed.fixture.js";
import { CollectMixedProduct, PostgresMixedCollectedProducts } from "../../../packages/v3-product/src/mixed-collection.js";
it("009 preserves an existing /1 SQL snapshot, admits /2, and retains shared uniqueness and immutability", async () => {
  const db = await startTestDatabase({ tcp: true, empty: true }), client = await db.pool.connect(), migrations = await loadMigrations();
  try {
    await migrate(client, migrations.slice(0, 8));
    // Deliberately minimal SQL-level fixture; application schema behavior is tested in product tests.
    const old = { schemaVersion: 1, codec: "collected-product/1", operationId: "prior-image", observation: { observationId: "prior-observation" }, formula: {}, ingredients: [{}], assembly: {} };
    const insert = (id: string, obs: string, record: unknown) => client.query("INSERT INTO collected_product(operation_id,observation_id,record_hash,record) VALUES($1,$2,$3,$4::jsonb)", [id, obs, "a".repeat(64), JSON.stringify(record)]);
    await insert(old.operationId, old.observation.observationId, old);
    await expect(insert("new-mixed", "new-observation", { ...old, schemaVersion: 2, codec: "collected-product/2", operationId: "new-mixed", observation: { observationId: "new-observation" } })).rejects.toThrow();
    const url = new URL(db.databaseUrl!);
    await migrate(client, migrations, () => backup({ host: url.hostname, port: Number(url.port), user: url.username, password: url.password, database: url.pathname.slice(1) }, db.root));
    expect((await client.query("SELECT record FROM collected_product WHERE operation_id='prior-image'")).rows[0].record).toEqual(old);
    const f = await mixedFixture(), signal = new AbortController().signal, ready = await f.service.run(f.join, signal);
    if (ready.status !== "ready") throw Error("fixture not ready");
    const registry = new PostgresMixedCollectedProducts(db.pool);
    const service = new CollectMixedProduct({ assembly: f.service, registry, local: f.local, remote: f.remote, reviews: f.reviews });
    expect(await service.run({ join: f.join, evidenceKey: ready.evidenceKey }, signal)).toMatchObject({ status: "collected" });
    const record = (await registry.read(f.join.manifest.operationId))!;
    await expect(registry.append({ ...record, operationId: "other-operation" })).rejects.toThrow("RESULT_CONFLICT");
    await expect(insert("cross-codec", "prior-observation", { ...old, schemaVersion: 2, codec: "collected-product/2", operationId: "cross-codec" })).rejects.toThrow("unique");
    await expect(insert("bad-version", "bad-observation", { ...old, operationId: "bad-version", schemaVersion: 1, codec: "collected-product/2", observation: { observationId: "bad-observation" } })).rejects.toThrow();
    await expect(client.query("DELETE FROM collected_product WHERE operation_id='prior-image'")).rejects.toThrow("cannot be modified");
    expect((await client.query("SELECT count(*) FROM collected_product")).rows[0].count).toBe("2");
  } finally { client.release(); await db.close(); }
}, 30000);
