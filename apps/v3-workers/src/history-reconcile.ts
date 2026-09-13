import {readFile} from "node:fs/promises";
import pg from "pg";
import {createR2Objects} from "@crawl-automation/v3-artifacts";
import {HistoryObservations} from "./history-observations.js";
import {assertV3Database} from "../../v3-api/src/bootstrap/schema.js";
import {readGncPrivateJson} from "./gnc-config.js";

async function main(){
 if(process.platform!=="darwin")throw Error("HISTORY.MINI_REQUIRED");
 const [mode,path,input]=process.argv.slice(2);
 if(!mode||!["channel","gnc","collected","replay"].includes(mode)||!path||!input)throw Error("HISTORY.USAGE_MODE_PRIVATE_CONFIG_INPUT");
 const c=await readGncPrivateJson(path) as {database?:{connectionString:string;tls:boolean};reviewDatabase?:{connectionString:string;tls:boolean};r2:Parameters<typeof createR2Objects>[0];r2Credentials:Parameters<typeof createR2Objects>[1]};
 const cfg=c.database??c.reviewDatabase;if(!cfg)throw Error("HISTORY.DATABASE_REQUIRED");
 const db=new pg.Pool({connectionString:cfg.connectionString,ssl:cfg.tls?{rejectUnauthorized:true}:false,max:2,connectionTimeoutMillis:5000,statement_timeout:60000}),r2=createR2Objects(c.r2,c.r2Credentials);
 try{await assertV3Database(db);const h=new HistoryObservations(db,r2.store),s=AbortSignal.timeout(120000);
  const result=mode==="replay"?await h.replay(input,s):mode==="collected"?await h.collected(input):await h[mode as "channel"|"gnc"](JSON.parse(await readFile(input,"utf8")),s);
  console.log(JSON.stringify({event:"HISTORY_RECONCILED",mode,...(result&&'status' in result?{status:result.status}:{status:"saved"})}));
  if(result&&'status' in result&&result.status!=="saved")process.exitCode=2;
 }finally{r2.close();await db.end();}
}
main().catch(e=>{console.error(JSON.stringify({event:"HISTORY_RECONCILE_FAILED",code:e instanceof Error&&/^HISTORY\.[A-Z_]+$/.test(e.message)?e.message:"HISTORY.UNAVAILABLE"}));process.exitCode=1;});
