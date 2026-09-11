import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess, type RoleDefinition } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, R2ScopeSchema, createR2Objects, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { LocalVisionEvidenceStore } from "@crawl-automation/v3-vision";
import { AcquireFileModule, FileEvidence, PrepareImageOcr, StaticDirectSources, StaticSourcesSchema, systemDns,
  PageEvidence, PreparePageModule, PreparePageText, LabelCorePreparation, PrepareLabelCore, ResolveAcquiredFile } from "@crawl-automation/v3-acquisition";

const configSchema = z.strictObject({ cacheRoot: z.string().refine(isAbsolute), journalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  reviewDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }), sources: StaticSourcesSchema.optional() });
async function main() {
  const path = process.env.V3_ACQUISITION_CONFIG;
  if (process.env.V3_ACQUISITION_LIVE_ENABLED !== "true" || !path || !isAbsolute(path)) throw Error("Private configuration required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("Private configuration required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  const output = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(output)).filter(n => n.endsWith(".js")).sort().map(n => join(output, n)));
  const definitions: RoleDefinition[] = ([
    { role: "file-acquire", capability: "file.acquire", activity: "acquireSourceFile" },
    { role: "file-receipt", capability: "file.receipt", activity: "acquireSourceFile" },
    { role: "image-ocr-input", capability: "image.ocr-input", activity: "prepareImageOcr" },
    { role: "page-prepare", capability: "page.prepare", activity: "prepareHtmlPage" },
    { role: "page-text-input", capability: "page.text-input", activity: "preparePageText" },
    { role: "label-core-prepare", capability: "label.core.prepare", activity: "prepareLabelCore" },
  ] as const).map(({ role, capability, activity }) => ({ role, capability, kind: "activity", contractVersion: 1,
    compatibility: role === "label-core-prepare" ? "label-core-v1" : role.startsWith("page-") ? "page-v1" : "acquisition-v1", buildId, testOnly: false,
    async prepare() {
      const r2 = createR2Objects(config.r2, config.r2Credentials), db = new pg.Pool({ connectionString: config.reviewDatabase.connectionString,
        ssl: config.reviewDatabase.tls ? { rejectUnauthorized: true } : false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const dispose = async () => { r2.close(); await db.end(); };
      try {
        await db.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const evidence = new FileEvidence({ local: await LocalVisionEvidenceStore.open(config.journalRoot), remote: r2.store,
          copies: await FileCopies.open(config.cacheRoot), reviews: new PostgresReviews(db) });
        let module: AcquireFileModule | PrepareImageOcr | PreparePageModule | PreparePageText | PrepareLabelCore | ResolveAcquiredFile;
        if (role === "file-receipt") module = new ResolveAcquiredFile(evidence);
        else if (role === "label-core-prepare") {
          const artifacts = new ArtifactResolver(evidence.deps.copies, r2.store);
          module = new PrepareLabelCore(artifacts, new LabelCorePreparation(artifacts, r2.store));
        } else if (role === "file-acquire") {
          if (!config.sources) throw Error("Explicit static source catalog required");
          module = new AcquireFileModule(evidence, { access: new StaticDirectSources(config.sources), dns: systemDns });
        } else if (role === "image-ocr-input") module = new PrepareImageOcr(evidence);
        else {
          const pageEvidence = new PageEvidence(evidence.deps);
          module = role === "page-prepare" ? new PreparePageModule(pageEvidence) : new PreparePageText(pageEvidence);
        }
        return { kind: "activity", dispose, activities: { [activity]: async (...args: unknown[]) => {
          const context = Context.current();
          if (args.length !== 1 || context.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry denied", "ACQUIRE.RETRY_DENIED");
          const timer = setInterval(() => context.heartbeat(), 2000);
          try { return await module.run(args[0], context.cancellationSignal); }
          catch (error) {
            const code = error instanceof Error && /^LABEL_CORE\.[A-Z_]+$/.test(error.message) ? error.message : "ACQUIRE.UNRESOLVED";
            throw ApplicationFailure.nonRetryable("Inspect retained acquisition evidence", code);
          }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    },
  }));
  await workerProcess(new RoleRegistry("business", definitions));
}
main().catch(() => { console.error(JSON.stringify({ event: "ACQUISITION_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config, source and storage capabilities" })); process.exitCode = 1; });
