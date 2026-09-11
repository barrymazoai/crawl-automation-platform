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
import { CodexVisionConfigSchema, CodexVisionProvider, LocalVisionEvidenceStore, RegisteredOcrEvidence, VisionHandoff,
  PostgresVisionRegistry, assertLabelVisionRegistrySchema, createVisionRole, visionReviewWriter } from "@crawl-automation/v3-vision";

const database = z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() });
const configSchema = z.strictObject({ codex: CodexVisionConfigSchema, storageId: VersionTagSchema,
  cacheRoot: z.string().refine(isAbsolute), ocrJournalRoot: z.string().refine(isAbsolute), visionLocalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  resultDatabase: database, reviewDatabase: database });

async function main() {
  if (process.env.V3_VISION_LIVE_ENABLED !== "true" || !process.env.V3_VISION_CONFIG || !isAbsolute(process.env.V3_VISION_CONFIG))
    throw Error("Explicit vision opt-in and private configuration required");
  const path = process.env.V3_VISION_CONFIG, info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077)))
    throw Error("Private config required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  const supported = CodexVisionProvider.describe(config.codex);
  const output = dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(output)).filter(name => name.endsWith(".js")).sort().map(name => join(output, name));
  const buildId = await artifactBuildId(files);
  const role = createVisionRole({ buildId, compatibility: `vision-${supported.configFingerprint.slice(0, 32)}`, testOnly: false,
    prepare: async (_workerConfig, signal) => {
      const provider = await CodexVisionProvider.open(config.codex, process.env);
      let r2: ReturnType<typeof createR2Objects> | undefined;
      const pools: pg.Pool[] = [];
      const pool = (db: z.output<typeof database>) => {
        const p = new pg.Pool({ connectionString: db.connectionString, ssl: db.tls ? { rejectUnauthorized: true } : false,
          max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 }); pools.push(p); return p;
      };
      const dispose = async () => { await provider.close(); r2?.close(); await Promise.all(pools.map(p => p.end())); };
      try {
        r2 = createR2Objects(config.r2, config.r2Credentials);
        const resultDb = pool(config.resultDatabase), reviewDb = pool(config.reviewDatabase);
        await resultDb.query("SELECT operation_id,record_hash,record FROM public.processing_result LIMIT 0");
        if (config.codex.extractionProtocol) await assertLabelVisionRegistrySchema(resultDb,config.codex.extractionProtocol);
        await reviewDb.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        await provider.check(signal);
        const copies = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.ocrJournalRoot);
        const artifacts = new ArtifactResolver(copies, r2.store), registry = new PostgresResultRegistry(resultDb);
        const ocr = new OcrResultHandoff(config.storageId, copies, r2.store, journal, registry);
        const evidence = new RegisteredOcrEvidence(artifacts, ocr, registry);
        const local = await LocalVisionEvidenceStore.open(config.visionLocalRoot);
        return { dispose, dependencies: { provider, store: r2.store, localEvidence: local,
          verifiedOcrText: (selection, signal) => evidence.verifiedText(selection, signal),
          resolve: async (image, signal, owner) => (await artifacts.resolve(image, owner, signal)).bytes },
          handoff: new VisionHandoff(local, r2.store, new PostgresVisionRegistry(resultDb), config.storageId,
            async (task, signal) => { await evidence.verifiedText(task.input.selection, signal); }),
          recordReview: visionReviewWriter(local, new PostgresReviews(reviewDb)) };
      } catch (error) { await dispose(); throw error; }
    },
  });
  await workerProcess(new RoleRegistry("business", [role]));
}
main().catch(() => {
  console.error(JSON.stringify({ event: "VISION_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config, model and dependency capabilities" }));
  process.exitCode = 1;
});
