import { readFile,readdir } from "node:fs/promises";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import pg from "pg";
import { Client,Connection } from "@temporalio/client";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { CatalogDiscoverySchema,BrandCollectionProgressSchema,CollectionWorkflowInput,ScheduleTick } from "@crawl-automation/v3-contracts";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import { GncCaptureEvidence } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { artifactBuildId,workerProcess,RoleRegistry } from "@crawl-automation/v3-worker-runtime";
import { PostgresCatalog } from "../../../packages/v3-product/src/catalog-ledger.js";
import { PostgresCatalogProducts,buildGncCatalogProduct } from "../../../packages/v3-product/src/catalog-product.js";
import { BrandPipelineConfig,BrandPipeline } from "./brand-pipeline.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { scheduleActivities } from "../../v3-api/src/schedules/activities.js";
import { PostgresSubmissions } from "../../v3-api/src/storage/postgres-submissions.js";
function execution(){const value=Context.current().info.workflowExecution;if(!value)throw Error("CATALOG.WORKFLOW_REQUIRED");return value;}
async function main(){
  if(process.env.V3_BRAND_PIPELINE_ENABLED!=="true"||!process.env.V3_BRAND_PIPELINE_CONFIG)throw Error("Pipeline opt-in required");
  const config=BrandPipelineConfig.parse(await readGncPrivateJson(process.env.V3_BRAND_PIPELINE_CONFIG)),root=dirname(fileURLToPath(import.meta.url));
  const buildId=await artifactBuildId((await readdir(root)).filter(n=>n.endsWith(".js")).sort().map(n=>join(root,n)));
  await workerProcess(new RoleRegistry("business",[
    {role:"brand-collection-control",capability:"brand.collection.workflow",compatibility:"brand-v1"},
    {role:"schedule-intake-control",capability:"schedule.intake.workflow",compatibility:"schedule-v1"},
    {role:"catalog-live-source",capability:"catalog.live.source",compatibility:"catalog-live-v1"},
    {role:"catalog-live-ledger",capability:"catalog.live.ledger",compatibility:"catalog-live-v1"},
    {role:"catalog-live-product-input",capability:"catalog.product.workflow",compatibility:"catalog-product-v1"},
  ].map(def=>({...def,contractVersion:1,kind:"activity" as const,buildId,testOnly:false,async prepare(runtime){
    const db=new pg.Pool({connectionString:config.database.connectionString,ssl:config.database.tls?{rejectUnauthorized:true}:false,max:4,statement_timeout:5000,connectionTimeoutMillis:5000});
    const r2=createR2Objects(config.r2,config.r2Credentials);let connection:Connection|undefined;
    const dispose=async()=>{r2.close();await connection?.close();await db.end();};
    try{
      await db.query("SELECT request_id FROM collection_submission LIMIT 0");
      const evidence=new GncCaptureEvidence({local:await TextLocalStore.open(config.journalRoot),remote:r2.store,reviews:new PostgresReviews(db)});
      const pipeline=new BrandPipeline(config,db,evidence),ledger=new PostgresCatalog(db,p=>pipeline.verify(p,AbortSignal.timeout(60000))),products=new PostgresCatalogProducts(db);
      let handlers:Record<string,(raw:any)=>Promise<unknown>>;
      if(def.role==="schedule-intake-control"){
        const activities=scheduleActivities(new PostgresSubmissions(db),{clusterId:config.clusterId,namespace:runtime.namespace,activityQueue:"v3.schedule.intake.workflow.v1.schedule-v1"});
        handlers={acceptScheduleTick:async raw=>{const tick=ScheduleTick.parse(raw);if(tick.workflowId!==execution().workflowId)throw Error("CATALOG.WORKFLOW_IDENTITY");return activities.acceptScheduleTick(tick);}};
      }else if(def.role==="brand-collection-control"){
        const t=runtime.transport;
        connection=await Connection.connect({address:runtime.address,connectTimeout:"20 seconds",...(t.mode==="mtls"?{tls:{serverNameOverride:t.serverName,serverRootCACertificate:await readFile(t.caFile),clientCertPair:{crt:await readFile(t.certFile),key:await readFile(t.keyFile)}}}:{})});
        const client=new Client({connection,namespace:runtime.namespace});
        handlers={prepareBrandCollection:raw=>pipeline.prepare(raw,execution().workflowId),inspectBrandCollection:async raw=>{
          const input=CollectionWorkflowInput.parse(raw);await pipeline.prepare(input,execution().workflowId);
          const closure=(await db.query("SELECT status FROM catalog_closure WHERE catalog_id=$1",[input.requestId])).rows[0];
          const discoveries=(await db.query("SELECT d.record,x.execution FROM catalog_discovery d LEFT JOIN catalog_dispatch x USING(discovery_id) WHERE d.catalog_id=$1",[input.requestId])).rows;
          let finished=0;
          for(const d of discoveries){
            if(!d.execution)continue;
            try{
              const execution=await client.workflow.getHandle(d.record.workflowId).describe();
              if(execution.runId!==d.execution.runId||execution.status.name!=="COMPLETED"||execution.type!=="CatalogProductWorkflow")continue;
              const held=await db.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL",[`${d.record.workflowId}-gnc`]);
              if(!held.rowCount)finished++;
            }catch{/* Unknown execution never releases the source intake guard. */}
          }
          const catalogHeld=await db.query("SELECT 1 FROM resource_permit WHERE request->>'workflowId'=$1 AND released_at IS NULL",[`v3-collection-${input.requestId}-catalog`]);
          return BrandCollectionProgressSchema.parse({catalogId:input.requestId,settled:Boolean(closure)&&finished===discoveries.length&&!catalogHeld.rowCount,catalog:closure?.status??"unknown",discovered:discoveries.length,finished});
        }};
      }else if(def.role==="catalog-live-source")handlers={readCatalogPage:raw=>pipeline.read(raw,execution(),Context.current().cancellationSignal)};
      else if(def.role==="catalog-live-ledger")handlers={commitCatalogPage:raw=>ledger.commit(raw),recordCatalogDispatch:raw=>ledger.dispatch(raw),closeCatalog:raw=>ledger.close(raw)};
      else handlers={prepareCatalogProduct:async raw=>{
        const d=CatalogDiscoverySchema.parse(raw);await pipeline.submission(d.catalogId);
        if(!equal(d.scope,config.policy.scope))throw Error("CATALOG.SCOPE_CONFLICT");
        return products.prepare(d,{clusterId:config.clusterId,namespace:runtime.namespace,...execution()},verified=>buildGncCatalogProduct(verified,{...config.policy,catalogId:d.catalogId}));
      }};
      return {kind:"activity" as const,dispose,activities:Object.fromEntries(Object.entries(handlers).map(([name,fn])=>[name,async(raw:unknown)=>{
        const ctx=Context.current();if(ctx.info.attempt!==1&&!['prepareBrandCollection','inspectBrandCollection'].includes(name))throw ApplicationFailure.nonRetryable("Inspect retained intent","CATALOG.RETRY_DENIED");
        const timer=setInterval(()=>ctx.heartbeat(),2000);
        try{ctx.cancellationSignal.throwIfAborted();return await fn(raw);}catch(e){ctx.cancellationSignal.throwIfAborted();const code=e instanceof Error&&/^CATALOG\.[A-Z_]+$/.test(e.message)?e.message:"CATALOG.UNRESOLVED";throw ApplicationFailure.nonRetryable("Inspect retained catalog evidence",code);}finally{clearInterval(timer);}
      }]))};
    }catch(e){await dispose();throw e;}
  }}))));
}
main().catch(()=>{console.error(JSON.stringify({event:"BRAND_PIPELINE_STARTUP_REJECTED"}));process.exitCode=1;});
