import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "crawler-v3-schema-"));
const data = join(root, "data"), socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
// Never inherit connection targets, service files or password files from the old system.
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
const options = { env, timeout: 30000, maxBuffer: 1024 * 1024 };
let started = false;
let assertions = 0;
const clientArgs = ["-X", "-w", "-h", socket, "-p", "55439", "-U", "v3_schema_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
async function sql(statement) {
  return (await exec("psql", [...clientArgs, "-c", statement], options)).stdout.trim();
}
async function reject(statement, constraint) {
  await assert.rejects(sql(statement), error => error instanceof Error && error.message.includes(constraint));
  assertions++;
}
function equal(actual, expected) { assert.equal(actual, expected); assertions++; }
try {
  await exec("initdb", ["-D", data, "--username=v3_schema_test", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"], options);
  // Private Unix socket only. No TCP listener, no existing PostgreSQL instance.
  await exec("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o", `-h '' -k '${socket}' -p 55439`, "-w", "start"], options);
  started = true;
  const ddl = await readFile(new URL("./001_brand_sources.sql", import.meta.url), "utf8");
  await sql(ddl);
  equal(await sql("SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public'"), "brand,brand_source");

  // One synthetic Brand with two entries on the same channel, plus a DTC entry.
  const id = "10000000-0000-4000-8000-000000000001";
  await sql(`INSERT INTO brand(id,name) VALUES ('${id}','V3 Sample Brand')`);
  equal(await sql(`SELECT revision FROM brand WHERE id='${id}'`), "1");
  await reject("INSERT INTO brand(name) VALUES ('v3 sample brand')", "brand_name_unique");
  await reject("INSERT INTO brand(name) VALUES ('  ')", "brand_name_valid");
  await reject("INSERT INTO brand(name) VALUES (E'\\t')", "brand_name_valid");
  await sql(`INSERT INTO brand_source(brand_id,channel,url) VALUES
    ('${id}','amazon','https://amazon.example/store/a'),
    ('${id}','amazon','https://amazon.example/store/b'),
    ('${id}','dtc','https://brand.example/products')`);
  equal(await sql(`SELECT count(*) FROM brand_source WHERE brand_id='${id}'`), "3");
  equal(await sql("SELECT count(*) FROM brand_source WHERE enabled"), "0");
  await reject(`INSERT INTO brand_source(brand_id,channel,url) VALUES ('${id}','amazon','https://amazon.example/store/a')`, "brand_source_unique");
  await reject(`INSERT INTO brand_source(brand_id,channel,url) VALUES ('20000000-0000-4000-8000-000000000002','dtc','https://unknown.example/')`, "brand_source_brand_id_fkey");
  await reject(`INSERT INTO brand_source(brand_id,channel,url) VALUES ('${id}','other','https://brand.example/')`, "brand_source_channel_check");
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "https://user:secret@example.com/", "https://example.com/#label"]) {
    await reject(`INSERT INTO brand_source(brand_id,channel,url) VALUES ('${id}','dtc','${url}')`, "brand_source_url_shape");
  }
  await reject(`DELETE FROM brand WHERE id='${id}'`, "brand_source_brand_id_fkey");
  await reject(`UPDATE brand_source SET brand_id='20000000-0000-4000-8000-000000000002'`, "cannot be reassigned");
  await reject(`UPDATE brand SET id='20000000-0000-4000-8000-000000000002' WHERE id='${id}'`, "immutable");

  equal(await sql(`WITH changed AS (UPDATE brand SET note='first edit' WHERE id='${id}' AND revision=1 RETURNING revision) SELECT revision FROM changed`), "2");
  equal(await sql(`WITH changed AS (UPDATE brand SET note='stale edit' WHERE id='${id}' AND revision=1 RETURNING id) SELECT count(*) FROM changed`), "0");
  equal(await sql(`SELECT note FROM brand WHERE id='${id}'`), "first edit");
  equal(await sql(`WITH changed AS (UPDATE brand_source SET enabled=true WHERE url='https://brand.example/products' AND revision=1 RETURNING revision) SELECT revision FROM changed`), "2");
  await sql(`BEGIN; UPDATE brand SET note='rolled back' WHERE id='${id}'; ROLLBACK;`);
  equal(await sql(`SELECT note FROM brand WHERE id='${id}'`), "first edit");
  console.log(JSON.stringify({ passed: assertions, postgres: (await exec("postgres", ["--version"], options)).stdout.trim(), database: "fresh temporary cluster", sampleBrands: 1, evidenceDirectory: root }));
} finally {
  if (started) await exec("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], options);
  console.log(`Temporary database stopped; test evidence retained at ${root}`);
}
