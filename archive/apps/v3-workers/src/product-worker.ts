import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess, type RoleDefinition } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, ArtifactResolver, R2ScopeSchema, createR2Objects, verifyBytes } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { GncCaptureEvidence, GncLabelPlans } from "@crawl-automation/v3-channels";
import { VersionTagSchema, TextOutputSchema, TextCandidateV3Schema, LabelProductJoinSchema, LabelCollectionInputSchema, GncLabelInputSchema, GncLabelSourceInputSchema } from "@crawl-automation/v3-contracts";
import { TextEvidence, TextHandoff, PostgresTextRegistry } from "@crawl-automation/v3-text";
import { PageEvidence, FileEvidence, PrepareLabelCore, LabelCorePreparation } from "@crawl-automation/v3-acquisition";
import { PdfEvidence, PdfTextEvidence } from "@crawl-automation/v3-pdf";
import { LocalVisionEvidenceStore, RegisteredOcrEvidence, VisionHandoff, PostgresVisionRegistry } from "@crawl-automation/v3-vision";
import { ProductImageAssembly, CollectProduct, PostgresCollectedProducts, ResolveOcrReceipt, ProductEvidenceAssembly, CollectMixedProduct, PostgresMixedCollectedProducts, SavedSourceEvidence,
  PackagingEvidence, LabelProductAssembly, CollectLabelProduct, PostgresLabelCollectedProducts } from "@crawl-automation/v3-product";

const database = z.strictObject({ connectionString: z.string().min(1), tls: z.boolean() });
const configSchema = z.strictObject({ storageId: VersionTagSchema,
  cacheRoot: z.string().refine(isAbsolute), ocrJournalRoot: z.string().refine(isAbsolute), productLocalRoot: z.string().refine(isAbsolute),
  r2: R2ScopeSchema, r2Credentials: z.strictObject({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }),
  resultDatabase: database, reviewDatabase: database, collectionDatabase: database.optional() });
async function main() {
  const path = process.env.V3_PRODUCT_CONFIG;
  if (process.env.V3_PRODUCT_LIVE_ENABLED !== "true" || !path || !isAbsolute(path)) throw Error("Private configuration required");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077))) throw Error("Private configuration required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let config: z.output<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await handle.readFile("utf8"))); } finally { await handle.close(); }
  const output = dirname(fileURLToPath(import.meta.url));
  const buildId = await artifactBuildId((await readdir(output)).filter(n => n.endsWith(".js")).sort().map(n => join(output, n)));
  const definitions: RoleDefinition[] = ([
    { role: "product-images-assembly", capability: "product.images.assembly", activity: "assembleProductImages", kind: "assembly" },
    { role: "product-collect", capability: "product.collect", activity: "collectProduct", kind: "collection" },
    { role: "ocr-receipt", capability: "ocr.receipt", activity: "resolveOcrReceipt", kind: "receipt" },
    { role: "product-evidence-assembly", capability: "product.evidence.assembly", activity: "assembleProductEvidence", kind: "mixed" },
    { role: "product-evidence-collect", capability: "product.evidence.collect", activity: "collectMixedProduct", kind: "mixed-collection" },
    { role: "product-label-assembly", capability: "product.label.assembly", activity: "assembleLabelProduct", kind: "label" },
    { role: "product-label-collect", capability: "product.label.collect", activity: "collectLabelProduct", kind: "label-collection" },
    { role: "product-packaging-assembly", capability: "product.label.assembly", activity: "assembleLabelProduct", kind: "label" },
    { role: "product-packaging-collect", capability: "product.label.collect", activity: "collectLabelProduct", kind: "label-collection" },
    { role: "product-core-assembly", capability: "product.label.assembly", activity: "assembleLabelProduct", kind: "label" },
    { role: "product-core-collect", capability: "product.label.collect", activity: "collectLabelProduct", kind: "label-collection" },
    { role: "gnc-label-input", capability: "gnc.label-input", activity: "prepareGncLabel", kind: "label-input" },
    { role: "gnc-label-plan", capability: "gnc.label-plan", activity: "loadGncLabelPlan", kind: "label-plan" },
    { role: "gnc-label-source", capability: "gnc.label-source", activity: "prepareGncLabelSource", kind: "label-source" },
    { role: "gnc-core-input", capability: "gnc.label-input", activity: "prepareGncLabel", kind: "label-input" },
    { role: "gnc-core-plan", capability: "gnc.label-plan", activity: "loadGncLabelPlan", kind: "label-plan" },
    { role: "gnc-core-source", capability: "gnc.label-source", activity: "prepareGncLabelSource", kind: "label-source" },
  ] as const).map(({ role, capability, activity, kind }) => ({
    role, capability, kind: "activity", contractVersion: 1,
    compatibility: role.startsWith("gnc-core-") ? "gnc-core-v1" : role.startsWith("product-core-") ? "label-core-v1" : role.startsWith("product-packaging-") ? "label-packaging-v1" : kind === "label-plan" || kind === "label-source" ? "gnc-stream-v1" : kind === "label-input" ? "gnc-label-v1" : kind === "label" || kind === "label-collection" ? "label-product-v1" : kind === "mixed" || kind === "mixed-collection" ? "mixed-product-v5" : "product-images-v3", buildId, testOnly: false,
    async prepare() {
      let r2: ReturnType<typeof createR2Objects> | undefined;
      const pools: pg.Pool[] = [];
      const pool = (db: z.output<typeof database>) => {
        const p = new pg.Pool({ connectionString: db.connectionString, ssl: db.tls ? { rejectUnauthorized: true } : false,
          max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 }); pools.push(p); return p;
      };
      const dispose = async () => { r2?.close(); await Promise.all(pools.map(p => p.end())); };
      try {
        if ((kind === "collection" || kind === "mixed-collection" || kind === "label-collection") && !config.collectionDatabase) throw Error("Collection database required");
        r2 = createR2Objects(config.r2, config.r2Credentials);
        const resultDb = pool(config.resultDatabase), reviewDb = pool(config.reviewDatabase);
        await resultDb.query("SELECT operation_id,record_hash,record FROM public.processing_result LIMIT 0");
        await reviewDb.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const copies = await FileCopies.open(config.cacheRoot), journal = await FileCompletionJournal.open(config.ocrJournalRoot);
        const registry = new PostgresResultRegistry(resultDb), local = await LocalVisionEvidenceStore.open(config.productLocalRoot);
        const results = new OcrResultHandoff(config.storageId, copies, r2.store, journal, registry), reviews = new PostgresReviews(reviewDb);
        let run: (raw: unknown, signal: AbortSignal) => Promise<unknown>;
        if (kind === "receipt") {
          const resolver = new ResolveOcrReceipt({ results, local, reviews });
          run = (raw, signal) => resolver.run(raw, signal);
        } else {
          const ocr = new RegisteredOcrEvidence(new ArtifactResolver(copies, r2.store), results, registry);
          const vision = new VisionHandoff(local, r2.store, new PostgresVisionRegistry(resultDb), config.storageId,
            async (task, signal) => { await ocr.verifiedText(task.input.selection, signal); });
          const assembly = new ProductImageAssembly({ local, remote: r2.store, ocr, vision, reviews });
          run = (raw, signal) => assembly.run(raw, signal);
          if (kind === "label-input" || kind === "label-plan" || kind === "label-source") {
            const remote = r2.store;
            const saved = new SavedSourceEvidence({ remote, files: new FileEvidence({ local, remote, reviews, copies }),
              pages: new PageEvidence({ local, remote, reviews }), ocr: registry, screen: ocr, reviews });
            const artifacts = new ArtifactResolver(copies, remote), core = new PrepareLabelCore(artifacts, new LabelCorePreparation(artifacts, remote));
            const planner = new GncLabelPlans(new GncCaptureEvidence({ local, remote, reviews }),
              (source, signal) => saved.resolve(source, { id: source.id, status: "unresolved" }, signal),
              (input, signal) => core.inspect(input, signal));
            run = (raw, signal) => {
              const input = kind === "label-source" ? GncLabelSourceInputSchema.parse(raw).input : GncLabelInputSchema.parse(raw);
              if (Boolean(input.corePolicy) !== role.startsWith("gnc-core-")) throw Error("GNC.POLICY_QUEUE_MISMATCH");
              return kind === "label-plan" ? planner.load(raw, signal) : kind === "label-source" ? planner.source(raw, signal) : planner.run(raw, signal);
            };
          }
          if (kind === "label" || kind === "label-collection") {
            const evidence = new TextEvidence(new ArtifactResolver(copies, r2.store), results), remote = r2.store;
            const handoff = new TextHandoff(local, remote, new PostgresTextRegistry(resultDb), evidence, config.storageId);
            const typographyEnabled = role.startsWith("product-core-"), packagingEnabled = typographyEnabled || role.startsWith("product-packaging-"), packaging = new PackagingEvidence(new ArtifactResolver(copies, remote));
            const labels = new LabelProductAssembly({ local, remote, reviews,
              readPackaging: (manifest, signal) => packaging.inspect(manifest.observation, manifest.admission!.documents, signal), readSource: async (source, signal) => {
              if (source.kind === "image") return { id: source.id, kind: "image", ...await vision.readLabelCandidate(source.task, signal) };
              const facts = await handoff.inspect(source.task, signal);
              if (!facts.artifactDurable || !facts.resultRegistered || !facts.record) throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
              const bytes = await remote.read(facts.record.result.objectKey, 524288, signal);
              if (!bytes) throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
              verifyBytes(facts.record.result, bytes, 524288);
              const output = TextOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
              return { id: source.id, kind: "text", record: facts.record, candidate: TextCandidateV3Schema.parse(output.candidate), fullText: (await evidence.resolve(source.task, signal)).text };
            } });
            run = (raw, signal) => labels.run(raw, signal);
            if (kind === "label-collection") {
              const db = pool(config.collectionDatabase!);
              const constraint = await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.collected_product'::regclass AND conname='collected_product_codec'");
              if (!constraint.rows.some(r => String(r.definition).includes(packagingEnabled ? "collected-product/4" : "collected-product/3"))) throw Error("Label collection migration required");
              const collector = new CollectLabelProduct({ assembly: labels, registry: new PostgresLabelCollectedProducts(db), local, remote, reviews });
              const history=historyObservations(db,remote);
              await history?.check();
              run = async(raw, signal) => {const result=await collector.run(raw, signal);if(result.status==="collected")await history?.attempt("collected",result.operationId,signal);return result;};
            }
            const execute = run;
            run = (raw, signal) => {
              const input = kind === "label-collection" ? LabelCollectionInputSchema.parse(raw).join : LabelProductJoinSchema.parse(raw);
              if (!!input.manifest.admission !== packagingEnabled || !!input.manifest.admission?.comparison !== typographyEnabled) throw Error("LABEL_PRODUCT.POLICY_QUEUE_MISMATCH");
              return execute(raw, signal);
            };
          }
          if (kind === "mixed" || kind === "mixed-collection") {
            const evidence = new TextEvidence(new ArtifactResolver(copies, r2.store), results);
            const handoff = new TextHandoff(local, r2.store, new PostgresTextRegistry(resultDb), evidence, config.storageId), remote = r2.store;
            const saved = new SavedSourceEvidence({ remote, files: new FileEvidence({ local, remote, reviews, copies }), pages: new PageEvidence({ local, remote, reviews }), ocr: registry, screen: ocr, reviews,
              pdfText: new PdfTextEvidence(remote, new PdfEvidence({ remote, journal: local, copies, reviews })) });
            const mixed = new ProductEvidenceAssembly({ local, remote, vision, reviews, saved, text: { readCandidate: async (task, signal) => {
              const facts = await handoff.inspect(task, signal);
              if (!facts.artifactDurable || !facts.resultRegistered || !facts.record) throw Error("MIXED.EVIDENCE_UNVERIFIED");
              const bytes = await remote.read(facts.record.result.objectKey, 524288, signal);
              if (!bytes) throw Error("MIXED.EVIDENCE_UNVERIFIED");
              verifyBytes(facts.record.result, bytes, 524288);
              const candidate = TextOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).candidate;
              // This legacy product codec cannot flatten the new grouped formula without data loss.
              if ("codec" in candidate) throw Error("MIXED.TEXT_PROTOCOL_UNSUPPORTED");
              return { record: facts.record, candidate,
                fullText: (await evidence.resolve(task, signal)).text };
            } } });
            run = (raw, signal) => mixed.run(raw, signal);
            if (kind === "mixed-collection") {
              const db = pool(config.collectionDatabase!);
              await db.query("SELECT operation_id,observation_id,record_hash,record FROM public.collected_product LIMIT 0");
              const constraint = await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.collected_product'::regclass AND conname='collected_product_codec'");
              if (!constraint.rows.some(r => String(r.definition).includes("collected-product/2"))) throw Error("Mixed collection migration required");
              const collector = new CollectMixedProduct({ assembly: mixed, registry: new PostgresMixedCollectedProducts(db), local, remote, reviews });
              run = (raw, signal) => collector.run(raw, signal);
            }
          }
          if (kind === "collection") {
            const db = pool(config.collectionDatabase!);
            await db.query("SELECT operation_id,observation_id,record_hash,record FROM public.collected_product LIMIT 0");
            const collection = new CollectProduct({ assembly, local, reviews, registry: new PostgresCollectedProducts(db) });
            run = (raw, signal) => collection.run(raw, signal);
          }
        }
        return { kind: "activity", dispose, activities: { [activity]: async (...args: unknown[]) => {
          const ctx = Context.current();
          if (args.length !== 1 || ctx.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry rejected", "PRODUCT.RETRY_DENIED");
          const timer = setInterval(() => ctx.heartbeat(), 2000);
          try { return await run(args[0], ctx.cancellationSignal); }
          catch { throw ApplicationFailure.nonRetryable("Inspect retained product evidence", "PRODUCT.UNRESOLVED"); }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    },
  }));
  await workerProcess(new RoleRegistry("business", definitions));
}
main().catch(() => { console.error(JSON.stringify({ event: "PRODUCT_WORKER_STARTUP_REJECTED", message: "Check opt-in, private config, dependency capabilities" })); process.exitCode = 1; });
import {historyObservations} from "./history-observations.js";
