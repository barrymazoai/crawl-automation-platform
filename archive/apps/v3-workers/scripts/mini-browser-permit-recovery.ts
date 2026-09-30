import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import pg from "pg";
import { EgoTaskPages } from "@crawl-automation/v3-acquisition";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { readGncPrivateJson } from "../src/gnc-config.js";
// Explicit recovery of this browser proof only, never a blanket resource reset.
async function main(){
 const [flag,dir,configPath]=process.argv.slice(2);
 if(flag!=="--verify-closed-proof"||!dir||!configPath||!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error("MINI_RECOVERY_SCOPE_REQUIRED");
 const report=JSON.parse(await readFile(join(dir,"report.json"),"utf8")),base=await readGncPrivateJson(configPath) as any;
 if(report.status!=="failed"||report.error!=="BRAND_LINK.URL_REJECTED"||report.products.length||!report.id.startsWith("swanson-browser-")||
   new URL(base.reviewDatabase.connectionString).pathname!=="/crawler_v3_test"||report.permit.workflowId!==`manual-${report.id}`)throw Error("RECOVERY_PROOF_MISMATCH");
 const journal=await TextLocalStore.open(join(dir,"journal"));
 // Require a prior closed receipt. Recovery has no browser capability at all.
 const pages=new EgoTaskPages({engine:"ego-lite",sdk:"1",cliPath:"/Users/barry/.local/bin/ego-browser",taskSpaceId:1},journal,{run:async()=>{throw Error("BROWSER_ACTION_FORBIDDEN");}});
 const closed=await pages.close(`brands-${report.id}`,AbortSignal.timeout(10000));if(closed.status!=="closed")throw Error("CLOSE_RECEIPT_REQUIRED");
 const db=new pg.Pool({connectionString:base.reviewDatabase.connectionString,max:1});
 try{
   const admission=new PostgresResourceAdmission(db),result=await admission.release(report.permit);
   await writeFile(join(dir,"cleanup-recovery.json"),JSON.stringify({closed,result,at:new Date().toISOString()},null,2));
   console.log(JSON.stringify({status:"released-after-verified-close",taskId:closed.taskId}));
 }finally{await db.end();}
}
main().catch(()=>{console.error("BROWSER_RECOVERY_UNVERIFIED");process.exitCode=1;});
