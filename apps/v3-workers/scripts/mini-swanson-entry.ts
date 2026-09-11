import assert from "node:assert/strict";
import {hostname} from "node:os";
import {randomUUID} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import pg from "pg";
import {EgoTaskPages,EgoCliRunner} from "@crawl-automation/v3-acquisition";
import {TextLocalStore} from "@crawl-automation/v3-text";
import {PostgresResourceAdmission} from "../../../packages/v3-product/src/resource-admission.js";

// One owned UI page per command. Submission is one click, never retried.
async function main(){
 assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
 const [mode,name,url]=process.argv.slice(2);assert.ok(mode==="inspect"||mode==="submit");assert.match(name!,/^[a-z0-9-]+$/);
 const u=new URL(url!);assert.equal(u.origin,"http://127.0.0.1:4188");assert.equal(u.pathname,"/v3-live.html");
 const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",dir=root+"/live/swanson-entry-20260911/"+name;
 await mkdir(root+"/live/swanson-entry-20260911",{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});
 const read=async(p:string)=>JSON.parse(await readFile(p,"utf8")),m=await read(root+"/live/deployment.json");
 assert.equal(new URL(m.database.connectionString).pathname,"/crawler_v3_test");
 if(mode==="submit"){
  assert.equal(u.searchParams.get("brand"),"5a2d5d6e-8a22-4575-9999-601ee8308704");assert.equal(u.searchParams.has("request"),false);
  assert.equal((await read(root+"/live/swanson-coverage-deployment-20260910/evidence/activation.json")).passed,true);
  assert.ok(m.jobs.filter((j:any)=>j.id==="swanson-product-workflow").every((j:any)=>j.entry.includes("release-swanson-coverage-20260910/")));
 }
 const db=new pg.Pool({connectionString:m.database.connectionString,max:2}),admission=new PostgresResourceAdmission(db),id="entry-"+randomUUID();
 const permit={permitId:"permit-"+id,workflowId:"manual-"+id,runId:randomUUID(),needs:[{resourceId:"mini-ego-space-1",units:1}]};
 const pages=new EgoTaskPages({engine:"ego-lite",sdk:"1",cliPath:"/Users/barry/.local/bin/ego-browser",taskSpaceId:1},await TextLocalStore.open(dir+"/journal")),runner=new EgoCliRunner();
 const report:any={id,mode,url,permit,held:false,pageClosed:false};
 try{
  assert.equal((await admission.reserve(permit)).status,"granted");report.held=true;
  await pages.using(id,AbortSignal.timeout(120000),async page=>{
   const select=`await useOrCreateTaskSpace(1);const tabs=await listTabs();if(!tabs.some(t=>t.targetId===${JSON.stringify(page.targetId)}))throw Error('TARGET_MISSING');await switchTab(${JSON.stringify(page.targetId)});`;
   const capture=`const value=await js('({url:location.href,body:document.body.innerText,buttons:[...document.querySelectorAll("button")].map(b=>({text:b.innerText,disabled:b.disabled}))})');const shot=await cdp('Page.captureScreenshot',{format:'png',fromSurface:false});const snapshot={value,image:shot.data};`;
   const readyExpression=u.searchParams.has("request")?`document.querySelector('[aria-label="真实交接状态"]')?.innerText.includes('COMPLETED')`:`document.body.innerText.includes('已保存采集记录')||document.body.innerText.includes('选择采集')||document.body.innerText.includes('Review 记录')`;
   const focus=u.searchParams.has("request")?`await js("document.querySelector('#collection')?.scrollIntoView({block:'start'})");await new Promise(r=>setTimeout(r,300));`:name?.startsWith("products-final")?`await js("[...document.querySelectorAll('tr')].find(r=>r.innerText.includes('8572274344074'))?.scrollIntoView({block:'center'})");await new Promise(r=>setTimeout(r,300));`:"";
   const initial=await runner.run(page.cliPath,select+`await gotoAndWait(${JSON.stringify(url)},{timeout:20});for(let n=0;n<60;n++){if(await js(${JSON.stringify(readyExpression)}))break;await new Promise(r=>setTimeout(r,200));}`+focus+capture,AbortSignal.timeout(45000)) as any;
   await writeFile(dir+"/before.json",JSON.stringify(initial.value,null,2));await writeFile(dir+"/before.png",Buffer.from(initial.image,"base64"));report.targetId=page.targetId;
   if(mode==="submit"){
    assert.match(initial.value.body,/A\.C\. Grace/i);assert.match(initial.value.body,/swanson/);
    const pick=`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='选择采集');if(b.length!==1||b[0].disabled)throw Error('SOURCE_NOT_UNIQUE');b[0].click();return true;})()`;
    const ready=`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='提交一次采集');return b.length===1&&!b[0].disabled&&document.querySelector('#collection')?.innerText.includes('swanson');})()`;
    await runner.run(page.cliPath,select+`await js(${JSON.stringify(pick)});let ready=false;for(let n=0;n<70;n++){if(await js(${JSON.stringify(ready)})){ready=true;break;}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Error('SUBMIT_NOT_READY');const snapshot={ready};`,AbortSignal.timeout(25000));
    await writeFile(dir+"/submit-intent.json",JSON.stringify({at:new Date().toISOString(),url,taskId:id,targetId:page.targetId}),{flag:"wx",mode:0o600});
    const click=`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='提交一次采集');if(b.length!==1||b[0].disabled)throw Error('SUBMIT_NOT_READY');b[0].click();})()`;
    const final=await runner.run(page.cliPath,select+`await js(${JSON.stringify(click)});let request=null;for(let n=0;n<100;n++){request=await js('new URL(location.href).searchParams.get("request")');if(request)break;await new Promise(r=>setTimeout(r,200));}if(!request)throw Error('SUBMISSION_UNRESOLVED');`+capture,AbortSignal.timeout(35000)) as any;
    await writeFile(dir+"/submitted.json",JSON.stringify(final.value,null,2));await writeFile(dir+"/submitted.png",Buffer.from(final.image,"base64"));report.requestId=new URL(final.value.url).searchParams.get("request");assert.match(report.requestId,/^[a-f0-9-]{36}$/);
   }
  });
  report.pageClosed=true;await admission.release(permit);report.held=false;report.status="passed";
 }catch(e){report.status="failed";report.error=e instanceof Error?e.message:"UNKNOWN";process.exitCode=1;}
 finally{report.at=new Date().toISOString();await writeFile(dir+"/report.json",JSON.stringify(report,null,2));await db.end();console.log(JSON.stringify({dir,...report}));}
}
main().catch(()=>{console.error("ENTRY_REJECTED");process.exitCode=1;});
