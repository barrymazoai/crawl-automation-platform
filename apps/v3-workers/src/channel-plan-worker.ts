import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { createR2Objects, R2ScopeSchema, ArtifactResolver, FileCopies, RetainedPublication, ActivityObjectReads } from "@crawl-automation/v3-artifacts";
import { ChannelProductPlans } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import {historyObservations} from "./history-observations.js";
import {inspectExistingFormula, inspectRecentAttempt} from "./enrichment-store.js";

const Config = z.strictObject({ cacheRoot: z.string().refine(isAbsolute), journalRoot: z.string().refine(isAbsolute), r2: R2ScopeSchema,
  r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  reviewDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }) });
async function load() {
  const path = process.env.V3_CHANNEL_PLAN_CONFIG;
  if (process.env.V3_CHANNEL_PLAN_ENABLED !== "true" || !path || !isAbsolute(path)) throw Error("Private opt-in required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (process.platform !== "win32" && stat.mode & 0o077)) throw Error("Private config required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return Config.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
}
async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(root)).filter(f => f.endsWith(".js")).sort().map(f => join(root, f)));
  await workerProcess(new RoleRegistry("business", [{ role: "channel-product-input", capability: "channel.product-input", kind: "activity",
    compatibility: "channel-plan-v1", contractVersion: 1, buildId, testOnly: false, sessionScoped: true,
    async prepare() {
      const config = await load(), r2 = createR2Objects(config.r2, config.r2Credentials);
      const remote = new ActivityObjectReads(r2.store);
      const db = new pg.Pool({ connectionString: config.reviewDatabase.connectionString, ssl: config.reviewDatabase.tls ? { rejectUnauthorized: true } : false,
        max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const dispose = async () => { r2.close(); await db.end(); };
      try {
        await db.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const publication = new RetainedPublication(await TextLocalStore.open(config.journalRoot), remote);
        const module = new ChannelProductPlans(publication, new ArtifactResolver(await FileCopies.open(config.cacheRoot), remote), new PostgresReviews(db));
        const history=historyObservations(db,remote);
        await history?.check();
        return { kind: "activity", dispose, activities: { inspectExistingFormula: async (raw: unknown) => inspectExistingFormula(db, raw), inspectRecentAttempt: async (raw: unknown) => inspectRecentAttempt(db, raw), prepareChannelProduct: async (...args: unknown[]) => {
          const context = Context.current();
          if (args.length !== 1 || context.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry denied", "CHANNEL.RETRY_DENIED");
          const timer = setInterval(() => context.heartbeat(), 2000);
          try { return await remote.run(async()=>{await history?.attempt("channel",args[0],context.cancellationSignal);const result = await module.run(args[0], context.cancellationSignal); context.cancellationSignal.throwIfAborted(); return result;},stats=>console.log(JSON.stringify({event:"ARTIFACT_READ_SCOPE",activity:"prepareChannelProduct",...stats}))); }
          catch { context.cancellationSignal.throwIfAborted(); throw ApplicationFailure.nonRetryable("Inspect retained channel evidence", "CHANNEL.UNRESOLVED"); }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    },
  }]));
}
main().catch(() => { console.error(JSON.stringify({ event: "CHANNEL_PLAN_WORKER_STARTUP_REJECTED" })); process.exitCode = 1; });
