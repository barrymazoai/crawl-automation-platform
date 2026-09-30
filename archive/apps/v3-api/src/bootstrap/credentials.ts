import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type pg from "pg";
import { assertSchemaReady } from "./schema.js";

// Dedicated runtime identities; never rotate/adopt existing global roles implicitly.
export async function provisionCredentials(db: pg.PoolClient, parent: string) {
  if (!isAbsolute(parent)) throw new Error("Absolute private credential parent required");
  await assertSchemaReady(db);
  const dir = await mkdtemp(join(parent, "v3-credentials-"));
  await chmod(dir, 0o700);
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL password_encryption='scram-sha-256'");
    for (const role of ["v3_api", "v3_delivery", "v3_review", "v3_result", "v3_review_writer", "v3_collection"]) {
      const password = randomBytes(32).toString("hex");
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await db.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
      await writeFile(join(dir, `${role}.json`), JSON.stringify({ user: role, password }), { flag: "wx", mode: 0o600 });
    }
    await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT INSERT,UPDATE ON public.brand,public.brand_source TO v3_api;
      GRANT INSERT ON public.api_request_receipt,public.collection_submission,public.source_submission_guard TO v3_api;
      GRANT INSERT,UPDATE ON public.workflow_delivery TO v3_delivery;
      GRANT DELETE ON public.source_submission_guard TO v3_delivery;
      GRANT INSERT ON public.processing_result TO v3_result;
      GRANT INSERT ON public.review_record TO v3_review_writer;
      GRANT INSERT ON public.collected_product TO v3_collection;
      ALTER ROLE v3_review SET default_transaction_read_only=on`);
    await db.query("COMMIT");
    return dir;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
