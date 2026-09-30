import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess, type RoleDefinition } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, R2ScopeSchema, createR2Objects } from "@crawl-automation/v3-artifacts";
import { PdfInputSchema } from "@crawl-automation/v3-contracts";
import { PdfModule, PdfSubprocess, PdfPreparation, PdfTextPreparation, pdfConfigFingerprint } from "@crawl-automation/v3-pdf";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { LocalVisionEvidenceStore } from "@crawl-automation/v3-vision";

const configSchema = z.strictObject({ pythonExecutable: z.string().refine(isAbsolute).optional(), workRoot: z.string().refine(isAbsolute).optional(),
  cacheRoot: z.string().refine(isAbsolute), journalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  reviewDatabase: z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() }) });
async function main() {
  const path = process.env.V3_PDF_CONFIG;
  if (process.env.V3_PDF_LIVE_ENABLED !== "true" || !path || !isAbsolute(path)) throw Error("Private configuration required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("Private configuration required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  const output = dirname(fileURLToPath(import.meta.url)), assetRoot = join(output, "pdf-assets");
  const buildId = await artifactBuildId([...(await readdir(output)).filter(n => n.endsWith(".js")).sort().map(n => join(output, n)),
    join(assetRoot, "python/worker.py"), join(assetRoot, "policy.json")]);
  const definitions: RoleDefinition[] = ([
    { role: "pdf-inspect", capability: "pdf.inspect", activity: "inspectPdf" },
    { role: "pdf-text", capability: "pdf.text", activity: "extractPdfPageText" },
    { role: "pdf-render", capability: "pdf.render", activity: "renderPdfPage" },
    { role: "pdf-pages-prepare", capability: "pdf.pages.prepare", activity: "preparePdfPages" },
    { role: "pdf-ocr-prepare", capability: "pdf.ocr.prepare", activity: "preparePdfOcr" },
    { role: "pdf-text-input", capability: "pdf.text-input", activity: "preparePdfText" },
  ] as const).map(({ role, capability, activity }) => ({ role, capability, kind: "activity", contractVersion: 1,
    compatibility: `pdf-v1-${pdfConfigFingerprint.slice(0, 32)}`, buildId, testOnly: false,
    async prepare() {
      const r2 = createR2Objects(config.r2, config.r2Credentials), db = new pg.Pool({ connectionString: config.reviewDatabase.connectionString,
        ssl: config.reviewDatabase.tls ? { rejectUnauthorized: true } : false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const dispose = async () => { r2.close(); await db.end(); };
      try {
        await db.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const deps = { journal: await LocalVisionEvidenceStore.open(config.journalRoot), remote: r2.store,
          copies: await FileCopies.open(config.cacheRoot), reviews: new PostgresReviews(db) };
        const preparation = capability === "pdf.pages.prepare" || capability === "pdf.ocr.prepare" || capability === "pdf.text-input";
        let execute: (raw: unknown, signal: AbortSignal) => Promise<unknown>;
        if (capability === "pdf.text-input") {
          const module = new PdfTextPreparation(deps);
          execute = (raw, signal) => module.run(raw, signal);
        } else if (preparation) {
          const module = new PdfPreparation(deps);
          execute = (raw, signal) => capability === "pdf.pages.prepare" ? module.pages(raw, signal) : module.ocr(raw, signal);
        } else {
          if (!config.pythonExecutable || !config.workRoot) throw Error("Python configuration required");
          const engine = await PdfSubprocess.open({ pythonExecutable: config.pythonExecutable, workRoot: config.workRoot, assetRoot });
          const module = new PdfModule(deps, engine);
          execute = (raw, signal) => module.run(raw, signal);
        }
        return { kind: "activity", dispose, activities: { [activity]: async (...args: unknown[]) => {
          const context = Context.current();
          if (args.length !== 1 || context.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry denied", "PDF.RETRY_DENIED");
          if (!preparation) {
            const parsed = PdfInputSchema.safeParse(args[0]);
            if (!parsed.success || parsed.data.module !== capability) throw ApplicationFailure.nonRetryable("Wrong PDF capability", "PDF.INVALID_INPUT");
          }
          const timer = setInterval(() => context.heartbeat(), 2000);
          try { return await execute(args[0], context.cancellationSignal); }
          catch { throw ApplicationFailure.nonRetryable("Inspect retained PDF evidence", "PDF.UNRESOLVED"); }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    },
  }));
  await workerProcess(new RoleRegistry("business", definitions));
}
main().catch(() => { console.error(JSON.stringify({ event: "PDF_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config, build assets and storage capabilities" })); process.exitCode = 1; });
