/** Drained Mini deployment only. Does not change business Worker binaries, task inputs, queues or data. */
import assert from "node:assert/strict";
import { readFile, writeFile, lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { DeploymentSchema } from "../src/deployment-supervisor.js";
import { readGncPrivateJson } from "../src/gnc-config.js";

const [root, release] = process.argv.slice(2);
assert.match(root!, /^\/Users\/barry\/apps\/crawlv3-batch-a\.[A-Za-z0-9]+$/);
assert.equal(release, join(root!, "release-health-control-20260909"));
const manifestPath = join(root!, "live/deployment.json"), m = DeploymentSchema.parse(await readGncPrivateJson(manifestPath));
assert.equal(m.host, hostname()); assert.equal(m.root, root);
await assert.rejects(lstat(join(root!, "supervisor.lock")), { code: "ENOENT" });
for (const j of m.jobs) {
  const h = JSON.parse(await readFile(join(root!, `${j.id}.health.json`), "utf8"));
  assert.throws(() => process.kill(h.pid, 0), { code: "ESRCH" });
}
assert.ok((await lstat(join(release!, "deployment-supervisor.js"))).isFile());
const jobConfig = async (id: string, key: string) => {
  const p = m.jobs.find(j => j.id === id)?.env[key]; assert.ok(p); return { path: p, value: await readGncPrivateJson(p) as any };
};
const ocr = await jobConfig("ocr-file", "V3_OCR_CONFIG"), text = await jobConfig("codex-text", "V3_TEXT_CONFIG"),
  vision = await jobConfig("codex-vision", "V3_VISION_CONFIG"), product = await jobConfig("product-core-collect", "V3_PRODUCT_CONFIG");
const db = new pg.Pool({ connectionString: m.database.connectionString, ssl: m.database.tls ? { rejectUnauthorized: true } : false,
  options: "-c default_transaction_read_only=on", statement_timeout: 5000, connectionTimeoutMillis: 5000 });
try {
  for (const sql of ["SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL", "SELECT count(*)::int n FROM source_submission_guard"])
    assert.equal((await db.query(sql)).rows[0].n, 0);
  const record = (await db.query("SELECT record FROM collected_product WHERE operation_id=$1", ["label-f1133d5eb3b0f91cb79629628ef20f431bd3a23c675a34b3dfe3eae00cc8517d"])).rows[0]?.record;
  assert.ok(record); const canary = record.provenance.find((p: any) => p.kind === "image").record.completion;
  const healthUrl = new URL("/health", ocr.value.provider.endpoint).href;
  m.dependencyProbes = [
    { id: "ocr-service", kind: "ocr-health", url: healthUrl, minHealthyBackends: 2 },
    { id: "r2-read", kind: "r2-read", configPath: product.path, objectKey: canary.objectKey, sha256: canary.sha256, byteSize: canary.byteSize },
    { id: "ocr-handoff", kind: "handoff-backlog", roots: [{ root: ocr.value.journalRoot, layout: "ocr" }], maxPending: 20, maxOldestSeconds: 3600, maxFiles: 10000 },
    { id: "model-handoff", kind: "handoff-backlog", roots: [{ root: text.value.textLocalRoot, layout: "text" }, { root: vision.value.visionLocalRoot, layout: "vision" }], maxPending: 20, maxOldestSeconds: 3600, maxFiles: 10000 },
  ];
  const dependencies: Record<string, string[]> = {
    "mini-ego-space-1": ["r2-read", "ocr-handoff", "model-handoff"],
    "mini-model-account": ["r2-read", "model-handoff"], "mini-cpu": ["r2-read", "model-handoff"],
    "windows-ocr": ["r2-read", "ocr-service", "ocr-handoff"],
  };
  assert.deepEqual(m.resources.map(r => r.resourceId).sort(), Object.keys(dependencies).sort());
  for (const r of m.resources) r.dependencies = dependencies[r.resourceId]!;
  for (const p of m.dependencyProbes) if (p.kind === "handoff-backlog") for (const r of p.roots) {
    const s = await lstat(r.root); assert.ok(s.isDirectory() && !s.isSymbolicLink());
  }
  const revision = join(root!, `live/health-revision-${randomUUID()}`); await mkdir(revision, { mode: 0o700 });
  const plist = "/Users/barry/Library/LaunchAgents/com.crawlv3.batch-a.plist", exec = promisify(execFile);
  const oldArgs = JSON.parse((await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist])).stdout);
  assert.equal(oldArgs.length, 3); assert.equal(oldArgs[2], manifestPath); assert.ok(oldArgs[1].startsWith(root! + "/release-"));
  await writeFile(join(revision, "previous-deployment.json"), await readFile(manifestPath), { mode: 0o600, flag: "wx" });
  await writeFile(join(revision, "previous-launchagent.plist"), await readFile(plist), { mode: 0o600, flag: "wx" });
  const nextPlist = join(revision, "launchagent.plist"), nextManifest = join(revision, "deployment.json");
  await writeFile(nextPlist, await readFile(plist), { mode: 0o600, flag: "wx" });
  const nextArgs = [oldArgs[0], join(release!, "deployment-supervisor.js"), manifestPath];
  // plutil's array-index replacement can insert rather than replace on this macOS; replace the whole array.
  await exec("/usr/bin/plutil", ["-replace", "ProgramArguments", "-json", JSON.stringify(nextArgs), nextPlist]);
  assert.deepEqual(JSON.parse((await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", nextPlist])).stdout), nextArgs);
  await exec("/usr/bin/plutil", ["-lint", nextPlist]);
  await writeFile(nextManifest, JSON.stringify(DeploymentSchema.parse(m)), { mode: 0o600, flag: "wx" });
  await rename(nextManifest, manifestPath); await rename(nextPlist, plist);
  console.log(JSON.stringify({ event: "HEALTH_CONTROL_UPGRADED", release, revision, workersUnchanged: m.jobs.length, probes: m.dependencyProbes.map(p => ({ id: p.id, kind: p.kind })), pendingThreshold: 20, oldestSeconds: 3600, databaseWrites: 0 }));
} finally { await db.end(); }
