import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Client, Connection } from "@temporalio/client";
import { CatalogPageInputSchema, CollectionWorkflowInput, BrandCollectionPlanSchema, BrandCollectionProgressSchema,
  SwansonProductCaptureSchema, SwansonProductHandoffSchema, ChannelLabelInputSchema, ReviewRecordSchema, observationIdentity } from "@crawl-automation/v3-contracts";
import { createR2Objects, RetainedPublication, ArtifactResolver, FileCopies, sha256 } from "@crawl-automation/v3-artifacts";
import { EgoTaskPages, EgoFileTransport, AcquireFileModule, FileEvidence, systemDns, type SourceAccess } from "@crawl-automation/v3-acquisition";
import { SwansonCatalogSource, SwansonEgoReader, SwansonLiveProduct, ChannelProductPlans } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { RoleRegistry, artifactBuildId, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
import { SwansonProductJobs } from "../../../packages/v3-product/src/swanson-product-jobs.js";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { scopeForSubmission } from "./brand-pipeline.js";
import { SwansonLiveConfigSchema } from "./swanson-live-config.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { SwansonFamilies } from "../../../packages/v3-channels/src/swanson-family.js";

const execution = () => { const e = Context.current().info.workflowExecution; if (!e) throw Error("SWANSON.WORKFLOW_REQUIRED"); return e; };
async function main() {
  if (process.env.V3_SWANSON_LIVE_ENABLED !== "true" || !process.env.V3_SWANSON_LIVE_CONFIG) throw Error("Explicit config required");
  const config = SwansonLiveConfigSchema.parse(await readGncPrivateJson(process.env.V3_SWANSON_LIVE_CONFIG));
  const root = dirname(fileURLToPath(import.meta.url)), buildId = await artifactBuildId((await readdir(root)).filter(n => n.endsWith(".js")).sort().map(n => join(root, n)));
  const roles = ["control", "catalog-source", "catalog-ledger", "product-input", "capture", "file", "review"];
  await workerProcess(new RoleRegistry("business", roles.map(role => ({ role: `swanson-${role}`, capability: `swanson.${role}`, compatibility: "swanson-live-v1",
    contractVersion: 1, kind: "activity" as const, buildId, testOnly: false, sessionScoped:true as const, async prepare(runtime) {
      const db = new pg.Pool({ connectionString: config.database.connectionString, ssl: config.database.tls ? { rejectUnauthorized: true } : false,
        max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const r2 = createR2Objects(config.r2, config.r2Credentials); let connection: Connection | undefined;
      const resourceDb=config.resourceDatabase?new pg.Pool({connectionString:config.resourceDatabase.connectionString,ssl:config.resourceDatabase.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000}):db;
      const dispose = async () => { r2.close(); await connection?.close();if(resourceDb!==db)await resourceDb.end(); await db.end(); };
      try {
        await db.query("SELECT discovery_id FROM catalog_discovery LIMIT 0");
        const local = await TextLocalStore.open(config.journalRoot), copies = await FileCopies.open(config.cacheRoot);
        const publication = new RetainedPublication(local, r2.store), reviews = new PostgresReviews(db), admission = new PostgresResourceAdmission(resourceDb);
        const pages = new EgoTaskPages(config.browser, await TextLocalStore.open(config.pageJournalRoot));
        const requireBrowser = async () => { const e = execution(); await admission.requireHeld(config.browserResource, e.workflowId, e.runId); };
        const jobs = new SwansonProductJobs(db, publication, { scope: config.scope, queues: config.productQueues, resources: config.productResources });
        const verifyJob = (raw: unknown, s: AbortSignal) => jobs.verify(raw, execution().workflowId, s);
        const families=new SwansonFamilies(publication,{capture:async(job,signal,retain)=>{
          await requireBrowser();return pages.using(`${job.sessionId}-family`,signal,async browser=>{
            const p=await new SwansonEgoReader(browser).product(job.discovery.entry.url,signal);await retain(p);return p;
          });
        }});
        const temporal=async()=>{
          if(!connection){const t=runtime.transport;connection=await Connection.connect({address:runtime.address,connectTimeout:"15 seconds",...(t.mode==="mtls"?{tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}}:{})});}
          return new Client({connection,namespace:runtime.namespace});
        };
        const products = new SwansonLiveProduct(publication, { text: config.sourceText, ocr: config.ocr,
          visionConfigFingerprint: config.sourceVisionConfigFingerprint, egressId: config.egressId }, {
          capture: async (job, signal) => { await requireBrowser(); return new SwansonEgoReader(await pages.open(job.sessionId, signal)).product(job.discovery.entry.url, signal); },
        });
        const plans = new ChannelProductPlans(publication, new ArtifactResolver(copies, r2.store), reviews);
        const files = new FileEvidence({ local, remote: r2.store, copies, reviews });
        const submission = async (id: string) => {
          const row = (await db.query("SELECT snapshot FROM collection_submission WHERE request_id=$1", [id])).rows[0];
          if (!row) throw Error("SWANSON.SUBMISSION_REQUIRED");
          const input = CollectionWorkflowInput.parse({ version: 1, requestId: id, snapshot: row.snapshot });
          if (!equal(scopeForSubmission(input), config.scope)) throw Error("SWANSON.SCOPE_CONFLICT");
          return input;
        };
        const catalog = new SwansonCatalogSource(publication, config.brandName, { capture: async (input, signal, retain) => {
          await requireBrowser();
          return pages.using(`swanson-catalog-${sha256(Buffer.from(JSON.stringify(input)))}`, signal,
            async browser => {
              const { projection } = await new SwansonEgoReader(browser).catalog(input.cursor??config.scope.rootUrl, config.brandName, signal);
              await retain(projection); // Preserve evidence before the exact owned page is closed.
              return projection;
            });
        } });
        const catalogIdentity = async (id: string, scope: unknown) => {
          await submission(id);
          if (!equal(scope, config.scope) || execution().workflowId !== `v3-collection-${id}-catalog`) throw Error("SWANSON.SCOPE_CONFLICT");
        };
        const ledger = new PostgresCatalog(db, async p => { await catalogIdentity(p.input.catalogId, p.input.scope); await catalog.verify(p, AbortSignal.timeout(30000)); });
        const prepareBrand = async (raw: unknown) => {
          const input = CollectionWorkflowInput.parse(raw);
          if (!equal(await submission(input.requestId), input) || execution().workflowId !== `v3-collection-${input.requestId}`) throw Error("SWANSON.WORKFLOW_IDENTITY");
          return BrandCollectionPlanSchema.parse({ catalogQueue: config.catalogQueue, catalog: { catalogId: input.requestId, scope: config.scope,
            productWorkflow: "SwansonCatalogProductWorkflow", queues: config.catalogQueues, resources: config.catalogResources, maxPages: config.maxPages??1 } });
        };
        let handlers: Record<string, (raw: any, signal: AbortSignal) => Promise<unknown>>;
        if (role === "catalog-source") handlers = { readCatalogPage: async (raw, s) => {
          const input = CatalogPageInputSchema.parse(raw); await submission(input.catalogId);
          if (!equal(input.scope, config.scope) || execution().workflowId !== `v3-collection-${input.catalogId}-catalog`) throw Error("SWANSON.SCOPE_CONFLICT");
          if(input.page>=(config.maxPages??1))throw Error("SWANSON.PAGINATION_LIMIT");
          if(input.page>0){const previous=(await db.query("SELECT record FROM catalog_page WHERE catalog_id=$1 AND page_index=$2",[input.catalogId,input.page-1])).rows[0];
            if(previous?.record.completion!=="more"||previous.record.nextCursor!==input.cursor)throw Error("SWANSON.PAGINATION_CONFLICT");}
          return catalog.read(input, s);
        } };
        else if (role === "catalog-ledger") handlers = { commitCatalogPage: raw => ledger.commit(raw),
          recordCatalogDispatch: async raw => { await catalogIdentity(raw.discovery.catalogId, raw.discovery.scope); return ledger.dispatch(raw); },
          closeCatalog: async raw => { await catalogIdentity(raw.catalogId, raw.scope); return ledger.close(raw); } };
        else if (role === "product-input") {
          const prepareLabel=async(raw:unknown,s:AbortSignal,streaming:boolean)=>{
            const captured = SwansonProductCaptureSchema.parse(raw), job = await verifyJob(captured.job, s);
            if (!equal(await products.inspect(job, s), captured)) throw Error("SWANSON.CAPTURE_UNVERIFIED");
            const plan = await plans.inspect(captured.sourcePlan, s); if (!plan) throw Error("SWANSON.PLAN_UNVERIFIED");
            if(!streaming)for (const source of plan.manifest.sources) if (source.kind === "file-image" && !await files.inspect(source.plan.acquire, s)) throw Error("SWANSON.FILE_UNVERIFIED");
            const input = ChannelLabelInputSchema.parse({ operationId: `label-${sha256(Buffer.from(JSON.stringify(job)))}`, sourcePlan: captured.sourcePlan,
              text: config.labelText, visionConfigFingerprint: config.visionConfigFingerprint, corePolicy: "swanson-label-core/1", evidencePolicy: config.evidencePolicy });
            const binding = SwansonProductHandoffSchema.parse({ job, input: { input, queues: config.labelQueues, resources: config.labelResources } });
            await publication.publish(`v3/swanson-jobs/${job.discovery.discoveryId}-label.json`, Buffer.from(JSON.stringify(binding)), "application/json", s);
            const e = { clusterId: config.clusterId, namespace: runtime.namespace, ...execution() };
            await db.query("INSERT INTO observation_execution(observation_id,execution) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.sourcePlan.owner.observationId, e]);
            const stored = (await db.query("SELECT execution FROM observation_execution WHERE observation_id=$1", [input.sourcePlan.owner.observationId])).rows[0];
            if (!equal(stored?.execution, e)) throw Error("SWANSON.EXECUTION_CONFLICT");
            return binding;
          };
          handlers={prepareSwansonProduct:(raw,s)=>jobs.prepare(raw,execution().workflowId,s),prepareSwansonLabel:(raw,s)=>prepareLabel(raw,s,false),prepareSwansonStreamingLabel:(raw,s)=>prepareLabel(raw,s,true),
            prepareSwansonFamilyProducts:async(raw,s)=>{
              const job=await verifyJob(raw,s),inventory=await families.inspect(job,s);if(!inventory)throw Error("SWANSON.FAMILY_EVIDENCE_MISSING");
              return Promise.all(inventory.discoveries.map(discovery=>jobs.prepareVariant({family:job.discovery,discovery},s)));
            },
            prepareSwansonVariantProduct:async(raw,s)=>{
              const {job}=await jobs.prepareVariant(raw,s);if(job.discovery.workflowId!==execution().workflowId)throw Error("SWANSON.DISCOVERY_IDENTITY");return job;
            },
            inspectSwansonFamilyProducts:async(raw,s)=>{
              const job=await verifyJob(raw,s),inventory=await families.inspect(job,s);if(!inventory)throw Error("SWANSON.FAMILY_EVIDENCE_MISSING");
              const client=await temporal(),states=[];
              for(const discovery of inventory.discoveries){
                const member=await jobs.prepareVariant({family:job.discovery,discovery},s);
                try{const h=client.workflow.getHandle(member.job.discovery.workflowId),d=await h.describe();
                  if(d.type!=="SwansonVariantProductWorkflow"||d.taskQueue!==config.catalogQueues.product)throw Error("SWANSON.VARIANT_EXECUTION_CONFLICT");
                  const held=await resourceDb.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=ANY($1::text[]) AND released_at IS NULL",[[d.workflowId,`${d.workflowId}-label`]]);
                  states.push({workflowId:d.workflowId,status:d.status.name,held:Boolean(held.rowCount)});
                }catch(e){if(!(e instanceof Error)||e.name!=="WorkflowNotFoundError")throw e;
                  const parent=await client.workflow.getHandle(member.job.familyDiscovery!.workflowId).describe();
                  states.push({workflowId:discovery.workflowId,status:parent.status.name==="RUNNING"?"PENDING":"UNRESOLVED",held:false});
                }
              }
              return {coverage:inventory.coverage,states};
            },
          };
        }
        else if (role === "capture") handlers = {
          enumerateSwansonFamily:async(raw,s)=>families.capture(await verifyJob(raw,s),s),
          captureSwansonProduct: async (raw, s) => products.capture(await verifyJob(raw, s), s),
          closeSwansonProductPage: async (raw, s) => { const job = await verifyJob(raw, s); await requireBrowser(); return pages.close(job.sessionId, s); },
        };
        else if (role === "file") handlers = { acquireSwansonFile: async (raw, s) => {
          const captured = SwansonProductCaptureSchema.parse({ job: raw.job, sourcePlan: raw.sourcePlan }), job = await verifyJob(captured.job, s);
          if (!equal(await products.inspect(job, s), captured)) throw Error("SWANSON.CAPTURE_UNVERIFIED");
          const url = await plans.fileSource(captured.sourcePlan, raw.input, s);
          const access: SourceAccess = { acquire: async input => {
            if (!equal(input, raw.input)) throw Error("SOURCE.SESSION_MISMATCH");
            await requireBrowser(); const browser = await pages.open(job.sessionId, s); let released = false;
            return { owner: observationIdentity(input), sourceId: input.sourceId, resourceId: input.resourceId, binding: input.binding, url,
              allowedOrigins: ["https://www.swansonvitamins.com"], transport: new EgoFileTransport({ browser, pageUrl: captured.sourcePlan.expectedUrl, allowedUrls: [url] }, config.egressId),
              headersFor: () => ({}), assertActive: () => { if (released) throw Error("SOURCE.SESSION_UNAVAILABLE"); }, release: async () => { released = true; } };
          } };
          return new AcquireFileModule(files, { access, dns: systemDns }).run(raw.input, s);
        } };
        else if (role === "review") handlers = { reviewSwansonProduct: async (raw, s) => {
          const job = await verifyJob(raw.job, s); if (raw.code !== "SWANSON.BROWSER_PHASE_UNRESOLVED") throw Error("SWANSON.REVIEW_CODE");
          if (typeof raw.causeCode !== "string" || !/^(SOURCE|SWANSON|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(raw.causeCode)) throw Error("SWANSON.REVIEW_CODE");
          const id = `swanson-review-${sha256(Buffer.from(JSON.stringify(job)))}`, key = `v3/swanson-reviews/${id}.json`;
          let record = await reviews.read(id);
          if (!record) {
            const old = await r2.store.read(key, 65536, s);
            record = old ? ReviewRecordSchema.parse(JSON.parse(Buffer.from(old).toString())) : ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: id, occurredAt: new Date().toISOString(),
              observation: { schemaVersion: 1, requestId: job.discovery.catalogId, observationId: job.operationId, brandId: job.discovery.scope.brandId,
                sourceId: job.discovery.scope.sourceId, listingId: job.discovery.entry.listingId, variantId: null },
              failure: { schemaVersion: 1, requestId: job.discovery.catalogId, observationId: job.operationId, operationId: job.operationId,
                inputFingerprint: sha256(Buffer.from(JSON.stringify(job))), stage: "swanson.browser", category: "PROCESSING", code: raw.code,
                executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
              rawError: { name: "SwansonBrowserPhase", message: raw.code, stack: null, details: { job, causeCode: raw.causeCode } }, candidate: null, inspection: { kind: "none" } });
            await publication.publish(key, Buffer.from(JSON.stringify(record)), "application/json", s); await reviews.append(record);
          }
          return { status: "review", operationId: job.operationId, reviewId: id, code: record.failure.code, evidenceKey: key, automaticRetry: false };
        } };
        else {
          const t = runtime.transport;
          connection = await Connection.connect({ address: runtime.address, connectTimeout: "15 seconds", ...(t.mode === "mtls" ? { tls: {
            serverNameOverride: t.serverName, serverRootCACertificate: await readFile(t.caFile), clientCertPair: { crt: await readFile(t.certFile), key: await readFile(t.keyFile) } } } : {}) });
          const client = new Client({ connection, namespace: runtime.namespace });
          handlers = { prepareBrandCollection: prepareBrand, inspectBrandCollection: async raw => {
            const plan = await prepareBrand(raw), id = plan.catalog.catalogId;
            const closure = (await db.query("SELECT status FROM catalog_closure WHERE catalog_id=$1", [id])).rows[0];
            const rows = (await db.query("SELECT d.record,x.execution FROM catalog_discovery d LEFT JOIN catalog_dispatch x USING(discovery_id) WHERE d.catalog_id=$1", [id])).rows;
            let finished = 0;
            for (const d of rows) if (d.execution) {
              const e = await client.workflow.getHandle(d.record.workflowId).describe();
              const held = await resourceDb.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=ANY($1::text[]) AND released_at IS NULL", [[d.record.workflowId, `${d.record.workflowId}-label`]]);
              if (e.runId === d.execution.runId && e.status.name === "COMPLETED" && e.type === "SwansonCatalogProductWorkflow" && !held.rowCount) finished++;
            }
            const held = await resourceDb.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL", [`v3-collection-${id}-catalog`]);
            return BrandCollectionProgressSchema.parse({ catalogId: id, settled: Boolean(closure) && finished === rows.length && !held.rowCount,
              catalog: closure?.status ?? "unknown", discovered: rows.length, finished });
          } };
        }
        return { kind: "activity" as const, dispose, activities: Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (raw: unknown) => {
          const ctx = Context.current(); if (ctx.info.attempt !== 1 && !["prepareBrandCollection", "inspectBrandCollection"].includes(name)) throw ApplicationFailure.nonRetryable("Inspect existing evidence", "SWANSON.RETRY_DENIED");
          const timer = setInterval(() => ctx.heartbeat(), 2000);
          try { return await fn(raw, ctx.cancellationSignal); }
          catch (error) { ctx.cancellationSignal.throwIfAborted(); const code = error instanceof Error && /^(SWANSON|SOURCE|CATALOG|ARTIFACT)\.[A-Z_]+$/.test(error.message) ? error.message : "SWANSON.ACTIVITY_UNRESOLVED";
            throw ApplicationFailure.nonRetryable("Inspect retained Swanson evidence", code); }
          finally { clearInterval(timer); }
        }])) };
      } catch (error) { await dispose(); throw error; }
    } }))));
}
main().catch(() => { console.error(JSON.stringify({ event: "SWANSON_LIVE_STARTUP_REJECTED" })); process.exitCode = 1; });
