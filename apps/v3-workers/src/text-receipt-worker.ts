import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, ArtifactResolver, R2ScopeSchema, createR2Objects } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { VersionTagSchema, TextReceiptOutcomeSchema } from "@crawl-automation/v3-contracts";
import { TextLocalStore, TextEvidence, TextHandoff, PostgresTextRegistry, ResolveTextReceipt } from "@crawl-automation/v3-text";

const database = z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() });
// Deliberately no Codex config, executable, account, model or network-switch option.
const configSchema = z.strictObject({ storageId: VersionTagSchema,
  cacheRoot: z.string().refine(isAbsolute), ocrJournalRoot: z.string().refine(isAbsolute), textLocalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  resultDatabase: database, reviewDatabase: database });
async function main() {
  const path = process.env.V3_TEXT_RECEIPT_CONFIG;
  if (process.env.V3_TEXT_RECEIPT_LIVE_ENABLED !== "true" || !path || !isAbsolute(path)) throw Error("Private config required");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077))) throw Error("Private config required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  const output = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(output)).filter(n => n.endsWith(".js")).sort().map(n => join(output, n)));
  await workerProcess(new RoleRegistry("business", [{ role: "text-receipt", capability: "text.receipt", kind: "activity",
    contractVersion: 1, compatibility: "text-receipt-v1", buildId, testOnly: false,
    async prepare() {
      const r2 = createR2Objects(config.r2, config.r2Credentials), pools: pg.Pool[] = [];
      const pool = (db: z.output<typeof database>) => {
        const p = new pg.Pool({ connectionString: db.connectionString, ssl: db.tls ? { rejectUnauthorized: true } : false,
          max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 }); pools.push(p); return p;
      };
      const dispose = async () => { r2.close(); await Promise.all(pools.map(p => p.end())); };
      try {
        const results = pool(config.resultDatabase), reviews = pool(config.reviewDatabase);
        await results.query("SELECT operation_id,record_hash,record FROM public.processing_result LIMIT 0");
        await reviews.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const copies = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.ocrJournalRoot);
        const local = await TextLocalStore.open(config.textLocalRoot);
        const evidence = new TextEvidence(new ArtifactResolver(copies, r2.store),
          new OcrResultHandoff(config.storageId, copies, r2.store, journal, new PostgresResultRegistry(results)));
        const handoff = new TextHandoff(local, r2.store, new PostgresTextRegistry(results), evidence, config.storageId);
        const resolver = new ResolveTextReceipt({ results: { inspect: (input, signal) => handoff.inspect(input, signal) },
          local, reviews: new PostgresReviews(reviews) });
        return { kind: "activity", dispose, activities: { resolveTextReceipt: async (...args: unknown[]) => {
          const ctx = Context.current();
          if (args.length !== 1 || ctx.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Text receipt retry denied", "TEXT_RECEIPT.RETRY_DENIED");
          const timer = setInterval(() => ctx.heartbeat(), 2000);
          try { return TextReceiptOutcomeSchema.parse(await resolver.run(args[0], ctx.cancellationSignal)); }
          catch { throw ApplicationFailure.nonRetryable("Inspect retained text evidence", "TEXT_RECEIPT.UNRESOLVED"); }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    } }]));
}
main().catch(() => { console.error(JSON.stringify({ event: "TEXT_RECEIPT_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config and evidence dependencies" })); process.exitCode = 1; });
