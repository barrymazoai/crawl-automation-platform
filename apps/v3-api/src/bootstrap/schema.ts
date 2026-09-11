import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";

export const migrationNames = ["001_brand_sources.sql", "002_api_receipts.sql", "003_collection_submissions.sql", "004_workflow_delivery.sql", "005_delivery_scan.sql", "006_processing_results.sql", "007_review_records.sql", "008_collected_products.sql", "009_mixed_collected_products.sql", "010_label_collected_products.sql", "011_label_processing_results.sql", "012_packaging_collected_products.sql", "013_catalog_presence.sql", "014_catalog_product_input.sql", "015_resource_admission.sql", "016_visual_wire_v2.sql"];
export type Migration = { name: string; sha256: string; sql: string };
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export async function loadMigrations(): Promise<Migration[]> {
  // Both source and bundled entries live in this monorepo; SQL ships with it.
  const roots = [new URL("../../../../database/v3/", import.meta.url), new URL("../../../database/v3/", import.meta.url)];
  let root: URL | undefined;
  for (const candidate of roots) {
    try { await readFile(new URL(migrationNames[0]!, candidate)); root = candidate; break; } catch { /* try bundled path */ }
  }
  if (!root) throw new Error("V3 migration resources missing");
  return Promise.all(migrationNames.map(async name => {
    const sql = await readFile(new URL(name, root), "utf8");
    return { name, sql, sha256: digest(sql) };
  }));
}
type Query = Pick<pg.PoolClient, "query">;
export async function assertV3Database(db: Query) {
  const { rows } = await db.query("SELECT current_database() AS name");
  if (!["crawler_v3_dev", "crawler_v3_test"].includes(rows[0]?.name)) throw new Error("Not an explicit V3 business database");
}
export async function assertEmpty(db: Query) {
  const objects = await db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') LIMIT 1`);
  if (objects.rowCount) throw new Error("Target is not empty; refusing adoption/overwrite");
}
export async function schemaStatus(db: Query, migrations: Migration[]) {
  await assertV3Database(db);
  const marker = await db.query("SELECT to_regclass('public.v3_restore_hold') AS hold, to_regclass('public.v3_local_migration') AS ledger");
  if (marker.rows[0].hold) throw new Error("Restored database quarantined; delivery is forbidden");
  const rows: { name: string; sha256: string }[] = marker.rows[0].ledger
    ? (await db.query("SELECT name,sha256 FROM public.v3_local_migration ORDER BY name")).rows : [];
  if (!marker.rows[0].ledger) await assertEmpty(db);
  for (const [i, row] of rows.entries()) {
    if (row.name !== migrations[i]?.name || row.sha256 !== migrations[i]?.sha256) throw new Error("Unknown, reordered or changed V3 migration");
  }
  return { applied: rows.length, pending: migrations.slice(rows.length).map(m => m.name) };
}
export async function assertSchemaReady(db: Query) {
  const state = await schemaStatus(db, await loadMigrations());
  if (state.pending.length) throw new Error("Explicit V3 migration required before startup");
  // Ledger is not a complete schema diff: also check required columns and indexes.
  await db.query("SELECT id,name,note,revision,created_at,updated_at FROM public.brand LIMIT 0");
  await db.query("SELECT id,brand_id,channel,region,url,enabled,revision,created_at,updated_at FROM public.brand_source LIMIT 0");
  await db.query("SELECT request_id,operation,fingerprint,result,created_at FROM public.api_request_receipt LIMIT 0");
  await db.query("SELECT request_id,source_id,workflow_id,snapshot,created_at FROM public.collection_submission LIMIT 0");
  await db.query("SELECT source_id,request_id FROM public.source_submission_guard LIMIT 0");
  await db.query("SELECT request_id,target,input_hash,run_id,observed_status,last_issue,terminal_event_id,intent_at,checked_at,closed_at FROM public.workflow_delivery LIMIT 0");
  await db.query("SELECT operation_id,record_hash,record,registered_at FROM public.processing_result LIMIT 0");
  await db.query("SELECT review_id,record_hash,record,registered_at FROM public.review_record LIMIT 0");
  await db.query("SELECT operation_id,observation_id,record_hash,record,collected_at FROM public.collected_product LIMIT 0");
  await db.query("SELECT resource_id,capacity,healthy,health_until,reason,controller FROM public.resource_capacity LIMIT 0");
  await db.query("SELECT permit_id,request,released_at,granted_at FROM public.resource_permit LIMIT 0");
  await db.query("SELECT permit_id,resource_id,units FROM public.resource_permit_need LIMIT 0");
  for (const table of ["catalog_run", "catalog_page", "catalog_discovery", "catalog_dispatch", "catalog_closure", "presence_result", "observation_execution", "catalog_product_input"]) {
    await db.query(`SELECT * FROM public.${table} LIMIT 0`);
    const trigger = await db.query("SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND tgenabled IN ('O','A') AND NOT tgisinternal", [`public.${table}`, `${table}_immutable`]);
    if (!trigger.rowCount) throw new Error("Required catalog integrity trigger missing");
  }
  for (const name of ["review_record_request", "review_record_operation", "review_record_category"]) {
    const ready = await db.query("SELECT 1 FROM pg_index WHERE indexrelid=to_regclass($1) AND indisvalid", [`public.${name}`]);
    if (!ready.rowCount) throw new Error("Required review index missing");
  }
  const index = await db.query("SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.collection_submission_scan_order') AND indisvalid");
  if (!index.rowCount) throw new Error("Required scan index missing");
  const collectionIndex = await db.query("SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.collected_product_brand') AND indisvalid");
  if (!collectionIndex.rowCount) throw new Error("Required collection index missing");
  const triggers = await db.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    AND t.tgenabled IN ('O','A') AND (c.relname,t.tgname) IN
    (('brand','brand_touch'),('brand_source','brand_source_touch'),('collection_submission','collection_submission_immutable'),('workflow_delivery','workflow_delivery_identity'),('processing_result','processing_result_immutable'),('review_record','review_record_immutable'),('collected_product','collected_product_immutable'))`);
  if (triggers.rowCount !== 7) throw new Error("Required integrity trigger missing or disabled");
}
export async function migrate(db: pg.PoolClient, migrations: Migration[], beforeExisting?: () => Promise<unknown>) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(73110311)");
    const state = await schemaStatus(db, migrations);
    if (state.pending.length && state.applied) {
      if (!beforeExisting) throw new Error("Existing database migration requires a fresh backup");
      await beforeExisting();
    }
    if (!state.applied) await db.query("CREATE TABLE IF NOT EXISTS public.v3_local_migration (name text PRIMARY KEY, sha256 text NOT NULL)");
    for (const m of migrations.slice(state.applied)) {
      if (!/^[\s\S]*?\bBEGIN;/.test(m.sql) || !/COMMIT;\s*$/.test(m.sql) || digest(m.sql) !== m.sha256) throw new Error("Invalid transactional migration");
      await db.query(m.sql.replace(/\bBEGIN;/, "").replace(/COMMIT;\s*$/, ""));
      await db.query("INSERT INTO public.v3_local_migration VALUES ($1,$2)", [m.name, m.sha256]);
    }
    await db.query("COMMIT");
    return state;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
