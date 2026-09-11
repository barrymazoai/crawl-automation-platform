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
import { createOcrRole, MultipartOcr, MultipartOcrConfigSchema, OcrIntents } from "@crawl-automation/v3-ocr";

const database = z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() });
const configSchema = z.strictObject({ provider: MultipartOcrConfigSchema, bearerToken: z.string().min(1).optional(),
  storageId: VersionTagSchema, cacheRoot: z.string().refine(isAbsolute), journalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  resultDatabase: database, reviewDatabase: database });

async function main() {
  if (process.env.V3_OCR_LIVE_ENABLED !== "true" || !process.env.V3_OCR_CONFIG || !isAbsolute(process.env.V3_OCR_CONFIG))
    throw Error("Explicit OCR opt-in and private configuration required");
  const path = process.env.V3_OCR_CONFIG, info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077))) throw Error("Private config required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  // Constructing the HTTP adapter does not connect; --list remains read-only.
  const provider = new MultipartOcr(config.provider, config.bearerToken);
  const output = dirname(fileURLToPath(import.meta.url));
  // Include emitted shared chunks: multi-entry bundling must not weaken the build gate.
  const files = (await readdir(output)).filter(name => name.endsWith(".js")).sort().map(name => join(output, name));
  const buildId = await artifactBuildId(files);
  const role = createOcrRole({ buildId, compatibility: `ocr-${provider.supported.configFingerprint.slice(0, 32)}`, testOnly: false,
    prepare: async workerConfig => {
      const r2 = createR2Objects(config.r2, config.r2Credentials);
      const pool = (db: z.output<typeof database>) => new pg.Pool({ connectionString: db.connectionString,
        ssl: db.tls ? { rejectUnauthorized: true } : false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const resultDb = pool(config.resultDatabase), reviewDb = pool(config.reviewDatabase);
      const dispose = async () => { await provider.close(); r2.close(); await Promise.all([resultDb.end(), reviewDb.end()]); };
      try {
        // Read-only startup capability probes; never auto-run migrations or provision accounts.
        await resultDb.query("SELECT operation_id,record_hash,record FROM public.processing_result LIMIT 0");
        await reviewDb.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const local = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.journalRoot);
        return { dependencies: { provider, artifacts: new ArtifactResolver(local, r2.store),
          intents: new OcrIntents(r2.store, workerConfig.hostId, config.storageId),
          results: new OcrResultHandoff(config.storageId, local, r2.store, journal, new PostgresResultRegistry(resultDb)),
          reviews: new PostgresReviews(reviewDb) }, dispose };
      } catch (error) { await dispose(); throw error; }
    },
  });
  await workerProcess(new RoleRegistry("business", [role]));
}
main().catch(() => {
  console.error(JSON.stringify({ event: "OCR_WORKER_STARTUP_REJECTED", message: "Check authorization, private config and dependency capabilities" }));
  process.exitCode = 1;
});
