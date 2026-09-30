import { readFile,writeFile,mkdir } from "node:fs/promises";
import { join,resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { EgoTaskPages,EgoCliRunner } from "@crawl-automation/v3-acquisition";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { createR2Objects,RetainedPublication } from "@crawl-automation/v3-artifacts";
import { readGncPrivateJson } from "../src/gnc-config.js";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { parseSwansonRenderedCatalog } from "@crawl-automation/v3-channels";
async function main(){
  if(process.env.V3_SWANSON_CATALOG_INSPECT!=="true"||!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error("MINI_OPT_IN_REQUIRED");
  const [rootArg,browserDir,privatePath]=process.argv.slice(2);if(!rootArg||!browserDir||!privatePath)throw Error("PATHS_REQUIRED");
  const base=await readGncPrivateJson(privatePath) as any,browser=JSON.parse(await readFile(join(browserDir,"report.json"),"utf8"));
  if(base.r2.bucket!=="supply-smart-test"||new URL(base.reviewDatabase.connectionString).pathname!=="/crawler_v3_test"||browser.status!=="passed"||browser.brand.decision.status!=="resolved")throw Error("TEST_SCOPE_REQUIRED");
  const url=browser.brand.decision.url;if(url!=="https://www.swansonvitamins.com/collections/brand-ac-grace-company")throw Error("SCOPE_REJECTED");
  const id=`catalog-${randomUUID()}`,dir=join(resolve(rootArg),id);await mkdir(dir,{mode:0o700});
  const local=await TextLocalStore.open(join(dir,"journal")),space={engine:"ego-lite",sdk:"1",cliPath:"/Users/barry/.local/bin/ego-browser",taskSpaceId:1} as const;
  const pages=new EgoTaskPages(space,local),runner=new EgoCliRunner(),r2=createR2Objects({...base.r2,prefix:`${base.r2.prefix}/${id}`},base.r2Credentials);
  const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:2}),admission=new PostgresResourceAdmission(db);
  const permit={permitId:`permit-${id}`,workflowId:`manual-${id}`,runId:randomUUID(),needs:[{resourceId:"mini-ego-space-1",units:1}]};
  const report:any={id,status:"running",url,permit};let held=false;
  try{
    if((await admission.reserve(permit)).status!=="granted")throw Error("BROWSER_RESOURCE_UNAVAILABLE");held=true;
    const result=await pages.using(id,AbortSignal.timeout(90000),async page=>{
      const expression=`(()=>{const root=document.querySelector('#ResultsList');return {url:location.href,capturedAt:new Date().toISOString(),title:document.querySelector('h1')?.innerText,
        headingContext:document.querySelector('h1')?.parentElement?.innerText?.slice(0,2000),
        results:root?{tag:root.tagName,text:root.innerText,links:[...root.querySelectorAll('a[href]')].map(a=>({text:a.innerText,url:a.href,ariaLabel:a.getAttribute('aria-label')})),
          children:[...root.children].slice(0,12).map(e=>({tag:e.tagName,class:e.className,id:e.id,role:e.getAttribute('role')}))}:null,
        visibleControls:[...document.querySelectorAll('button,nav a')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>({tag:e.tagName,text:e.innerText,ariaLabel:e.getAttribute('aria-label'),disabled:e.disabled??null})).slice(0,100)};})()`;
      const script=`await useOrCreateTaskSpace(1);const tabs=await listTabs();const found=tabs.find(t=>t.targetId===${JSON.stringify(page.targetId)});if(!found)throw Error('TARGET_MISSING');
        await switchTab(found.targetId);await gotoAndWait(${JSON.stringify(url)},{timeout:20});
        const value=await js(${JSON.stringify(expression)});const image=await cdp('Page.captureScreenshot',{format:'png',fromSurface:false});
        const snapshot={value,screenshot:image.data};`;
      const out=await runner.run(page.cliPath,script,AbortSignal.timeout(45000)) as any;
      await writeFile(join(dir,"catalog.png"),Buffer.from(out.screenshot,"base64"));
      await writeFile(join(dir,"public.json"),JSON.stringify(out.value,null,2));
      await new RetainedPublication(local,r2.store).publish(`v3/catalog-inspect/${id}/public.json`,Buffer.from(JSON.stringify(out.value)),"application/json",AbortSignal.timeout(30000));
      return out.value;
    });
    report.pageClosed=true;report.public=result;await admission.release(permit);held=false;
    report.catalog=parseSwansonRenderedCatalog(result,url,browser.brand.decision.matchedName);report.status="captured";
  }catch(e){report.status="failed";report.error=e instanceof Error&&/^[A-Z0-9_.]+$/.test(e.message)?e.message:"INSPECT_LOCAL_EVIDENCE";process.exitCode=1;}
  finally{report.permitQuarantined=held;await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));r2.close();await db.end();console.log(JSON.stringify({report:join(dir,"report.json"),...report}));}
}
main().catch(()=>{console.error("CATALOG_INSPECT_FAILED");process.exitCode=1;});
