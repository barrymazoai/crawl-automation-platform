/** Prepared recovery ONLY. Requires explicit approval to persist the Web manifest change. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
assert.equal(process.argv[2], "--approved-web-compatibility-upgrade");
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const root = "/Users/barry/apps/crawlv3-batch-a.UiA4dx";
const dir = root + "/live/swanson-mainflow-20260910/release-swanson-mainflow-20260910-v2";
const manifestPath = root + "/live/deployment.json";
const previous = await fs.readFile(manifestPath), manifest = JSON.parse(previous);
const ready = JSON.parse(await fs.readFile(dir + "/ready.json", "utf8"));
const oldWeb = JSON.parse(await fs.readFile(root + "/live/web.json", "utf8"));
const require = createRequire(root + "/package.json"), pg = require("pg");
const db = new pg.Pool({ connectionString: manifest.database.connectionString, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 5000, statement_timeout: 5000 });
try {
  for (const sql of ["SELECT count(*)::int n FROM source_submission_guard", "SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL"])
    assert.equal((await db.query(sql)).rows[0].n, 0);
  const source = (await db.query("SELECT enabled,revision FROM brand_source WHERE id=$1", [ready.scope.sourceId])).rows[0];
  assert.deepEqual(source, { enabled: false, revision: 3 });
} finally { await db.end(); }
const job = manifest.jobs.find(j => j.id === "brand-web");
assert.equal(manifest.jobs.length, 32);
assert.equal(job.entry, root + "/release-resource-recovery-20260909/brand-web.js");
assert.ok((await fs.stat(ready.release + "/brand-web.js")).isFile());
const revisedWeb = { ...oldWeb, delivery: { ...oldWeb.delivery, channelTargets: { gnc: oldWeb.delivery.target, swanson: ready.target } } };
async function retain(path, bytes) {
  try { await fs.writeFile(path, bytes, { mode: 0o600, flag: "wx" }); }
  catch (e) { if (e.code !== "EEXIST") throw e; assert.deepEqual(await fs.readFile(path), Buffer.from(bytes)); }
}
await retain(dir + "/original-manifest-before-web-upgrade.json", previous);
await retain(dir + "/restored-web.private.json", JSON.stringify(revisedWeb));
job.entry = ready.release + "/brand-web.js";
job.env.V3_BRAND_WEB_CONFIG = dir + "/restored-web.private.json";
await retain(dir + "/restored-deployment.json", JSON.stringify(manifest));
const label = `gui/${process.getuid()}/com.crawlv3.batch-a`, exec = promisify(execFile);
await exec("/bin/launchctl", ["kill", "SIGTERM", label]);
let stopped = false;
for (let i = 0; i < 160; i++) {
  try { await fs.stat(root + "/supervisor.lock"); }
  catch (e) { if (e.code === "ENOENT") { stopped = true; break; } throw e; }
  await new Promise(r => setTimeout(r, 250));
}
assert.ok(stopped, "Deployment stop must be verified before manifest replacement");
await fs.writeFile(manifestPath + ".swanson-next", JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
await fs.rename(manifestPath + ".swanson-next", manifestPath);
await exec("/bin/launchctl", ["kickstart", label]);
console.log(JSON.stringify({ webCompatibilityUpgradeStarted: true, port: 4188, originalBusinessWorkersUnchanged: 31, swansonSourceEnabled: false }));
