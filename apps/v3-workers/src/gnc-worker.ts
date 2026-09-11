import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { artifactBuildId, RoleRegistry, workerProcess, type RoleDefinition } from "@crawl-automation/v3-worker-runtime";
import { GncAcquireInputSchema, GncAcquireOutcomeSchema, GncProductPrepareOutcomeSchema, GncDiscoveryOutcomeSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects, FileCopies } from "@crawl-automation/v3-artifacts";
import { createHttpRoute, AcquireFileModule, FileEvidence, systemDns, CdpRenderedBrowser, EgoRenderedBrowser, EgoFileTransport, type RenderedBrowser } from "@crawl-automation/v3-acquisition";
import { AcquireGncModule, GncCaptureEvidence, GncAdapter, GncBrowserReader, ResolveGncReceipt, GncProductPlans, GncFileSources, GncCatalogDiscoveries } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { GncWorkerConfigSchema, readGncPrivateJson } from "./gnc-config.js";
import { gncMouseInteraction } from "./gnc-mouse-challenge.js";

async function load() {
  const path = process.env.V3_GNC_CONFIG;
  if (process.env.V3_GNC_LIVE_ENABLED !== "true" || !path) throw Error("Private opt-in required");
  return GncWorkerConfigSchema.parse(await readGncPrivateJson(path));
}
async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  // Include shared build chunks; this dedicated directory excludes unrelated worker roles.
  const buildId = await artifactBuildId((await readdir(root)).filter(f => f.endsWith(".js")).sort().map(f => join(root, f)));
  const roles: RoleDefinition[] = ([
    { role: "gnc-catalog", capability: "gnc.catalog", activity: "captureGncCatalog" },
    { role: "gnc-product", capability: "gnc.product", activity: "captureGncProduct" },
    { role: "gnc-receipt", capability: "gnc.receipt", activity: "resolveGncReceipt" },
    { role: "gnc-product-input", capability: "gnc.product-input", activity: "prepareGncProduct" },
    { role: "gnc-file", capability: "gnc.file", activity: "acquireSourceFile" },
    { role: "gnc-discovery", capability: "gnc.discovery", activity: "publishGncDiscovery" },
  ] as const).map(def => ({ ...def, kind: "activity", contractVersion: 1, compatibility: def.role === "gnc-discovery" ? "gnc-discovery-v1" : def.role === "gnc-file" ? "gnc-file-v1" : def.role === "gnc-product-input" ? "gnc-input-v1" : "gnc-v1", buildId, testOnly: false,
    ...(["gnc-catalog","gnc-product","gnc-file"].includes(def.role)?{sessionScoped:true as const}:{}),
    async prepare(runtime, startupSignal) {
      const config = await load(); if (config.role !== def.role) throw Error("Role configuration mismatch");
      if(runtime.queueScope && "browser" in config && runtime.queueScope!==config.browser.sessionId) throw Error("Session queue/browser mismatch");
      if(runtime.queueScope && config.role==="gnc-file" && config.fileGrants.some(g=>g.input.task.capture.binding.sessionId!==runtime.queueScope)) throw Error("Session queue/file mismatch");
      let reader: GncBrowserReader | undefined;
      let captureBrowser: RenderedBrowser | undefined;
      let fileRoute: ReturnType<typeof createHttpRoute> | undefined;
      if ("network" in config) {
        if (config.role === "gnc-file") {
          if(config.ego) {
            if(config.network.mode!=="host" || config.proxyUrl || runtime.concurrency!==1 ||
              config.fileGrants.some(g=>g.input.task.capture.binding.sessionId!==config.ego!.browser.sessionId ||
                g.input.task.capture.url!==config.ego!.pageUrl)) throw Error("Ego file session/route mismatch");
            fileRoute=createHttpRoute(config.network,{hostClient:new EgoFileTransport(config.ego,config.network.egressId)});
          } else {
            if (config.network.mode === "host") throw Error("Host binary runtime client not installed");
            fileRoute = createHttpRoute(config.network, config.proxyUrl ? { proxyUrl: config.proxyUrl } : {});
          }
        }
        else {
          if (runtime.concurrency !== 1) throw Error("Dedicated browser capture requires concurrency 1");
          for (const g of config.grants) if (!equal(g.task.network, config.network) || g.task.capture.kind !== (config.role === "gnc-catalog" ? "catalog-page" : "product")) throw Error("Grant role/route mismatch");
          const ego = "engine" in config.browser;
          if (ego && (config.network.mode !== "host" || (config.role === "gnc-product" && config.nativeMouse)))
            throw Error("Ego requires explicit unmanaged host network and no native mouse fallback");
          const browser = "engine" in config.browser
            ? new EgoRenderedBrowser(config.browser, config.network.egressId, ["https://www.gnc.com"])
            : new CdpRenderedBrowser({ ...config.browser, egressId: config.network.egressId, allowedOrigins: ["https://www.gnc.com"] });
          captureBrowser = browser;
          if (browser instanceof CdpRenderedBrowser) await browser.preflight(AbortSignal.any([startupSignal, AbortSignal.timeout(5000)]));
          reader = new GncBrowserReader(config.network, browser, config.grants.map(g => ({ input: g.task.capture, expiresAt: g.expiresAt })));
        }
      }
      const r2 = createR2Objects(config.r2, config.r2Credentials), db = new pg.Pool({ connectionString: config.reviewDatabase.connectionString,
        ssl: config.reviewDatabase.tls ? { rejectUnauthorized: true } : false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const dispose = async () => { r2.close(); await db.end(); };
      try {
        await db.query("SELECT review_id,record_hash,record FROM public.review_record LIMIT 0");
        const evidence = new GncCaptureEvidence({ local: await TextLocalStore.open(config.journalRoot), remote: r2.store, reviews: new PostgresReviews(db) });
        if (config.role === "gnc-product" && config.nativeMouse) {
          if ("engine" in config.browser) throw Error("Ego cannot use native mouse fallback");
          if (config.grants.length !== 1 || config.grants[0]!.task.capture.url !== "https://www.gnc.com/energy/613701.html") throw Error("Native mouse requires exact single product grant");
          captureBrowser = new CdpRenderedBrowser({ ...config.browser, egressId:config.network.egressId, allowedOrigins:["https://www.gnc.com"] }, true,
            gncMouseInteraction(config.grants[0]!.task, config.nativeMouse, evidence),
            config.nativeMouse.keepChallengeOpen ? page=>page.url==="https://www.gnc.com/energy/613701.html" &&
              /<title[^>]*>\s*Access to this page has been denied\s*<\/title>/i.test(page.html) : undefined);
          reader = new GncBrowserReader(config.network, captureBrowser, config.grants.map(g=>({input:g.task.capture,expiresAt:g.expiresAt})));
        }
        const module = config.role === "gnc-file" ? new AcquireFileModule(
          new FileEvidence({ ...evidence.deps, copies: await FileCopies.open(config.cacheRoot) }),
          { access: new GncFileSources(new GncProductPlans(evidence), fileRoute!, config.fileGrants), dns: systemDns })
          : reader ? new AcquireGncModule(evidence, new GncAdapter(reader)) : config.role === "gnc-discovery" ? new GncCatalogDiscoveries(evidence) : config.role === "gnc-product-input" ? new GncProductPlans(evidence) : new ResolveGncReceipt(evidence);
        return { kind: "activity", dispose, activities: { [def.activity]: async (...args: unknown[]) => {
          const context = Context.current();
          if (args.length !== 1 || context.info.attempt !== 1) throw ApplicationFailure.nonRetryable("Automatic retry denied", "GNC.RETRY_DENIED");
          if ("grants" in config) {
            const task = GncAcquireInputSchema.safeParse(args[0]);
            if (!task.success || !config.grants.some(g => equal(g.task, task.data))) throw ApplicationFailure.nonRetryable("Unapproved capture", "GNC.GRANT_MISMATCH");
          }
          const timer = setInterval(() => context.heartbeat(), 2000);
          try {
            const result = await module.run(args[0], context.cancellationSignal);
            context.cancellationSignal.throwIfAborted();
            if (config.role === "gnc-file") return result; // AcquireFileModule validates its shared outcome contract.
            return (config.role === "gnc-discovery" ? GncDiscoveryOutcomeSchema : config.role === "gnc-product-input" ? GncProductPrepareOutcomeSchema : GncAcquireOutcomeSchema).parse(result);
          } catch { context.cancellationSignal.throwIfAborted(); throw ApplicationFailure.nonRetryable("Inspect retained GNC evidence", "GNC.UNRESOLVED"); }
          finally { clearInterval(timer); }
        } } };
      } catch (error) { await dispose(); throw error; }
    },
  }));
  await workerProcess(new RoleRegistry("business", roles));
}
main().catch(() => { console.error(JSON.stringify({ event: "GNC_WORKER_STARTUP_REJECTED" })); process.exitCode = 1; });
