/** Explicit, drained deployment upgrade. Never resumes a Review or launches work. */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, rename, lstat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname, basename, relative } from "node:path";
import { hostname } from "node:os";
import pg from "pg";
import { artifactBuildId } from "@crawl-automation/v3-worker-runtime";
import { DeploymentSchema } from "../src/deployment-supervisor.js";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { BrandPipelineConfig } from "../src/brand-pipeline.js";

const [manifestPath, release] = process.argv.slice(2);
const policyFlag = process.argv[4];
assert.ok(policyFlag === undefined || policyFlag === "--image-first");
assert.ok(manifestPath && release);
const manifest = DeploymentSchema.parse(await readGncPrivateJson(manifestPath));
assert.equal(manifest.host, hostname());
assert.ok(relative(manifest.root, release).startsWith("release-"));
await assert.rejects(lstat(join(manifest.root, "supervisor.lock")), { code: "ENOENT" });
for (const job of manifest.jobs) {
  const health = JSON.parse(await readFile(join(manifest.root, `${job.id}.health.json`), "utf8"));
  assert.throws(() => process.kill(health.pid, 0), { code: "ESRCH" });
}
const db = new pg.Pool({ connectionString: manifest.database.connectionString,
  ssl: manifest.database.tls ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
try {
  for (const sql of ["SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL", "SELECT count(*)::int n FROM source_submission_guard"])
    assert.equal((await db.query(sql)).rows[0].n, 0, "Deployment must be drained");
  const files = (await readdir(release)).filter(f => f.endsWith(".js")).sort().map(f => join(release, f));
  const activity = await artifactBuildId(files), workflow = await artifactBuildId([...files, join(release, "product-workflows.cjs")].sort());
  const revision = join(dirname(manifestPath), `revision-${randomUUID()}`);
  await mkdir(revision, { mode: 0o700 });
  await writeFile(join(revision, "previous-deployment.json"), await readFile(manifestPath), { mode: 0o600, flag: "wx" });
  const policies = new Map<string, string>();
  for (const job of manifest.jobs) {
    job.entry = join(release, basename(job.entry));
    assert.ok((await lstat(job.entry)).isFile());
    const policyPath = job.env.V3_BRAND_PIPELINE_CONFIG;
    if (policyFlag && policyPath) {
      if (!policies.has(policyPath)) {
        const policy = BrandPipelineConfig.parse(await readGncPrivateJson(policyPath));
        policy.policy.evidencePolicy = "label-image-first/1";
        const next = join(revision, `brand-policy-${policies.size}.json`);
        await writeFile(next, JSON.stringify(BrandPipelineConfig.parse(policy)), { mode: 0o600, flag: "wx" });
        policies.set(policyPath, next);
      }
      job.env.V3_BRAND_PIPELINE_CONFIG = policies.get(policyPath)!;
    }
    const old = job.env.V3_WORKER_CONFIG;
    if (!old) continue;
    const runtime = await readGncPrivateJson(old) as Record<string, unknown>;
    runtime.expectedBuildId = job.entry.endsWith("/product-workflow-worker.js") ? workflow : activity;
    const next = join(revision, `${job.id}.json`);
    await writeFile(next, JSON.stringify(runtime), { mode: 0o600, flag: "wx" });
    job.env.V3_WORKER_CONFIG = next;
  }
  if (policyFlag) assert.ok(policies.size > 0, "No Brand policy found; refuse a silent no-op");
  // Old manifest remains usable until all new runtime files exist.
  const staged = join(revision, "deployment.json");
  await writeFile(staged, JSON.stringify(DeploymentSchema.parse(manifest)), { mode: 0o600, flag: "wx" });
  await rename(staged, manifestPath);
  console.log(JSON.stringify({ event: "STOPPED_DEPLOYMENT_UPGRADED", release, revision, activity, workflow, workers: manifest.jobs.length,
    ...(policyFlag ? { evidencePolicy: "label-image-first/1", policyFiles: policies.size } : {}) }));
} finally { await db.end(); }
