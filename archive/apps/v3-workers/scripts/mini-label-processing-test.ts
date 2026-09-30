// Isolated real PostgreSQL regression; no Temporal, R2 or model execution.
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import pg from "pg";
import { VisionRecordSchema } from "@crawl-automation/v3-contracts";
import { PostgresVisionRegistry, assertLabelVisionRegistrySchema } from "@crawl-automation/v3-vision";
import { PostgresResultRegistry } from "@crawl-automation/v3-results";

assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.equal(process.argv[2], "--isolated-postgres");
const root = await mkdtemp("/Users/barry/apps/crawlv3-label-schema."), container = `v3-label-schema-${randomUUID().slice(0, 8)}`;
const exec = promisify(execFile), password = randomUUID(), proof: Record<string, unknown> = { root, container, modelCalls: 0, r2Calls: 0 };
let db: pg.Pool | undefined, started = false;
try {
  const live = "/Users/barry/apps/crawlv3-gnc-saved.jWzJ3X/live";
  const vision = VisionRecordSchema.parse(JSON.parse(await readFile(join(live, "codex-vision/evidence/v3/vision/gncl-85d3ab0dd3824282fc1caeb2d1639ea5cdfce88200a1704ddd1c7b128cec09d2/registration.json"), "utf8")));
  const historical = JSON.parse(await readFile(join(live, "database-evidence.json"), "utf8")).results[0].record;
  const envFile = join(root, "postgres.env");
  await writeFile(envFile, `POSTGRES_USER=tester\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`, { mode: 0o600, flag: "wx" });
  await exec("docker", ["run", "-d", "--name", container, "--env-file", envFile, "--publish", "127.0.0.1::5432", "postgres:18"]);
  started = true;
  const port = Number((await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1)); assert.ok(port > 0);
  db = new pg.Pool({ host: "127.0.0.1", port, user: "tester", password, database: "crawler_v3_test", connectionTimeoutMillis: 1000 });
  const deadline = Date.now() + 30000;
  while (true) { try { await db.query("SELECT 1"); break; } catch { if (Date.now() > deadline) throw Error("DATABASE_START_TIMEOUT"); await new Promise(r => setTimeout(r, 250)); } }
  await db.query(await readFile(new URL("./migrations/006_processing_results.sql", import.meta.url), "utf8"));
  const registry = new PostgresVisionRegistry(db), ocr = new PostgresResultRegistry(db);
  await ocr.register(historical);
  await assert.rejects(assertLabelVisionRegistrySchema(db), /VISION.SCHEMA_MIGRATION_REQUIRED/);
  await assert.rejects(registry.register(vision), { code: "23514", constraint: "processing_result_record_check1" });
  proof.reproducedOldConstraint = true;
  await db.query(await readFile(new URL("./migrations/011_label_processing_results.sql", import.meta.url), "utf8"));
  await assertLabelVisionRegistrySchema(db); proof.startupSchemaGuardPassed = true;
  await registry.register(vision); await registry.register(vision);
  assert.deepEqual(await registry.read(vision.input.operationId), vision);
  assert.deepEqual(await ocr.read(historical.input.operationId), historical);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_result")).rows[0].n), 2);
  proof.realVisionV2Registered = true; proof.legacyOcrPreserved = true; proof.duplicateInsertIdempotent = true;
  for (const variant of [{ schemaVersion: 3 }, { codec: "unknown/2" }, { input: { ...vision.input, extractionProtocol: "unknown/1" } }]) {
    const invalid = { ...vision, ...variant };
    await assert.rejects(db.query("INSERT INTO processing_result(operation_id,record_hash,record) VALUES($1,$2,$3::jsonb)",
      [vision.input.operationId, "a".repeat(64), JSON.stringify(invalid)]), { code: "23514", constraint: "processing_result_codec" });
  }
  proof.invalidCodecsRejected = 3;
  await assert.rejects(db.query("UPDATE processing_result SET record=record"), { code: "23514" });
  await assert.rejects(db.query("DELETE FROM processing_result"), { code: "23514" });
  proof.immutableUpdateDeleteRejected = true; proof.status = "passed";
} finally {
  await db?.end(); if (started) { await exec("docker", ["stop", "--time", "10", container]); proof.databaseStoppedRetained = true; }
  await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" }); console.log(JSON.stringify(proof));
}
