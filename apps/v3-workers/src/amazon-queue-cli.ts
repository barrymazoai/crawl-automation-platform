import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import pg from "pg";
import { Client, Connection } from "@temporalio/client";
import { AmazonLiveConfigSchema } from "./amazon-live-config.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { parseDeliverySettings } from "../../v3-api/src/bootstrap/delivery-config.js";
import { assertSchemaReady } from "../../v3-api/src/bootstrap/schema.js";
import { AmazonQueue, AmazonQueueRunner } from "./amazon-queue.js";
import { AmazonQueueTemporal } from "./amazon-queue-temporal.js";

const configSchema = z.strictObject({ amazonConfigFile: z.string().refine(isAbsolute), webConfigFile: z.string().refine(isAbsolute), healthFile:z.string().refine(isAbsolute).optional() });
const json = async (path: string) => JSON.parse(await readFile(resolve(path), "utf8"));
const print = (value: unknown) => console.log(JSON.stringify(value));
async function main() {
  const [configPath, command, ...args] = process.argv.slice(2);
  if (!configPath || !command) throw Error("Usage: amazon-queue-cli <private-config.json> status|items|add|pause|resume|configure|requeue|run|audit-old|close-audited");
  const config = configSchema.parse(await readGncPrivateJson(resolve(configPath)));
  const amazon = AmazonLiveConfigSchema.parse(await readGncPrivateJson(config.amazonConfigFile));
  const db = new pg.Pool({ connectionString: amazon.database.connectionString, ssl: amazon.database.tls ? { rejectUnauthorized: true } : false,
    max: 8, connectionTimeoutMillis: 5000, statement_timeout: 40000 });
  db.on("error", () => print({ event: "QUEUE_DB_CONNECTION_LOST" }));
  const resourceDb = amazon.resourceDatabase ? new pg.Pool({ connectionString: amazon.resourceDatabase.connectionString,
    ssl: amazon.resourceDatabase.tls ? { rejectUnauthorized: true } : false, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 }) : db;
  if (resourceDb !== db) resourceDb.on("error", () => print({ event: "QUEUE_RESOURCE_DB_CONNECTION_LOST" }));
  let connection: Connection | undefined;
  try {
    await assertSchemaReady(db);
    const queue = new AmazonQueue(db);
    if (command === "status") return print(await queue.status());
    if (command === "items") {
      const state = z.enum(["queued", "ready", "running", "review", "completed"]).parse(args[0] ?? "running");
      return print((await db.query(`SELECT item_id,campaign_id,state,attempt,request_id,last_error,input->'entries'->0->'entry'->>'listingId' AS asin
        FROM amazon_queue_item WHERE state=$1 ORDER BY updated_at DESC LIMIT 1000`, [state])).rows);
    }
    if (command === "add") {
      const manifest = await json(args[0]!);
      if (!Array.isArray(manifest.batches)) throw Error("QUEUE.MANIFEST_BATCHES_REQUIRED");
      return print(await queue.add(manifest.campaignId, manifest.batches));
    }
    if (command === "pause") { await queue.pause(args.includes("--force"), args.includes("--no-escalation") ? 0 : 900); return print(await queue.status()); }
    if (command === "resume") { await queue.resume(); return print(await queue.status()); }
    if (command === "configure") { await queue.configure(Number(args[0]), Number(args[1])); return print(await queue.status()); }
    if (command === "requeue") return print(await queue.requeue(await json(args[0]!)));
    if (!["run", "audit-old", "close-audited"].includes(command)) throw Error("QUEUE.UNKNOWN_COMMAND");
    if (amazon.capture.mode !== "scraperapi") throw Error("QUEUE.REQUEST_CAPTURE_REQUIRED");
    const web = z.object({ databaseUrl: z.string(), delivery: z.unknown() }).parse(await readGncPrivateJson(config.webConfigFile));
    if (web.databaseUrl !== amazon.database.connectionString) throw Error("QUEUE.DATABASE_MISMATCH");
    const settings = parseDeliverySettings(web.databaseUrl, web.delivery), target = settings.channelTargets?.amazon ?? settings.target, t = settings.transport;
    if (target.workflowType !== "BrandCollectionWorkflow") throw Error("QUEUE.TARGET_TYPE");
    connection = await Connection.connect({ address: settings.address, connectTimeout: "15 seconds", ...(t.mode === "mtls" ? { tls: {
      serverNameOverride: t.serverName, serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } } : {}) });
    const client = new Client({ connection, namespace: target.namespace });
    const ports = new AmazonQueueTemporal(db, resourceDb, client, target);
    if (command === "run") {
      if(!config.healthFile)throw Error('QUEUE.HEALTH_FILE_REQUIRED');
      const guarded={submit:ports.submit.bind(ports),inspect:ports.inspect.bind(ports),stop:ports.stop.bind(ports),canStart:async()=>{
        try{const health=await json(config.healthFile!),age=Date.now()-Date.parse(health.at);return health.codec==='amazon-queue-health/1'&&health.canStart===true&&age>=0&&age<45000;}catch{return false;}
      }};
      const stop = new AbortController(); process.once("SIGINT", () => stop.abort()); process.once("SIGTERM", () => stop.abort());
      return await new AmazonQueueRunner(queue, guarded, print).run(stop.signal);
    }
    if (command === "audit-old") {
      if (!args[0]) throw Error("QUEUE.AUDIT_OUTPUT_REQUIRED");
      const rows = (await db.query(`SELECT d.request_id,d.target FROM workflow_delivery d JOIN collection_submission s USING(request_id)
        WHERE d.closed_at IS NULL AND d.last_issue='UNCONFIRMED_TERMINAL' AND s.snapshot->>'channel'='amazon'
        ORDER BY d.intent_at LIMIT 1000`)).rows;
      const results: unknown[] = [];
      const output=resolve(args[0]),startedAt=new Date().toISOString();
      await writeFile(output,JSON.stringify({codec:'amazon-old-intake-audit/1',at:startedAt,complete:false,results}),{flag:'wx',mode:0o600});
      let index=0,checkpoint=Promise.resolve();
      const persist=()=>{const body=JSON.stringify({codec:'amazon-old-intake-audit/1',at:startedAt,complete:results.length===rows.length,results},null,2);
        checkpoint=checkpoint.then(async()=>{await writeFile(output+'.next',body,{mode:0o600});await rename(output+'.next',output);});return checkpoint;};
      await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{for(;;){
        const row=rows[index++];if(!row)return;
        try {
          if (row.target.clusterId !== target.clusterId || row.target.namespace !== target.namespace) throw Error("QUEUE.TARGET_CHANGED");
          const old = new AmazonQueueTemporal(db, resourceDb, client, row.target);
          results.push({ requestId: row.request_id, status: "settled", proof: await old.audit(row.request_id,120000) });
        } catch (e) { results.push({ requestId: row.request_id, status: "held", code: e instanceof Error && /^QUEUE\.[A-Z_]+$/.test(e.message) ? e.message : "QUEUE.AUDIT_UNAVAILABLE" }); }
        await persist();if(results.length%25===0)print({event:'QUEUE_AUDIT_PROGRESS',audited:results.length,total:rows.length});
      }}));
      return print({ audited: results.length, output: resolve(args[0]) });
    }
    // Explicit operator command only; never run at startup or as part of audit-old.
    const audit = z.object({ codec: z.literal("amazon-old-intake-audit/1"), results: z.array(z.object({ requestId: z.uuid(), status: z.string(), proof: z.any().optional() })) }).parse(await json(args[0]!));
    for (const row of audit.results.filter(r => r.status === "settled")) {
      try {
        const receipt = await ports.journal.get(row.requestId);
        if (!receipt || receipt.target.clusterId !== target.clusterId || receipt.target.namespace !== target.namespace) throw Error("QUEUE.TARGET_CHANGED");
        const old = new AmazonQueueTemporal(db, resourceDb, client, receipt.target), fresh = await old.audit(row.requestId,120000);
        if (fresh.root.runId !== row.proof?.root?.runId || fresh.root.terminalEventId !== row.proof?.root?.terminalEventId) throw Error("QUEUE.AUDIT_CHANGED");
        // Retain the full fresh proof before releasing the exact guard.
        await writeFile(resolve(args[0]!) + "." + row.requestId + ".verified.json", JSON.stringify(fresh), { flag: "wx", mode: 0o600 });
        const result = await old.journal.record(row.requestId, fresh.root);
        print({ requestId: row.requestId, state: result.state, outcome: result.observedStatus });
      } catch { print({ requestId: row.requestId, state: "HELD" }); }
    }
  } finally { await connection?.close(); if (resourceDb !== db) await resourceDb.end(); await db.end(); }
}
main().catch(e => { print({ event: "QUEUE_COMMAND_FAILED", code: e instanceof Error && /^QUEUE\.[A-Z_]+$/.test(e.message) ? e.message : "QUEUE.COMMAND_FAILED" }); process.exitCode = 1; });
