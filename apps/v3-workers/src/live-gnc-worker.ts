import { readdir } from "node:fs/promises";
import { dirname,join,isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import pg from "pg";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { GncAcquireInputSchema,FileAcquireInputSchema,CatalogProductBindingSchema,observationIdentity,NetworkRouteSchema } from "@crawl-automation/v3-contracts";
import { createR2Objects,FileCopies,R2ScopeSchema } from "@crawl-automation/v3-artifacts";
import { EgoBrowserConfigSchema,EgoNavigatingBrowser,EgoFileTransport,EgoTaskPages,createHttpRoute,AcquireFileModule,FileEvidence,systemDns } from "@crawl-automation/v3-acquisition";
import { GncCaptureEvidence,AcquireGncModule,GncAdapter,GncBrowserReader,GncProductPlans,GncFileSources } from "@crawl-automation/v3-channels";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { artifactBuildId,workerProcess,RoleRegistry } from "@crawl-automation/v3-worker-runtime";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { readGncPrivateJson } from "./gnc-config.js";
import { LiveGncConfig } from "./live-gnc-config.js";
async function main(){
  if(process.env.V3_LIVE_GNC_ENABLED!=="true"||!process.env.V3_LIVE_GNC_CONFIG)throw Error("Live GNC opt-in required");
  const config=LiveGncConfig.parse(await readGncPrivateJson(process.env.V3_LIVE_GNC_CONFIG));
  const root=dirname(fileURLToPath(import.meta.url)),buildId=await artifactBuildId((await readdir(root)).filter(n=>n.endsWith(".js")).sort().map(n=>join(root,n)));
  await workerProcess(new RoleRegistry("business",[
    {role:"gnc-live-capture",capability:"gnc.live.capture",activity:"captureGncProduct"},
    {role:"gnc-live-file",capability:"gnc.live.file",activity:"acquireSourceFile"},
  ].map(def=>({...def,contractVersion:1,compatibility:"gnc-live-v1",kind:"activity" as const,buildId,testOnly:false,async prepare(runtime){
    if(runtime.concurrency!==1)throw Error("Browser role requires concurrency 1");
    const db=new pg.Pool({connectionString:config.database.connectionString,ssl:config.database.tls?{rejectUnauthorized:true}:false,max:4,connectionTimeoutMillis:5000,statement_timeout:5000});
    const r2=createR2Objects(config.r2,config.r2Credentials),dispose=async()=>{r2.close();await db.end();};
    try{
      const evidence=new GncCaptureEvidence({local:await TextLocalStore.open(config.journalRoot),remote:r2.store,reviews:new PostgresReviews(db)}),plans=new GncProductPlans(evidence);
      const fileEvidence=new FileEvidence({...evidence.deps,copies:await FileCopies.open(config.cacheRoot)}),resources=new PostgresResourceAdmission(db);
      const {targetId:_target,sessionId:_session,...space}=config.browser;
      const pages=new EgoTaskPages(space,await TextLocalStore.open(config.pageJournalRoot));
      await db.query("SELECT discovery_id FROM catalog_product_input LIMIT 0");
      const execute=async(raw:unknown,closeOnly=false)=>{
        const ctx=Context.current(),execution=ctx.info.workflowExecution,signal=ctx.cancellationSignal;
        if(ctx.info.attempt!==1||!execution)throw ApplicationFailure.nonRetryable("Inspect original intent","GNC.RETRY_DENIED");
        const capture=def.role==="gnc-live-capture"?GncAcquireInputSchema.parse(raw):null,file=capture?null:FileAcquireInputSchema.parse(raw);
        const owner=capture?.owner??observationIdentity(file!);
        const rows=await db.query("SELECT b.record,d.record AS discovery FROM catalog_product_input b JOIN catalog_discovery d USING(discovery_id) WHERE b.record->'input'->'input'->'sourcePlan'->'task'->'owner'->>'observationId'=$1",[owner.observationId]);
        if(rows.rowCount!==1)throw ApplicationFailure.nonRetryable("Missing durable product binding","GNC.GRANT_MISMATCH");
        const binding=CatalogProductBindingSchema.parse(rows.rows[0].record),plan=binding.input.input.sourcePlan;
        if(!binding.browserPhase||execution.workflowId!==`${rows.rows[0].discovery.workflowId}-gnc`||!equal(owner,plan.task.owner)||!equal(config.network,plan.task.network)||capture&&!equal(capture,plan.task))
          throw ApplicationFailure.nonRetryable("Foreign product or route","GNC.GRANT_MISMATCH");
        const held=()=>resources.requireHeld(config.browserResource,execution.workflowId,execution.runId);
        const pageId=plan.task.capture.binding.sessionId;
        if(closeOnly){await held();return pages.close(pageId,signal);}
        const timer=setInterval(()=>ctx.heartbeat(),2000);
        try{
          if(capture){
            const module=new AcquireGncModule(evidence,new GncAdapter({read:async(input,signal)=>{
              await held();const browser=await pages.open(pageId,signal);
              const rendered=new EgoNavigatingBrowser(browser,config.network.egressId,[capture.capture.url]);
              return new GncBrowserReader(config.network,rendered,[{input:capture.capture,expiresAt:new Date(Date.now()+120000).toISOString()}]).read(input,signal);
            }}));
            return await module.run(capture,signal);
          }
          const url=await plans.fileSource(plan,file!,signal);
          if(!config.allowedImageOrigins.includes(new URL(url).origin))throw Error("SOURCE.ORIGIN_BLOCKED");
          await held();const browser=await pages.open(pageId,signal);
          const route=createHttpRoute(config.network,{hostClient:new EgoFileTransport({browser,pageUrl:plan.task.capture.url,allowedUrls:[url]},config.network.egressId)});
          const access=new GncFileSources(plans,route,[{input:plan,allowedOrigins:config.allowedImageOrigins,expiresAt:new Date(Date.now()+120000).toISOString()}]);
          return await new AcquireFileModule(fileEvidence,{dns:systemDns,access:{acquire:async(input,signal)=>{await held();return access.acquire(input,signal);}}}).run(file,signal);
        }catch{signal.throwIfAborted();throw ApplicationFailure.nonRetryable("Inspect retained source evidence","GNC.UNRESOLVED");}
        finally{clearInterval(timer);}
      };
      return {kind:"activity" as const,dispose,activities:{[def.activity]:(raw:unknown)=>execute(raw),
        ...(def.role==="gnc-live-capture"?{closeGncProductPage:(raw:unknown)=>execute(raw,true)}:{})}};
    }catch(e){await dispose();throw e;}
  }}))));
}
main().catch(()=>{console.error(JSON.stringify({event:"LIVE_GNC_STARTUP_REJECTED"}));process.exitCode=1;});
