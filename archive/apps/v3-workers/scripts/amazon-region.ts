import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {EgoTaskPages,EgoCliRunner} from '@crawl-automation/v3-acquisition';
import {TextLocalStore} from '@crawl-automation/v3-text';
import {PostgresResourceAdmission} from '../../../packages/v3-product/src/resource-admission.js';
import {AmazonEgoReader} from '../../../packages/v3-channels/src/amazon-ego.js';
const [mode,dir,scriptFile]=process.argv.slice(2);
if(process.platform!=='darwin'||!dir?.startsWith('/Users/barry/apps/crawlv3-history-20260913/'))throw Error('REGION.HOST');
const root='/Users/barry/apps/crawlv3-batch-a.UiA4dx';
const manifest=JSON.parse(await fs.readFile(root+'/live/deployment.json','utf8'));
const db=new pg.Pool({connectionString:manifest.database.connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000});
const admission=new PostgresResourceAdmission(db),space={engine:'ego-lite' as const,sdk:'1' as const,cliPath:'/Users/barry/.local/bin/ego-browser',taskSpaceId:1};
await fs.mkdir(dir,{recursive:true,mode:0o700});
const pages=new EgoTaskPages(space,await TextLocalStore.open(dir+'/journal')),runner=new EgoCliRunner();
try{
 if(mode==='open'){
  const id='amazon-us-region-'+randomUUID(),permit={permitId:'permit-'+id,workflowId:'manual-'+id,runId:randomUUID(),needs:[{resourceId:'mini-ego-space-1',units:1}]};
  await fs.writeFile(dir+'/intent.json',JSON.stringify({id,permit,zip:'10001'}),{flag:'wx',mode:0o600});
  if((await admission.reserve(permit)).status!=='granted')throw Error('REGION.BUSY');
  const page=await pages.open(id,AbortSignal.timeout(30000));
  await fs.writeFile(dir+'/page.json',JSON.stringify(page),{flag:'wx',mode:0o600});console.log(JSON.stringify({id,targetId:page.targetId}));
 }else{
  const {id,permit}=JSON.parse(await fs.readFile(dir+'/intent.json','utf8')),page=JSON.parse(await fs.readFile(dir+'/page.json','utf8'));
  if(mode==='close'){
   const closed=await pages.close(id,AbortSignal.timeout(20000));
   const proof=await runner.run(space.cliPath,`await useOrCreateTaskSpace(1);const snapshot={targetsAbsent:!(await listTabs()).some(t=>t.targetId===${JSON.stringify(page.targetId)})};`,AbortSignal.timeout(15000)) as any;
   if(!proof.targetsAbsent)throw Error('REGION.CLOSE_UNKNOWN');await admission.release(permit);
   await fs.writeFile(dir+'/closed-proof.json',JSON.stringify({closed,...proof,at:new Date().toISOString()}),{flag:'wx',mode:0o600});console.log(JSON.stringify({closed,...proof}));
  }else if(mode==='capture'&&scriptFile){
   await admission.requireHeld('mini-ego-space-1',permit.workflowId,permit.runId);
   const product=await new AmazonEgoReader({...space,targetId:page.targetId,sessionId:id}).product(scriptFile,AbortSignal.timeout(120000),async raw=>{
    await fs.writeFile(dir+'/capture-projection.json',JSON.stringify(raw),{flag:'wx',mode:0o600});
   },'10001');
   console.log(JSON.stringify({asin:product.asin,title:product.title,delivery:product.deliveryText,galleryCount:product.galleryCount,commerce:product.commerce}));
  }else if(mode==='step'&&scriptFile){
   await admission.requireHeld('mini-ego-space-1',permit.workflowId,permit.runId);
   const script=await fs.readFile(scriptFile,'utf8');
   const result=await runner.run(space.cliPath,`await useOrCreateTaskSpace(1);const tabs=await listTabs();if(!tabs.some(t=>t.targetId===${JSON.stringify(page.targetId)}))throw Error('TARGET_MISSING');await switchTab(${JSON.stringify(page.targetId)});`+script,AbortSignal.timeout(45000));
   await fs.writeFile(scriptFile+'.result.json',JSON.stringify(result),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
  }else throw Error('REGION.MODE');
 }
}finally{await db.end();}
