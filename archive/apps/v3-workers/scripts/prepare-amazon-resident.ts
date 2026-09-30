/** Prepare only: immutable manifest/plist candidates and read-only business baseline. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { mergeChannelDeployment } from "../src/merge-channel-deployment.js";
assert.equal(process.argv[2], "--prepare-amazon-resident"); assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const root = "/Users/barry/apps/crawlv3-batch-a.UiA4dx", dir = root + "/live/amazon-resident-20260911", channelDir = root + "/live/amazon-mainflow-20260911/release-amazon-mainflow-20260911-v2";
const read = async (p: string) => JSON.parse(await fs.readFile(p, "utf8")), run = promisify(execFile);
const previous = await read(root + "/live/deployment.json"), channel = await read(channelDir + "/deployment.json"), ready = await read(channelDir + "/ready.json");
assert.equal(previous.jobs.length, 61); assert.equal(channel.jobs.length, 30); assert.deepEqual(previous, await read(channelDir + "/original-deployment.json"));
const acceptance = await read(root + "/live/amazon-entry-20260911/request-c0980919-55ea-4d65-9ad1-6a023dbf3721/report.json");
assert.equal(acceptance.verified, true); assert.equal(acceptance.held, 0); assert.equal(acceptance.counts.collected_product, 0); assert.equal(acceptance.counts.review_record, 3);
const tests = await read(root + "/amazon-controller-tests-20260911/tests.json"); assert.equal(tests.success, true); assert.equal(tests.numFailedTests, 0); assert.ok(tests.numPassedTests >= 17);
await fs.mkdir(dir, { mode: 0o700 }); await fs.mkdir(dir + "/evidence", { mode: 0o700 });
const save = async (name: string, value: unknown) => { await fs.writeFile(dir + "/" + name, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 }); return dir + "/" + name; };
const oldWeb = await read(previous.jobs.find((j: any) => j.id === "brand-web").env.V3_BRAND_WEB_CONFIG);
assert.equal(oldWeb.port, 4188); assert.equal(oldWeb.delivery.channelTargets.amazon, undefined);
const webConfig = await save("web.private.json", { ...oldWeb, delivery: { ...oldWeb.delivery, channelTargets: { ...oldWeb.delivery.channelTargets, amazon: ready.target } } });
const next = mergeChannelDeployment(previous, channel, { entry: ready.release + "/brand-web.js", config: webConfig }); assert.equal(next.jobs.length, 90);
await save("previous-deployment.json", previous); await save("deployment.json", next);
const plist = "/Users/barry/Library/LaunchAgents/com.crawlv3.batch-a.plist";
await fs.copyFile(plist, dir + "/previous-launchagent.plist", fs.constants.COPYFILE_EXCL);
const p = JSON.parse((await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist])).stdout);
assert.deepEqual(p.ProgramArguments.slice(1), [root + "/release-resident-controller-20260910/deployment-supervisor.js", root + "/live/deployment.json"]); assert.equal(p.KeepAlive, false);
p.ProgramArguments[1] = root + "/release-amazon-controller-20260911/deployment-supervisor.js";
await save("next-launchagent.json", p); await run("/usr/bin/plutil", ["-convert", "xml1", "-o", dir + "/next-launchagent.plist", dir + "/next-launchagent.json"]);
const db = new pg.Pool({ connectionString: previous.database.connectionString, options: "-c default_transaction_read_only=on", statement_timeout: 5000 });
try {
  assert.equal(new URL(previous.database.connectionString).pathname, "/crawler_v3_test");
  for (const table of ["source_submission_guard", "resource_permit WHERE released_at IS NULL"]) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  const hashes: Record<string, string[]> = {}; for (const table of ["collected_product", "review_record", "processing_result"]) hashes[table] = (await db.query(`SELECT record_hash FROM ${table} ORDER BY record_hash`)).rows.map(r => r.record_hash);
  await save("baseline.json", { hashes, submissions: (await db.query("SELECT count(*)::int n FROM collection_submission")).rows[0].n,
    sources: (await db.query("SELECT id,brand_id,channel,region,url,revision,enabled FROM brand_source ORDER BY id")).rows });
  const controllerHash = createHash("sha256").update(await fs.readFile(p.ProgramArguments[1])).digest("hex");
  await save("ready.json", { root, dir, channelDir, release: ready.release, jobs: 90, previousJobs: 61, controllerHash, activityBuild: ready.activityBuild, workflowBuild: ready.workflowBuild, target: ready.target });
  console.log(JSON.stringify({ dir, jobs: 90, previousWorkersUnchanged: 60, capacities: next.resources.map(r => ({ id: r.resourceId, capacity: r.capacity })), businessWrites: 0 }));
} finally { await db.end(); }
