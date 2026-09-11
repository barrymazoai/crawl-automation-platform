import {hostname} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker} from '@temporalio/worker';
import {Context} from '@temporalio/activity';
import {closeDtcSession,reportDtcSession} from '../src/dtc-node-session.js';
import {DtcMiniNode} from '../src/dtc-mini-node.js';
import {DtcNodeSessionSchema} from '@crawl-automation/v3-contracts';
import {DtcBrowserConfigSchema,DtcLiveConfigSchema} from '../src/dtc-live-config.js';
import {channelSavedFixture} from '../../../packages/v3-product/src/channel-saved.fixture.js';

async function fixture(){
 const f=await channelSavedFixture(false,'dtc'),p=f.input.sourcePlan;
 const c=DtcBrowserConfigSchema.parse({clusterId:'fixture',r2:{endpoint:'https://00000000000000000000000000000000.r2.cloudflarestorage.com',bucket:'fixture',prefix:'crawlv3-acceptance/fixture'},r2Credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'},
  journalRoot:'/tmp/fixture',cacheRoot:'/tmp/fixture',pageJournalRoot:'/tmp/fixture',browser:{endpoint:'http://127.0.0.1:9222/',instanceId:'fixture',pauseFile:'/tmp/fixture-stop'},browserResource:'fixture-browser',browserModelResource:'fixture-model',egressId:'fixture',
  scope:{brandId:p.owner.brandId,sourceId:p.owner.sourceId,channel:'dtc',region:'US',rootUrl:'https://brand.example/collections/all',scopeVersion:'fixture'},brandName:'fixture',
  site:{brandName:'fixture',origin:'https://brand.example',catalogPages:['https://brand.example/collections/all'],productPathPrefix:'/products/',catalogRoot:'main',productRoot:'main',imageOrigins:['https://brand.example'],galleryControls:[],maxDecisions:4,selectedUrls:[p.expectedUrl]},
  catalogQueue:'fixture',catalogQueues:{source:'fixture',ledger:'fixture',product:'fixture'},catalogResources:{queue:'fixture',maxWaitSeconds:10,activities:{readCatalogPage:[{resourceId:'fixture-browser',units:1},{resourceId:'fixture-model',units:1}]}},
  productQueues:{capture:'fixture',plan:'fixture',file:'fixture',label:'fixture',review:'fixture'},productResources:{queue:'fixture',maxWaitSeconds:10,activities:{browserSession:[{resourceId:'fixture-browser',units:1}],captureDtcProduct:[{resourceId:'fixture-model',units:1}]}},
  sourceText:p.text,ocr:p.ocr,sourceVisionConfigFingerprint:p.visionConfigFingerprint,labelText:f.input.text,visionConfigFingerprint:f.input.visionConfigFingerprint,evidencePolicy:f.input.evidencePolicy,labelQueues:f.entry.queues,labelResources:{queue:'fixture',maxWaitSeconds:10,activities:{}},
  nodeControl:{nodeId:'dtc-fixture',workflowQueue:'fixture',activityQueue:'fixture'},
 });return c;
}
it('Windows accepts the browser config without database credentials and rejects both legacy database fields',async()=>{
 const c=await fixture();expect(DtcBrowserConfigSchema.parse(c)).toEqual(c);
 for(const key of ['database','resourceDatabase'])expect(DtcBrowserConfigSchema.safeParse({...c,[key]:{connectionString:'postgres://fixture',tls:false}}).success).toBe(false);
 expect(DtcLiveConfigSchema.safeParse(c).success).toBe(false);
});
it('Mini: node ownership, health reports, stale sessions, shutdown and replay use Temporal',async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const c=await fixture(),q='node-'+randomUUID();c.nodeControl.workflowQueue=q;c.nodeControl.activityQueue=q;
 let controller:string|null=null,healthy=false,modelReady=true;const queries:string[]=[];
 const db={query:async(sql:string,args:any[]=[])=>{
  queries.push(sql);if(sql.startsWith('SELECT resource_id'))return{rowCount:modelReady?1:0,rows:[]};
  if(sql.startsWith('SELECT permit_id')||sql.startsWith('INSERT'))return{rowCount:0,rows:[]};
  if(sql.includes('controller IS NULL')){if(controller!==null&&controller!==args[1])return{rowCount:0,rows:[]};controller=args[1];healthy=false;return{rowCount:1,rows:[]};}
  if(controller!==args[1])return{rowCount:0,rows:[]};
  if(sql.includes('controller=NULL')){controller=null;healthy=false;}else healthy=args[2];return{rowCount:1,rows:[]};
 }};
 const mini=new DtcMiniNode(db as any,DtcLiveConfigSchema.parse({...c,database:{connectionString:'postgres://fixture',tls:false}}));
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const bundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'product-workflows.cjs')};
 const w=await Worker.create({connection:env.nativeConnection,taskQueue:q,workflowBundle:bundle,activities:{dtcNodeControl:(raw:unknown)=>{const i=Context.current().info;return mini.run(raw,{workflowId:i.workflowExecution!.workflowId,workflowType:i.workflowType!});}}});
 const running=w.run();running.catch(()=>{});
 try{
  const preflight=()=>env.client.workflow.execute('DtcNodePreflightWorkflow',{workflowId:'v3-dtc-doctor-'+randomUUID(),taskQueue:q,args:[{nodeId:c.nodeControl.nodeId,controlQueue:q}]});
  expect(await preflight()).toMatchObject({status:'ready'});expect(controller).toBe(null);
  modelReady=false;await expect(preflight()).rejects.toThrow();modelReady=true;
  const session=DtcNodeSessionSchema.parse({node:{nodeId:c.nodeControl.nodeId,host:'fixture-win',root:'D:\\fixture'},sessionId:randomUUID(),controlQueue:q});
  const h=await env.client.workflow.start('DtcNodeSessionWorkflow',{workflowId:'v3-dtc-node-'+c.nodeControl.nodeId,taskQueue:q,args:[session]});
  const report=(seq:number,id=session.sessionId,on=true)=>h.executeUpdate('dtcNodeHealth',{args:[{sessionId:id,sequence:seq,healthy:on}]});
  await reportDtcSession({client:env.client,connection:env.connection},session,0,true);expect(healthy).toBe(true);
  const owned=controller;await expect(report(1,randomUUID())).rejects.toThrow();await expect(report(0)).rejects.toThrow();expect(controller).toBe(owned);
  // A second controller may neither claim nor disable this resource.
  const foreign={...session,sessionId:randomUUID()},identity={workflowId:h.workflowId,workflowType:'DtcNodeSessionWorkflow'};
  await expect(mini.run({action:'open',session:foreign},identity)).rejects.toThrow('RESOURCE_CONFLICT');
  await expect(mini.run({action:'close',session:foreign},identity)).rejects.toThrow('SESSION_CONFLICT');
  await expect(mini.run({action:'open',session},{...identity,workflowId:'foreign'})).rejects.toThrow('NODE_IDENTITY');
  expect(await report(2,session.sessionId,false)).toMatchObject({status:'acknowledged'});expect(healthy).toBe(false);
  await closeDtcSession({client:env.client,connection:env.connection},session);
  expect(await h.result()).toEqual({status:'stopped',sessionId:session.sessionId});expect(controller).toBe(null);expect(healthy).toBe(false);
  expect(queries.some(sql=>/^(UPDATE|DELETE|INSERT).*resource_permit/.test(sql))).toBe(false);
  await Worker.runReplayHistory({workflowBundle:bundle},await h.fetchHistory(),h.workflowId);
 }finally{w.shutdown();await running;await env.teardown();}
},120000);

it('Mini: catalog source checks route back to its owning Mini workflow, including Continue-As-New',async()=>{
 expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
 const c=await fixture(),f=await channelSavedFixture(false,'dtc'),id='catalog-'+randomUUID(),miniQueue=id+'-mini',windowsQueue=id+'-windows';
 const env=await TestWorkflowEnvironment.createLocal({server:{ip:'127.0.0.1',ui:false,executable:{type:'cached-download',version:'v1.8.3'}}});
 const bundle={codePath:join(dirname(fileURLToPath(import.meta.url)),'product-workflows.cjs')};
 const runs:string[]=[],pages:number[]=[],workers:Worker[]=[],running:Promise<void>[]=[];let held=false;
 const spawn=async(taskQueue:string,activities:any)=>{const w=await Worker.create({connection:env.nativeConnection,taskQueue,activities,workflowBundle:bundle});workers.push(w);const r=w.run();r.catch(()=>{});running.push(r);};
 try{
  await spawn(miniQueue,{
   reserveResources:async(r:any)=>{held=true;return{permitId:r.permitId,status:'granted',reason:'available'};},releaseResources:async(r:any)=>{held=false;return{permitId:r.permitId,status:'released',reason:'released'};},
   dtcBrowserControl:async(raw:any)=>{const i=Context.current().info;expect(i.workflowType).toBe('DtcCatalogWorkflow');expect(i.workflowExecution!.workflowId).toBe(id);expect(held).toBe(true);expect(raw.action).toBe('catalog');runs.push(i.workflowExecution!.runId);return{allowed:true};},
   commitCatalogPage:async(p:any)=>({input:p.input,pageHash:"a".repeat(64),completion:p.completion,nextCursor:p.nextCursor,discoveries:[]}),
   closeCatalog:async(r:any)=>{expect(r.failure).toBeNull();return{status:'incomplete'};},
  });
  await spawn(windowsQueue,{readCatalogPage:async(input:any)=>{
   const e=Context.current().info.workflowExecution!;
   expect(await env.client.workflow.getHandle(e.workflowId,e.runId).executeUpdate('dtcBrowserControl',{args:[{action:'catalog',input,model:true}]})).toEqual({allowed:true});pages.push(input.page);
   return{codec:"catalog-page/1",input,entries:[],completion:input.page===0?'more':'unknown',nextCursor:input.page===0?'next':null,source:{...f.input.sourcePlan.source,sourceId:c.scope.sourceId},endEvidence:null};
  }});
  const h=await env.client.workflow.start('DtcCatalogWorkflow',{workflowId:id,taskQueue:miniQueue,args:[{catalogId:id,scope:c.scope,queues:{source:windowsQueue,ledger:miniQueue,product:miniQueue},productWorkflow:'DtcCatalogProductV2Workflow',pagesPerRun:1,resources:{...c.catalogResources,queue:miniQueue}}],workflowExecutionTimeout:'1 minute'});
  expect(await h.result()).toEqual({status:'incomplete'});expect(pages).toEqual([0,1]);expect(new Set(runs).size).toBe(2);expect(held).toBe(false);
  for(const runId of runs)await Worker.runReplayHistory({workflowBundle:bundle},await env.client.workflow.getHandle(id,runId).fetchHistory(),id);
 }finally{for(const w of workers)w.shutdown();await Promise.allSettled(running);await env.teardown();}
},120000);
