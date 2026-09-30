import { hostname } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { ChannelPlanInputSchema, observationIdentity } from "@crawl-automation/v3-contracts";
import { createR2Objects, RetainedPublication, ArtifactResolver, FileCopies, sha256 } from "@crawl-automation/v3-artifacts";
import { EgoTaskPages, EgoFileTransport, AcquireFileModule, FileEvidence, systemDns, type SourceAccess } from "@crawl-automation/v3-acquisition";
import { ChannelBrandResolutions, ChannelProductPlans, SwansonEgoReader } from "@crawl-automation/v3-channels";
import { TextLocalStore, CodexTextProvider } from "@crawl-automation/v3-text";
import { CodexVisionProvider } from "@crawl-automation/v3-vision";
import { MultipartOcr } from "@crawl-automation/v3-ocr";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";

async function main() {
  if (process.env.V3_SWANSON_BROWSER_PROOF !== "true" || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_OPT_IN_REQUIRED");
  const [rootArg, privatePath] = process.argv.slice(2); if (!rootArg || !privatePath) throw Error("PATHS_REQUIRED");
  const root = resolve(rootArg), base = await readGncPrivateJson(privatePath) as any;
  if (base.r2.bucket !== "supply-smart-test" || new URL(base.reviewDatabase.connectionString).pathname !== "/crawler_v3_test") throw Error("TEST_SCOPE_REQUIRED");
  const id = `swanson-browser-${randomUUID()}`, dir = join(root, id); await mkdir(dir, { mode: 0o700 });
  const r2 = createR2Objects({ ...base.r2, prefix: `${base.r2.prefix}/${id}` }, base.r2Credentials);
  const db = new pg.Pool({ connectionString: base.reviewDatabase.connectionString, ssl: base.reviewDatabase.tls ? { rejectUnauthorized: true } : false, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const local = await TextLocalStore.open(join(dir, "journal")), copies = await FileCopies.open(join(dir, "cache")), reviews = new PostgresReviews(db);
  const publication = new RetainedPublication(local, r2.store), plans = new ChannelProductPlans(publication, new ArtifactResolver(copies, r2.store), reviews);
  const fileEvidence = new FileEvidence({ local, remote: r2.store, copies, reviews });
  const pages = new EgoTaskPages({ engine: "ego-lite", sdk: "1", cliPath: "/Users/barry/.local/bin/ego-browser", taskSpaceId: 1 }, local);
  const admission=new PostgresResourceAdmission(db),permit={permitId:`permit-${id}`,workflowId:`manual-${id}`,runId:randomUUID(),needs:[{resourceId:"mini-ego-space-1",units:1}]};
  let held=false;
  const report: Record<string, any> = { id, status: "running", products: [], modelCalls: 0, ocrCalls: 0, productWrites: 0, startedAt: new Date().toISOString() };
  const save = () => writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  // Real configuration fingerprints, no model invocation in this browser-phase proof.
  const codex = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" }, executable: "/opt/homebrew/bin/codex",
    codexHome: "/Users/barry/.codex", workRoot: join(dir, "model-work"), runtimeProfileVersion: "gnc-persistent-auth/1", timeoutMs: 240000, disabledMcpServers: ["node_repl", "computer-use"] };
  const text = CodexTextProvider.describe(codex), vision = CodexVisionProvider.describe({ ...codex, extractionProtocol: "label-extraction/1" });
  const ocr = new MultipartOcr({ endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", provider: "paddle-ocr/1", minScore: 0.3 }).supported;
  try {
    await db.query("SELECT review_id FROM public.review_record LIMIT 0");
    const decision=await admission.reserve(permit);
    if(decision.status!=="granted")throw Error("BROWSER_RESOURCE_UNAVAILABLE");held=true;report.permit=permit;
    report.brand = await pages.using(`brands-${id}`, AbortSignal.timeout(60000), async page => {
      const snapshot = await new SwansonEgoReader(page).directory(AbortSignal.timeout(30000));
      await writeFile(join(dir, "brand-directory-public.json"), JSON.stringify(snapshot, null, 2));
      const result = await new ChannelBrandResolutions(publication).run({ operationId: `resolve-${id}`, brandId: "ac-grace-test", brandRevision: 1,
        channel: "swanson", region: "US", name: "A.C. Grace Company" }, snapshot, AbortSignal.timeout(30000));
      if (result.decision.status !== "resolved") throw Error("BRAND_RESOLUTION_REVIEW");
      return { ...result, directoryCount: snapshot.entries.length };
    });
    await save(); console.log(JSON.stringify({ event: "BRAND_RESOLVED_PAGE_CLOSED", result: report.brand.decision }));
    // Two previously observed product links: not a claim of automated or complete catalog discovery.
    for (const name of ["swanson-product-public.json", "swanson-second-public.json"]) {
      const fixture = JSON.parse(await readFile(join(root, "2026-09-09-channel-live", name), "utf8"));
      const taskId = `product-${report.products.length}-${id}`;
      const result = await pages.using(taskId, AbortSignal.timeout(180000), async browser => {
        const p = await new SwansonEgoReader(browser).product(fixture.url, AbortSignal.timeout(45000));
        const listingId = p.selectedForms[0]!.productId, variantId = p.selectedForms[0]!.variantIds[0]!;
        if (listingId !== fixture.selectedForms[0].productId || variantId !== fixture.selectedForms[0].variantIds[0]) throw Error("PRODUCT_CHANGED");
        const owner = { schemaVersion: 1, requestId: id, observationId: `obs-${listingId}-${id}`, brandId: "ac-grace-test", sourceId: "swanson-test", listingId, variantId };
        const bytes = Buffer.from(JSON.stringify(p)), source = { schemaVersion: 1, artifactId: `projection-${listingId}-${id}`, observationId: owner.observationId,
          sourceId: owner.sourceId, listingId, variantId, kind: "result-json", mediaType: "application/json", objectKey: `sources/${listingId}.json`, byteSize: bytes.length, sha256: sha256(bytes),
          producer: { operationId: `capture-${listingId}-${id}`, module: "swanson.browser-projection", implementationVersion: "swanson-rendered/1" } };
        await publication.publish(source.objectKey, bytes, "application/json", AbortSignal.timeout(30000));
        const input = ChannelPlanInputSchema.parse({ operationId: `plan-${listingId}-${id}`, owner, channel: "swanson", parserVersion: "swanson-rendered/1", expectedUrl: p.url,
          source, binding: { sessionId: taskId, egressId: "mini-ego-host/1" }, text, ocr, visionConfigFingerprint: vision.configFingerprint });
        await writeFile(join(dir, `input-${listingId}.json`), JSON.stringify(input, null, 2));
        const prepared = await plans.run(input, AbortSignal.timeout(45000)); if (prepared.status !== "prepared") throw Error("PLAN_REVIEW");
        const plan = (await plans.inspect(input, AbortSignal.timeout(30000)))!, files = [];
        for (const source of plan.manifest.sources) if (source.kind === "file-image") {
          const request = source.plan.acquire, url = await plans.fileSource(input, request, AbortSignal.timeout(30000));
          const transport = new EgoFileTransport({ browser, pageUrl: p.url, allowedUrls: [url] }, input.binding.egressId);
          const access: SourceAccess = { acquire: async actual => {
            if (!equal(actual, request)) throw Error("SOURCE.SESSION_MISMATCH");
            let released = false;
            return { owner: observationIdentity(request), sourceId: request.sourceId, resourceId: request.resourceId, binding: request.binding, url,
              allowedOrigins: ["https://www.swansonvitamins.com"], transport, headersFor: () => ({}), assertActive() { if (released) throw Error("SOURCE.SESSION_UNAVAILABLE"); },
              release: async () => { released = true; } };
          } };
          const result = await new AcquireFileModule(fileEvidence, { access, dns: systemDns }).run(request, AbortSignal.timeout(45000));
          if (result.status === "review") throw Error(result.code);
          const confirmed = await fileEvidence.inspect(request, AbortSignal.timeout(30000)); if (!confirmed) throw Error("FILE_UNCONFIRMED");
          files.push({ operationId: request.operationId, file: confirmed.file, dimensions: confirmed.dimensions });
          console.log(JSON.stringify({ event: "FILE_DURABLE", listingId, fileId: confirmed.file.artifactId, dimensions: confirmed.dimensions }));
        }
        return { listingId, variantId, source, files, plan: input, product: p };
      });
      report.products.push({ ...result, browserPageClosed: true }); await save();
      console.log(JSON.stringify({ event: "PRODUCT_BROWSER_PHASE_CLOSED", listingId: result.listingId, files: result.files.length }));
    }
    // Cold local cache, R2 readback only; no browser, network download or OCR/model re-execution.
    const cold = new FileEvidence({ local: await TextLocalStore.open(join(dir, "cold-journal")), remote: r2.store, copies: await FileCopies.open(join(dir, "cold-cache")), reviews });
    for (const product of report.products) {
      const plan = await plans.inspect(product.plan, AbortSignal.timeout(30000)); if (!plan) throw Error("COLD_PLAN_MISSING");
      for (const s of plan.manifest.sources) if (s.kind === "file-image" && !await cold.inspect(s.plan.acquire, AbortSignal.timeout(30000))) throw Error("COLD_FILE_MISSING");
    }
    report.coldReadback = true; report.status = "passed";
    await admission.release(permit);held=false;report.browserPermitReleased=true;
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error && /^[A-Z0-9_.]+$/.test(error.message) ? error.message : "INSPECT_LOCAL_RUN"; throw error;
  } finally { report.browserPermitQuarantined=held;report.finishedAt = new Date().toISOString(); await save(); r2.close(); await db.end(); console.log(JSON.stringify({ report: join(dir, "report.json"), status: report.status, error: report.error })); }
}
main().catch(() => { process.exitCode = 1; });
