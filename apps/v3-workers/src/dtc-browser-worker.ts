import { readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { CatalogPageInputSchema,DtcProductJobSchema,DtcProductCaptureSchema,FileAcquireInputSchema,
  ReviewRecordSchema,observationIdentity,type DtcBrowserControl } from '@crawl-automation/v3-contracts';
import { RetainedPublication,createR2Objects,FileCopies,sha256 } from '@crawl-automation/v3-artifacts';
import { CdpTaskPages,LoopbackCdp,AcquireFileModule,FileEvidence,systemDns,type SourceAccess } from '@crawl-automation/v3-acquisition';
import { DtcCatalogSource,DtcLiveProduct } from '@crawl-automation/v3-channels';
import { TextLocalStore } from '@crawl-automation/v3-text';
import { RoleRegistry,artifactBuildId,workerProcess } from '@crawl-automation/v3-worker-runtime';
import { DtcBrowserConfigSchema } from './dtc-live-config.js';
import { DtcLegacyCapture } from './dtc-legacy-capture.js';
import { DtcLegacyFileTransport } from './dtc-legacy-evidence.js';
import { readGncPrivateJson } from './gnc-config.js';
import { dtcTemporal,requestDtcControl } from './dtc-temporal-control.js';
import { dtcExecutionIdentity } from './dtc-execution.js';

const execution=()=>dtcExecutionIdentity(Context.current().info.workflowExecution);
async function main(){
 if(process.platform!=='win32'||process.env.V3_DTC_BROWSER_ENABLED!=='true'||!process.env.V3_DTC_BROWSER_CONFIG)throw Error('DTC.WINDOWS_REQUIRED');
 const config=DtcBrowserConfigSchema.parse(await readGncPrivateJson(process.env.V3_DTC_BROWSER_CONFIG));
 const root=dirname(fileURLToPath(import.meta.url)),buildId=await artifactBuildId((await readdir(root)).filter(n=>n.endsWith('.js')).sort().map(n=>join(root,n)));
 await workerProcess(new RoleRegistry('business',['catalog-source','capture','file'].map(role=>({role:`dtc-${role}`,capability:`dtc.${role}`,compatibility:'dtc-live-v2',contractVersion:1,kind:'activity' as const,buildId,testOnly:false,sessionScoped:true as const,
  async prepare(runtime){
   const temporal=await dtcTemporal(runtime),r2=createR2Objects(config.r2,config.r2Credentials);let driver:DtcLegacyCapture|undefined;
   const dispose=async()=>{await driver?.close();r2.close();await temporal.connection.close();};
   try{
    const local=await TextLocalStore.open(config.journalRoot,32*1024*1024),copies=await FileCopies.open(config.cacheRoot),pageStore=await TextLocalStore.open(config.pageJournalRoot);
    const publication=new RetainedPublication(local,r2.store),port=new LoopbackCdp(config.browser),pages=new CdpTaskPages(config.browser,pageStore,port);
    if(role!=='file'){driver=new DtcLegacyCapture(config.codex,process.env,root);await driver.check(AbortSignal.timeout(60000));}
    const ask=(raw:DtcBrowserControl,s:AbortSignal)=>requestDtcControl(temporal,execution(),raw,s);
    const requireAllowed=async(raw:DtcBrowserControl,s:AbortSignal)=>{const r=await ask(raw,s);if(!r||typeof r!=='object'||!('allowed' in r)||r.allowed!==true)throw Error('DTC.CONTROL_UNVERIFIED');};
    const verifyJob=async(raw:unknown,s:AbortSignal)=>{const job=DtcProductJobSchema.parse(raw);await requireAllowed({action:'product',job,model:false},s);return job;};
    const bindPage=async(taskId:string,s:AbortSignal)=>{
      const binding={taskId,execution:execution(),namespace:runtime.namespace,browser:config.browser},key=`v3/dtc-page-executions/${sha256(Buffer.from(taskId))}.json`,old=await pageStore.read(key,65536,s);
      if(old&&!equal(JSON.parse(Buffer.from(old).toString()),binding))throw Error('DTC.PAGE_EXECUTION_CONFLICT');
      await pageStore.create(key,Buffer.from(JSON.stringify(binding)),'application/json',s);
    };
    const ownPage=async(taskId:string,s:AbortSignal)=>{await bindPage(taskId,s);return pages.open(taskId,s);};
    const capture=async(taskId:string,operationId:string,url:string,mode:'catalog'|'product',authorization:DtcBrowserControl,s:AbortSignal)=>{
      if(!driver)throw Error('DTC.DRIVER_UNAVAILABLE');
      return driver.capture({page:await ownPage(taskId,s),operationId,url,mode,site:config.site,publication,port,authorize:signal=>requireAllowed(authorization,signal),finishBrowser:()=>pages.close(taskId,AbortSignal.timeout(15000))},s);
    };
    const products=new DtcLiveProduct(publication,{text:config.sourceText,ocr:config.ocr,visionConfigFingerprint:config.sourceVisionConfigFingerprint,egressId:config.egressId},{capture:async(job,s)=>capture(job.sessionId,job.operationId,job.discovery.entry.url,'product',{action:'product',job,model:true},s)});
    const catalog=new DtcCatalogSource(publication,{brandName:config.site.brandName,pages:config.site.catalogPages,selectedUrls:config.site.selectedUrls},{capture:async(input,s,retain)=>{
      const taskId=`dtc-catalog-${sha256(Buffer.from(JSON.stringify(input)))}`;await bindPage(taskId,s);
      return pages.using(taskId,s,async()=>{const p=await capture(taskId,`catalog-${sha256(Buffer.from(JSON.stringify(input)))}`,config.site.catalogPages[input.page]!,'catalog',{action:'catalog',input,model:true},s);await retain(p);return p;});
    }});
    let handlers:Record<string,(raw:any,s:AbortSignal)=>Promise<unknown>>;
    if(role==='catalog-source')handlers={readCatalogPage:async(raw,s)=>{const input=CatalogPageInputSchema.parse(raw);await requireAllowed({action:'catalog',input,model:false},s);return catalog.read(input,s);}};
    else if(role==='capture')handlers={captureDtcProduct:async(raw,s)=>products.capture(await verifyJob(raw,s),s),closeDtcProductPage:async(raw,s)=>pages.close((await verifyJob(raw,s)).sessionId,s)};
    else handlers={acquireDtcFile:async(raw,s)=>{
      const capture=DtcProductCaptureSchema.parse({job:raw.job,sourcePlan:raw.sourcePlan}),input=FileAcquireInputSchema.parse(raw.input);
      const response=await ask({action:'file',capture,input},s) as {url?:unknown};if(typeof response?.url!=='string')throw Error('DTC.FILE_UNVERIFIED');const url=response.url;
      const reviews={read:async(reviewId:string)=>{const r=await ask({action:'file-review-read',capture,input,reviewId},AbortSignal.timeout(15000));return r===null?null:ReviewRecordSchema.parse(r);},
        append:async(record:unknown)=>ask({action:'file-review-append',capture,input,record:ReviewRecordSchema.parse(record)},AbortSignal.timeout(15000))};
      const files=new FileEvidence({local,remote:r2.store,copies,reviews});
      const access:SourceAccess={acquire:async requested=>{
        if(!equal(requested,input))throw Error('SOURCE.SESSION_MISMATCH');
        let released=false;
        return{owner:observationIdentity(input),sourceId:input.sourceId,resourceId:input.resourceId,binding:input.binding,url,allowedOrigins:config.site.imageOrigins,
          transport:new DtcLegacyFileTransport(publication,capture.job.operationId,capture.sourcePlan.expectedUrl,url,config.egressId),headersFor:()=>({}),
          assertActive:()=>{if(released)throw Error('SOURCE.SESSION_UNAVAILABLE');},release:async()=>{released=true;}};
      }};
      return new AcquireFileModule(files,{access,dns:systemDns}).run(input,s);
    }};
    return{kind:'activity' as const,dispose,activities:Object.fromEntries(Object.entries(handlers).map(([name,fn])=>[name,async(raw:unknown)=>{
      const ctx=Context.current();if(ctx.info.attempt!==1)throw ApplicationFailure.nonRetryable('Inspect existing evidence','DTC.RETRY_DENIED');
      const timer=setInterval(()=>ctx.heartbeat(),2000);
      try{return await fn(raw,ctx.cancellationSignal);}catch(error){ctx.cancellationSignal.throwIfAborted();const code=error instanceof Error&&/^(DTC|SOURCE|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(error.message)?error.message:'DTC.ACTIVITY_UNRESOLVED';throw ApplicationFailure.nonRetryable('Inspect retained DTC evidence',code);}finally{clearInterval(timer);}
    }]))};
   }catch(e){await dispose();throw e;}
  }
 }))));
}
main().catch(()=>{console.error(JSON.stringify({event:'DTC_BROWSER_STARTUP_REJECTED'}));process.exitCode=1;});
