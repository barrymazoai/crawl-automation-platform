import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ChannelPlanInputSchema, ChannelPlanOutcomeSchema, SwansonRenderedProductSchema, type ChannelPlanInput } from "@crawl-automation/v3-contracts";
import { FileCopies, ArtifactResolver, createR2Objects, RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { ChannelProductPlans } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { parseWorkerConfig } from "@crawl-automation/v3-worker-runtime";
const exec = promisify(execFile), delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  if (process.env.V3_CHANNEL_PLAN_SMOKE !== "true" || process.platform !== "darwin") throw Error("Mini test opt-in required");
  const [rootArg, privatePath, runtimePath] = process.argv.slice(2);
  if (!rootArg || !privatePath || !runtimePath) throw Error("Paths required");
  const root = resolve(rootArg), base = JSON.parse(await readFile(privatePath, "utf8")), original = parseWorkerConfig(JSON.parse(await readFile(runtimePath, "utf8")));
  if (base.r2.bucket !== "supply-smart-test" || new URL(base.reviewDatabase.connectionString).pathname !== "/crawler_v3_test" ||
    !original.namespace.startsWith("batch-a-") || original.transport.mode !== "mtls") throw Error("Isolated test deployment required");
  const id = `channel-proof-${randomUUID()}`, dir = join(root, id); await mkdir(dir, { mode: 0o700 });
  const scope = { ...base.r2, prefix: `${base.r2.prefix}/${id}` }, r2 = createR2Objects(scope, base.r2Credentials);
  const db = new pg.Pool({ connectionString: base.reviewDatabase.connectionString, ssl: base.reviewDatabase.tls ? { rejectUnauthorized: true } : false,
    max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const entry = join(root, "channel-plan/channel-plan-worker.js");
  const roles = JSON.parse((await exec(process.execPath, [entry, "--list"])).stdout), role = roles.find((r: { role: string }) => r.role === "channel-product-input");
  if (!role) throw Error("Role unavailable");
  const queue = "v3.channel.product-input.v1.channel-plan-v1", workflowQueue = id;
  const transport = original.transport, tls = { serverNameOverride: transport.serverName, serverRootCACertificate: await readFile(transport.caFile),
    clientCertPair: { crt: await readFile(transport.certFile), key: await readFile(transport.keyFile) } };
  let connection: Connection | undefined, native: NativeConnection | undefined, worker: Worker | undefined, running: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  const report: Record<string, unknown> = { id, namespace: original.namespace, bucket: scope.bucket, prefix: scope.prefix,
    buildId: role.buildId, startedAt: new Date().toISOString(), results: [], status: "running", productWrites: 0, modelCalls: 0, browserNavigations: 0 };
  async function stopChild() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child; current.kill("SIGTERM");
    for (let n = 0; n < 100 && current.exitCode === null && current.signalCode === null; n++) await delay(100);
    if (current.exitCode === null && current.signalCode === null) { current.kill("SIGKILL"); throw Error("Worker did not shut down gracefully"); }
  }
  async function launch(suffix: string) {
    const privateFile = join(dir, `${suffix}-private.json`), runtimeFile = join(dir, `${suffix}-runtime.json`);
    await writeFile(privateFile, JSON.stringify({ r2: scope, r2Credentials: base.r2Credentials, reviewDatabase: base.reviewDatabase,
      cacheRoot: join(dir, suffix, "cache"), journalRoot: join(dir, suffix, "journal") }), { mode: 0o600 });
    const runtime = { ...original, role: role.role, capability: role.capability, compatibility: role.compatibility, expectedBuildId: role.buildId,
      hostId: `mini-channel-${suffix}`, concurrency: 2, shutdownGraceMs: 2000, shutdownForceMs: 5000 };
    delete runtime.queueScope; delete runtime.testSession;
    await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 });
    child = spawn(process.execPath, [entry], { env: { ...process.env, V3_WORKER_ENABLED: "true", V3_WORKER_CONFIG: runtimeFile,
      V3_CHANNEL_PLAN_ENABLED: "true", V3_CHANNEL_PLAN_CONFIG: privateFile }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout!.on("data", b => { log = (log + String(b)).slice(-12000); }); child.stderr!.on("data", b => { log = (log + String(b)).slice(-12000); });
    for (let n = 0; n < 450; n++) {
      if (log.includes('"event":"WORKER_RUNNING"')) return { pid: child.pid, hostId: runtime.hostId };
      if (child.exitCode !== null) throw Error("Worker startup failed"); await delay(100);
    }
    throw Error("Worker startup deadline");
  }
  try {
    await db.query("SELECT review_id FROM public.review_record LIMIT 0");
    connection = await Connection.connect({ address: original.address, tls, connectTimeout: "15 seconds" });
    native = await NativeConnection.connect({ address: original.address, tls });
    const client = new Client({ connection, namespace: original.namespace });
    worker = await Worker.create({ connection: native, namespace: original.namespace, taskQueue: workflowQueue,
      workflowBundle: { codePath: join(root, "channel-plan-smoke/channel-plan-proof.cjs") } });
    running = worker.run(); running.catch(() => {});
    const publication = new RetainedPublication(await TextLocalStore.open(join(dir, "seed-journal")), r2.store);
    const inspector = new ChannelProductPlans(publication, new ArtifactResolver(await FileCopies.open(join(dir, "inspector-cache")), r2.store), new PostgresReviews(db));
    const inputs: ChannelPlanInput[] = [];
    for (const name of ["swanson-product-public.json", "swanson-second-public.json"]) {
      const p = SwansonRenderedProductSchema.parse(JSON.parse(await readFile(join(root, "2026-09-09-channel-live", name), "utf8"))), bytes = Buffer.from(JSON.stringify(p));
      const listingId = p.selectedForms[0]!.productId, variantId = p.selectedForms[0]!.variantIds[0]!;
      const owner = { schemaVersion: 1, requestId: id, observationId: `obs-${listingId}-${id}`, brandId: "ac-grace-test", sourceId: "swanson-test", listingId, variantId };
      const input = ChannelPlanInputSchema.parse({ operationId: `plan-${listingId}-${id}`, channel: "swanson", parserVersion: "swanson-rendered/1", owner,
        expectedUrl: p.url, binding: { sessionId: "ego-1", egressId: "host/1" }, source: { schemaVersion: 1, artifactId: `projection-${listingId}-${id}`,
          observationId: owner.observationId, sourceId: owner.sourceId, listingId, variantId, kind: "result-json", mediaType: "application/json",
          objectKey: `sources/${listingId}.json`, byteSize: bytes.length, sha256: sha256(bytes),
          producer: { operationId: `capture-${listingId}-${id}`, module: "swanson.browser-projection", implementationVersion: "swanson-rendered/1" } },
        text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) },
        ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) });
      await publication.publish(input.source.objectKey, bytes, "application/json", AbortSignal.timeout(30000)); inputs.push(input);
    }
    report.firstWorker = await launch("first");
    const results: unknown[] = [];
    for (const [index, input] of inputs.entries()) {
      const workflowId = `${id}-${index}`, handle = await client.workflow.start("ChannelPlanProof", { workflowId, taskQueue: workflowQueue,
        args: [input, queue], workflowExecutionTimeout: "3 minutes" });
      const out = ChannelPlanOutcomeSchema.parse(await handle.result());
      if (out.status !== "prepared" || out.operationId !== input.operationId || out.manifest.sources.length !== 4) throw Error("Plan proof failed");
      const plan = await inspector.inspect(input, AbortSignal.timeout(30000)); if (!plan || !equal(plan.manifest, out.manifest)) throw Error("R2 readback failed");
      results.push({ workflowId, operationId: input.operationId, listingId: input.owner.listingId, variantId: input.owner.variantId, sourceCount: out.manifest.sources.length,
        sourceSha256: input.source.sha256, evidenceKey: out.evidenceKey, result: "prepared" });
    }
    report.results = results;
    await stopChild(); report.coldWorker = await launch("cold");
    const coldId = `${id}-cold`, out = ChannelPlanOutcomeSchema.parse(await client.workflow.execute("ChannelPlanProof", {
      workflowId: coldId, taskQueue: workflowQueue, args: [inputs[0], queue], workflowExecutionTimeout: "3 minutes" }));
    if (out.status !== "prepared" || !equal(out.manifest, (await inspector.inspect(inputs[0], AbortSignal.timeout(30000)))!.manifest)) throw Error("Cold handoff mismatch");
    report.coldReadback = { workflowId: coldId, status: out.status, emptyInitialLocalCache: true };
    const reviews = await db.query("SELECT count(*)::int AS count FROM public.review_record WHERE record->'failure'->>'requestId'=$1", [id]);
    report.reviewCount = reviews.rows[0].count;
    if (reviews.rows[0].count !== 0) throw Error("Unexpected review");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error instanceof Error && /^[A-Za-z0-9 ._-]{1,100}$/.test(error.message) ? error.message : "Inspect local private configuration and service health"; throw error; }
  finally {
    await stopChild(); if (worker) worker.shutdown(); if (running) await running.catch(() => {});
    if (native) await native.close(); if (connection) await connection.close(); r2.close(); await db.end();
    report.finishedAt = new Date().toISOString(); await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: join(dir, "report.json"), ...report }));
  }
}
main().catch(() => { console.error("CHANNEL_PLAN_SMOKE_FAILED"); process.exitCode = 1; });
