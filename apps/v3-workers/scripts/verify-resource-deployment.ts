/** Read-only live snapshot and offline replay, not Workflow execution or provider calls. */
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { artifactBuildId } from "@crawl-automation/v3-worker-runtime";
const [root, release, reportPath] = process.argv.slice(2);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/); assert.ok(root && release && reportPath);
const m = await readGncPrivateJson(join(root, "live/deployment.json")) as any;
assert.equal(m.host, hostname()); assert.equal(m.root, root);
const runtime = await readGncPrivateJson(m.jobs.find((j: any) => j.id === "gnc-core-stream-workflow").env.V3_WORKER_CONFIG) as any;
const t = runtime.transport, db = new pg.Pool({ connectionString: m.database.connectionString, options: "-c default_transaction_read_only=on", connectionTimeoutMillis: 5000, statement_timeout: 5000 });
const connection = await Connection.connect({ address: runtime.address, tls: { serverNameOverride: t.serverName, serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } });
try {
  const client = new Client({ connection, namespace: runtime.namespace });
  const counts: Record<string, number> = {};
  for (const table of ["collection_submission", "processing_result", "collected_product", "review_record", "source_submission_guard"])
    counts[table] = (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
  counts.heldPermits = (await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL")).rows[0].n;
  const permits = (await db.query("SELECT permit_id,request,released_at IS NOT NULL AS released FROM resource_permit ORDER BY granted_at")).rows;
  const histories = [], active = [];
  for await (const d of client.workflow.list()) {
    if (d.status.name === "RUNNING") { active.push(d.workflowId); continue; }
    const history = await client.workflow.getHandle(d.workflowId, d.runId).fetchHistory();
    await Worker.runReplayHistory({ workflowBundle: { codePath: join(release, "product-workflows.cjs") } }, history, d.workflowId);
    histories.push({ workflowId: d.workflowId, runId: d.runId, type: d.type, status: d.status.name, replayed: true });
  }
  const schedules = [];
  for await (const s of client.schedule.list()) { const d = await client.schedule.getHandle(s.scheduleId).describe(); schedules.push({ id: s.scheduleId, paused: d.state.paused }); }
  const status = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  const files = (await readdir(release)).filter(f => f.endsWith(".js")).map(f => join(release, f)).sort();
  const builds = { activity: await artifactBuildId(files), workflow: await artifactBuildId([...files, join(release, "product-workflows.cjs")].sort()) };
  const report = { at: new Date().toISOString(), counts, permits, active, schedules, histories, builds,
    supervisor: { pid: status.pid, at: status.at, ready: status.jobs.filter((j: any) => j.ready).length, jobs: status.jobs.length, dependencies: status.dependencies },
    businessExecutions: 0, databaseWrites: 0 };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ counts, active, schedules, replayed: histories.length, builds, supervisor: report.supervisor, reportPath }));
} finally { await connection.close(); await db.end(); }
