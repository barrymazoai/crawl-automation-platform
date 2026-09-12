import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Client, Connection } from "@temporalio/client";
import { CatalogPageInputSchema, CollectionWorkflowInput, BrandCollectionPlanSchema, BrandCollectionProgressSchema,
  DtcProductCaptureSchema, DtcProductHandoffSchema, ChannelLabelInputSchema, ReviewRecordSchema, observationIdentity, DtcBrowserControlSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects, RetainedPublication, ArtifactResolver, FileCopies, sha256 } from "@crawl-automation/v3-artifacts";
import { FileEvidence } from "@crawl-automation/v3-acquisition";
import { DtcCatalogSource, DtcLiveProduct, ChannelProductPlans } from "@crawl-automation/v3-channels";
import { recordDtcScopeSkip } from "./dtc-scope-skip.js";
import { DtcMiniNode } from "./dtc-mini-node.js";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { RoleRegistry, artifactBuildId, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
import { DtcProductJobs } from "../../../packages/v3-product/src/dtc-product-jobs.js";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { scopeForSubmission } from "./brand-pipeline.js";
import { DtcLiveConfigSchema } from "./dtc-live-config.js";
import { readGncPrivateJson } from "./gnc-config.js";

const execution = () => { const e = Context.current().info.workflowExecution; if (!e) throw Error("DTC.WORKFLOW_REQUIRED"); return e; };
async function main() {
  if (process.env.V3_DTC_LIVE_ENABLED !== "true" || !process.env.V3_DTC_LIVE_CONFIG) throw Error("Explicit config required");
  const config = DtcLiveConfigSchema.parse(await readGncPrivateJson(process.env.V3_DTC_LIVE_CONFIG));
  const root = dirname(fileURLToPath(import.meta.url)), buildId = await artifactBuildId((await readdir(root)).filter(n => n.endsWith(".js")).sort().map(n => join(root, n)));
  const roles = ["control", "catalog-ledger", "product-input", "review"];
  await workerProcess(new RoleRegistry("business", roles.map(role => ({ role: `dtc-${role}`, capability: `dtc.${role}`, compatibility: "dtc-live-v2",
    contractVersion: 1, kind: "activity" as const, buildId, testOnly: false, sessionScoped:true as const, async prepare(runtime) {
      if(process.platform!=="darwin")throw Error("DTC.MINI_REQUIRED");
      const db = new pg.Pool({ connectionString: config.database.connectionString, ssl: config.database.tls ? { rejectUnauthorized: true } : false,
        max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
      const r2 = createR2Objects(config.r2, config.r2Credentials); let connection: Connection | undefined;
      const resourceDb=config.resourceDatabase?new pg.Pool({connectionString:config.resourceDatabase.connectionString,ssl:config.resourceDatabase.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:5000}):db;
      const dispose = async () => { r2.close(); await connection?.close();if(resourceDb!==db)await resourceDb.end(); await db.end(); };
      try {
        await db.query("SELECT discovery_id FROM catalog_discovery LIMIT 0");
        const local = await TextLocalStore.open(config.journalRoot), copies = await FileCopies.open(config.cacheRoot);
        const publication = new RetainedPublication(local, r2.store), reviews = new PostgresReviews(db), admission = new PostgresResourceAdmission(resourceDb);
        const requireBrowser = async () => { const e=execution();await admission.requireHeld(config.browserResource,e.workflowId,e.runId); };
        const jobs = new DtcProductJobs(db, publication, { scope: config.scope, queues: config.productQueues, resources: config.productResources });
        const verifyJob = (raw: unknown, s: AbortSignal) => jobs.verify(raw, execution().workflowId, s);
        const products = new DtcLiveProduct(publication, { text:config.sourceText,ocr:config.ocr,visionConfigFingerprint:config.sourceVisionConfigFingerprint,egressId:config.egressId });
        const plans = new ChannelProductPlans(publication, new ArtifactResolver(copies, r2.store), reviews);
        const files = new FileEvidence({ local, remote: r2.store, copies, reviews });
        const submission = async (id: string) => {
          const row = (await db.query("SELECT snapshot FROM collection_submission WHERE request_id=$1", [id])).rows[0];
          if (!row) throw Error("DTC.SUBMISSION_REQUIRED");
          const input = CollectionWorkflowInput.parse({ version: 1, requestId: id, snapshot: row.snapshot });
          if (!equal(scopeForSubmission(input), config.scope)) throw Error("DTC.SCOPE_CONFLICT");
          return input;
        };
        const catalog = new DtcCatalogSource(publication,{brandName:config.site.brandName,pages:config.site.catalogPages,selectedUrls:config.site.selectedUrls});
        const catalogIdentity = async (id: string, scope: unknown) => {
          await submission(id);
          if (!equal(scope, config.scope) || execution().workflowId !== `v3-collection-${id}-catalog`) throw Error("DTC.SCOPE_CONFLICT");
        };
        const ledger = new PostgresCatalog(db, async p => { await catalogIdentity(p.input.catalogId, p.input.scope); await catalog.verify(p, AbortSignal.timeout(30000)); });
        const prepareBrand = async (raw: unknown) => {
          const input = CollectionWorkflowInput.parse(raw);
          if (!equal(await submission(input.requestId), input) || execution().workflowId !== `v3-collection-${input.requestId}`) throw Error("DTC.WORKFLOW_IDENTITY");
          return BrandCollectionPlanSchema.parse({ catalogQueue: config.catalogQueue, catalog: { catalogId: input.requestId, scope: config.scope,
            productWorkflow: "DtcCatalogProductV2Workflow", queues: config.catalogQueues, resources: config.catalogResources, maxPages: config.maxPages??config.site.catalogPages.length } });
        };
        let handlers: Record<string, (raw: any, signal: AbortSignal) => Promise<unknown>>;
        if (role === "catalog-ledger") handlers = { commitCatalogPage: raw => ledger.commit(raw),
          recordCatalogDispatch: async raw => { await catalogIdentity(raw.discovery.catalogId, raw.discovery.scope); return ledger.dispatch(raw); },
          closeCatalog: async raw => { await catalogIdentity(raw.catalogId, raw.scope); return ledger.close(raw); } };
        else if (role === "product-input") {
          const prepareLabel=async(raw:unknown,s:AbortSignal,streaming:boolean)=>{
            const captured = DtcProductCaptureSchema.parse(raw), job = await verifyJob(captured.job, s);
            if (!equal(await products.inspect(job, s), captured)) throw Error("DTC.CAPTURE_UNVERIFIED");
            const plan = await plans.inspect(captured.sourcePlan, s); if (!plan) throw Error("DTC.PLAN_UNVERIFIED");
            if(!streaming)for (const source of plan.manifest.sources) if (source.kind === "file-image" && !await files.inspect(source.plan.acquire, s)) throw Error("DTC.FILE_UNVERIFIED");
            const input = ChannelLabelInputSchema.parse({ operationId: `label-${sha256(Buffer.from(JSON.stringify(job)))}`, sourcePlan: captured.sourcePlan,
              text: config.labelText, visionConfigFingerprint: config.visionConfigFingerprint, evidencePolicy: config.evidencePolicy });
            const binding = DtcProductHandoffSchema.parse({ job, input: { input, queues: config.labelQueues, resources: config.labelResources } });
            await publication.publish(`v3/dtc-jobs/${job.discovery.discoveryId}-label.json`, Buffer.from(JSON.stringify(binding)), "application/json", s);
            const e = { clusterId: config.clusterId, namespace: runtime.namespace, ...execution() };
            await db.query("INSERT INTO observation_execution(observation_id,execution) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.sourcePlan.owner.observationId, e]);
            const stored = (await db.query("SELECT execution FROM observation_execution WHERE observation_id=$1", [input.sourcePlan.owner.observationId])).rows[0];
            if (!equal(stored?.execution, e)) throw Error("DTC.EXECUTION_CONFLICT");
            return binding;
          };
          handlers={prepareDtcProduct:(raw,s)=>jobs.prepare(raw,execution().workflowId,s),prepareDtcLabel:(raw,s)=>prepareLabel(raw,s,false),prepareDtcStreamingLabel:(raw,s)=>prepareLabel(raw,s,true)};
        }
        else if (role === "review") handlers = { recordDtcScopeSkip:async(raw,s)=>{
          const job=await verifyJob(raw.job,s),e=execution();
          if((await resourceDb.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL",[e.workflowId])).rowCount)throw Error("DTC.SCOPE_EXCLUSION_UNVERIFIED");
          return recordDtcScopeSkip({job,receipt:raw.receipt},r2.store,db,s);
        }, reviewDtcProduct: async (raw, s) => {
          const job = await verifyJob(raw.job, s); if (raw.code !== "DTC.BROWSER_PHASE_UNRESOLVED") throw Error("DTC.REVIEW_CODE");
          if (typeof raw.causeCode !== "string" || !/^(SOURCE|DTC|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(raw.causeCode)) throw Error("DTC.REVIEW_CODE");
          const id = `dtc-review-${sha256(Buffer.from(JSON.stringify(job)))}`, key = `v3/dtc-reviews/${id}.json`;
          let record = await reviews.read(id);
          if (!record) {
            const old = await r2.store.read(key, 65536, s);
            record = old ? ReviewRecordSchema.parse(JSON.parse(Buffer.from(old).toString())) : ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: id, occurredAt: new Date().toISOString(),
              observation: { schemaVersion: 1, requestId: job.discovery.catalogId, observationId: job.operationId, brandId: job.discovery.scope.brandId,
                sourceId: job.discovery.scope.sourceId, listingId: job.discovery.entry.listingId, variantId: null },
              failure: { schemaVersion: 1, requestId: job.discovery.catalogId, observationId: job.operationId, operationId: job.operationId,
                inputFingerprint: sha256(Buffer.from(JSON.stringify(job))), stage: "dtc.browser", category: "PROCESSING", code: raw.code,
                executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
              rawError: { name: "DtcBrowserPhase", message: raw.code, stack: null, details: { job, causeCode: raw.causeCode } }, candidate: null, inspection: { kind: "none" } });
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
              if (e.runId === d.execution.runId && e.status.name === "COMPLETED" && e.type === "DtcCatalogProductV2Workflow" && !held.rowCount) finished++;
            }
            const held = await resourceDb.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL", [`v3-collection-${id}-catalog`]);
            return BrandCollectionProgressSchema.parse({ catalogId: id, settled: Boolean(closure) && finished === rows.length && !held.rowCount,
              catalog: closure?.status ?? "unknown", discovered: rows.length, finished });
          } };
        }
        if(role==='catalog-ledger'||role==='product-input')handlers.dtcBrowserControl=async(raw,s)=>{
          const request=DtcBrowserControlSchema.parse(raw),e=execution(),workflowType=Context.current().info.workflowType;
          if(request.action==='catalog'){
            if(role!=='catalog-ledger'||workflowType!=='DtcCatalogWorkflow')throw Error('DTC.CONTROL_ROUTE');
            const input=request.input;await catalogIdentity(input.catalogId,input.scope);await requireBrowser();
            if(input.page>=config.site.catalogPages.length||input.page>=(config.maxPages??config.site.catalogPages.length))throw Error('DTC.PAGINATION_LIMIT');
            if(input.page===0&&input.cursor!==null)throw Error('DTC.PAGINATION_CONFLICT');
            if(input.page>0){const previous=(await db.query('SELECT record FROM catalog_page WHERE catalog_id=$1 AND page_index=$2',[input.catalogId,input.page-1])).rows[0];
              if(previous?.record.completion!=='more'||previous.record.nextCursor!==input.cursor)throw Error('DTC.PAGINATION_CONFLICT');}
            if(request.model)await admission.requireHeld(config.browserModelResource,e.workflowId,e.runId);
            return{allowed:true};
          }
          if(role!=='product-input'||workflowType!=='DtcCatalogProductV2Workflow')throw Error('DTC.CONTROL_ROUTE');
          if(request.action==='product'){
            await verifyJob(request.job,s);await requireBrowser();if(request.model)await admission.requireHeld(config.browserModelResource,e.workflowId,e.runId);return{allowed:true};
          }
          const {capture,input}=request;const job=await verifyJob(capture.job,s);await requireBrowser();
          if(!equal(await products.inspect(job,s),capture))throw Error('DTC.CAPTURE_UNVERIFIED');
          const url=await plans.fileSource(capture.sourcePlan,input,s);
          if(request.action==='file')return{url};
          const valid=(record:unknown)=>{const r=ReviewRecordSchema.parse(record);
            if(!equal(r.observation,observationIdentity(input))||r.failure.operationId!==input.operationId||r.failure.inputFingerprint!==input.inputFingerprint||r.failure.stage!=='file.acquire'||!equal(r.rawError.details,{input})||r.failure.evidenceKey!==`acquisition-reviews/${r.reviewId}.json`)throw Error('DTC.REVIEW_UNVERIFIED');return r;};
          if(request.action==='file-review-read'){const r=await reviews.read(request.reviewId);return r?valid(r):null;}
          const record=valid(request.record);await publication.publish(record.failure.evidenceKey,Buffer.from(JSON.stringify(record)),'application/json',s);
          await reviews.append(record);if(!equal(await reviews.read(record.reviewId),record))throw Error('DTC.REVIEW_UNVERIFIED');return{registered:true};
        };
        if(role==='control'){
          const node=new DtcMiniNode(resourceDb,config);
          handlers.dtcNodeControl=raw=>node.run(raw,{...execution(),workflowType:Context.current().info.workflowType??''});
        }
        return { kind: "activity" as const, dispose, activities: Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (raw: unknown) => {
          const ctx = Context.current(); if (ctx.info.attempt !== 1 && !["prepareBrandCollection", "inspectBrandCollection"].includes(name)) throw ApplicationFailure.nonRetryable("Inspect existing evidence", "DTC.RETRY_DENIED");
          const timer = setInterval(() => ctx.heartbeat(), 2000);
          try { return await fn(raw, ctx.cancellationSignal); }
          catch (error) { ctx.cancellationSignal.throwIfAborted(); const code = error instanceof Error && /^(DTC|SOURCE|CATALOG|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(error.message) ? error.message : "DTC.ACTIVITY_UNRESOLVED";
            throw ApplicationFailure.nonRetryable("Inspect retained Dtc evidence", code); }
          finally { clearInterval(timer); }
        }])) };
      } catch (error) { await dispose(); throw error; }
    } }))));
}
main().catch(() => { console.error(JSON.stringify({ event: "DTC_LIVE_STARTUP_REJECTED" })); process.exitCode = 1; });
