import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, ArtifactResolver, R2ScopeSchema, createR2Objects } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { VersionTagSchema } from "@crawl-automation/v3-contracts";
import { CodexTextConfigSchema, CodexTextProvider, TextLocalStore, TextEvidence, TextHandoff,
  PostgresTextRegistry, createTextRole } from "@crawl-automation/v3-text";

const database = z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() });
const configSchema = z.strictObject({ codex: CodexTextConfigSchema, storageId: VersionTagSchema,
  cacheRoot: z.string().refine(isAbsolute), ocrJournalRoot: z.string().refine(isAbsolute), textLocalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  resultDatabase: database, reviewDatabase: database });

async function main() {
  if (process.env.V3_TEXT_LIVE_ENABLED !== "true" || !process.env.V3_TEXT_CONFIG || !isAbsolute(process.env.V3_TEXT_CONFIG))
    throw Error("Explicit text opt-in and private configuration required");
  const path = process.env.V3_TEXT_CONFIG, info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077)))
    throw Error("Private config required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  // Listing metadata does not start Codex, connect to Temporal/DB/R2, or read account credentials.
  const supported = CodexTextProvider.describe(config.codex);
  const output = dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(output)).filter(name => name.endsWith(".js")).sort().map(name => join(output, name));
  const buildId = await artifactBuildId(files);
  const role = createTextRole({ buildId, compatibility: `text-${supported.configFingerprint.slice(0, 32)}`, testOnly: false,
    prepare: async (workerConfig, signal) => {
      const provider = await CodexTextProvider.open(config.codex, process.env);
      const r2 = createR2Objects(config.r2, config.r2Credentials);
      const pool = (db: z.output<typeof database>) => new pg.Pool({ connectionString: db.connectionString,
        ssl: db.tls ? { rejectUnauthorized: true } : false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const resultDb = pool(config.resultDatabase), reviewDb = pool(config.reviewDatabase);
      const dispose = async () => { await provider.close(); r2.close(); await Promise.all([resultDb.end(), reviewDb.end()]); };
      try {
        await resultDb.query("SELECT operation_id,record_hash,record FROM public.processing_result LIMIT 0");
        await reviewDb.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        await provider.check(signal);
        const copies = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.ocrJournalRoot);
        const artifacts = new ArtifactResolver(copies, r2.store);
        const ocr = new OcrResultHandoff(config.storageId, copies, r2.store, journal, new PostgresResultRegistry(resultDb));
        const evidence = new TextEvidence(artifacts, ocr);
        return { dependencies: { provider, nodeId: workerConfig.hostId,
          handoff: new TextHandoff(await TextLocalStore.open(config.textLocalRoot), r2.store, new PostgresTextRegistry(resultDb), evidence, config.storageId),
          reviews: new PostgresReviews(reviewDb) }, dispose };
      } catch (error) { await dispose(); throw error; }
    },
  });
  await workerProcess(new RoleRegistry("business", [role]));
}
main().catch(() => {
  console.error(JSON.stringify({ event: "TEXT_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config, model and dependency capabilities" }));
  process.exitCode = 1;
});
