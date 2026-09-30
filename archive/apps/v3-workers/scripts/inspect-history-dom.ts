import {readFile,writeFile,mkdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {hostname} from "node:os";
import pg from "pg";
import {EgoTaskPages,EgoCliRunner} from "@crawl-automation/v3-acquisition";
import {TextLocalStore} from "@crawl-automation/v3-text";
import {PostgresResourceAdmission} from "../../../packages/v3-product/src/resource-admission.js";
import {SwansonEgoReader} from "@crawl-automation/v3-channels";

if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error("Mini required");
const root="/Users/barry/apps/crawlv3-batch-a.UiA4dx",dir="/Users/barry/apps/crawlv3-history-20260913/dom-commerce-proof",read=async(p:string)=>JSON.parse(await readFile(p,"utf8"));
await mkdir(dir,{recursive:true,mode:0o700});
const m=await read(root+"/live/deployment.json"),j=m.jobs.find((j:{id:string})=>j.id==="swanson-capture"),c=await read(j.env.V3_SWANSON_LIVE_CONFIG);
const db=new pg.Pool({connectionString:m.database.connectionString,max:2,statement_timeout:5000}),admission=new PostgresResourceAdmission(db),id="history-dom-"+randomUUID();
const permit={permitId:"permit-"+id,workflowId:"manual-"+id,runId:randomUUID(),needs:[{resourceId:"mini-ego-space-1",units:1}]};
const url="https://www.swansonvitamins.com/collections/brand-ac-grace-company/p/a-c-grace-company-unique-e-tocopherols-120-sgels";
const pages=new EgoTaskPages(c.browser,await TextLocalStore.open(dir+"/journal")),runner=new EgoCliRunner();
const report:{[key:string]:unknown}={id,url,permit,held:false,closed:false};
try{
 if((await admission.reserve(permit)).status!=="granted")throw Error("Browser unavailable");report.held=true;
 await pages.using(id,AbortSignal.timeout(90000),async page=>{
  report.targetId=page.targetId;
  const expression=`(()=>{const m=document.querySelector('main');if(!m)throw Error('MAIN_MISSING');const parents=e=>{const a=[];for(let p=e,n=0;p&&n<4;p=p.parentElement,n++)a.push({tag:p.tagName,id:p.id,class:p.className});return a;};return {url:location.href,title:document.title,text:m.innerText.slice(0,24000),fields:[...m.querySelectorAll('[class*="price"],[class*="sku"],[itemprop],[data-product-sku],[class*="review"],[class*="rating"]')].slice(0,120).map(e=>({tag:e.tagName,attributes:Object.fromEntries([...e.attributes].map(a=>[a.name,a.value])),text:(e.innerText||'').slice(0,500),parents:parents(e)}))};})()`;
  const script=`await useOrCreateTaskSpace(${c.browser.taskSpaceId});const tabs=await listTabs();if(!tabs.some(t=>t.targetId===${JSON.stringify(page.targetId)}))throw Error('TARGET_MISSING');await switchTab(${JSON.stringify(page.targetId)});await gotoAndWait(${JSON.stringify(url)},{timeout:20});const snapshot=await js(${JSON.stringify(expression)});`;
  const result=await runner.run(page.cliPath,script,AbortSignal.timeout(45000));await writeFile(dir+"/page.json",JSON.stringify(result,null,2),{mode:0o600});report.captured=true;
  const projection=await new SwansonEgoReader(page).product(url,AbortSignal.timeout(45000));
  await writeFile(dir+"/projection.json",JSON.stringify(projection,null,2),{mode:0o600});
  report.commerce=projection.commerce;
 });
 report.closed=true;
}catch(e){report.error=e instanceof Error?e.message:"unknown";process.exitCode=1;}
finally{
 // using() verifies exact target absence; a failed cleanup never frees its lease.
 if(report.closed){await admission.release(permit);report.held=false;}
 report.at=new Date().toISOString();await writeFile(dir+"/report.json",JSON.stringify(report,null,2),{mode:0o600});await db.end();console.log(JSON.stringify(report));
}
