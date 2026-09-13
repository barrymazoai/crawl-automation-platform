import {readFile,writeFile,readdir} from "node:fs/promises";
import {hostname} from "node:os";
import {isDeepStrictEqual} from "node:util";
import {CatalogPageInputSchema,SwansonProductJobSchema} from "@crawl-automation/v3-contracts";
import {createR2Objects,sha256} from "@crawl-automation/v3-artifacts";
import {EgoCliRunner} from "@crawl-automation/v3-acquisition";

// Read-only closeout of a previously submitted, terminal representative batch.
// argv: Mini history work directory, current Mini deployment manifest.
if(!/^barrydeMac-mini(?:\.|$)/.test(hostname()))throw Error("Mini required");
const [work,manifestPath]=process.argv.slice(2);if(!work||!manifestPath)throw Error("Work directory and manifest required");
const read=async(p:string)=>JSON.parse(await readFile(p,"utf8")),dir=work+"/normal-recapture";
const report=await read(dir+"/acceptance.json");if(!report.businessComplete||report.held||report.guards)throw Error("Terminal batch required");
const manifest=await read(manifestPath),job=manifest.jobs.find((j:{id:string})=>j.id==="swanson-capture"),c=await read(job.env.V3_SWANSON_LIVE_CONFIG);
const ids=new Set<string>(),refs=new Map<string,{objectKey:string;sha256:string;byteSize?:number}>();
function scan(v:any){
  if(!v||typeof v!=="object")return;
  if(v.metadata&&v.data){try{scan(JSON.parse(Buffer.from(typeof v.data==="string"?v.data:v.data.data??v.data,typeof v.data==="string"?"base64":undefined).toString()));}catch{}return;}
  const cat=v.catalogId===report.requestId?CatalogPageInputSchema.safeParse(v):undefined;
  if(cat?.success)ids.add(`swanson-catalog-${sha256(Buffer.from(JSON.stringify(cat.data)))}`);
  if(v.codec==="swanson-product-job/1"){
    const j=SwansonProductJobSchema.parse(v);if(j.discovery.catalogId!==report.requestId)throw Error("Foreign job");
    ids.add(j.discovery.entry.kind==="family"?`${j.sessionId}-family`:j.sessionId);
  }
  if(typeof v.objectKey==="string"&&/^[a-f0-9]{64}$/.test(v.sha256)){
    const prior=refs.get(v.objectKey);if(prior&&prior.sha256!==v.sha256)throw Error("Conflicting evidence reference");
    refs.set(v.objectKey,{objectKey:v.objectKey,sha256:v.sha256,...(v.byteSize?{byteSize:v.byteSize}:{})});
  }
  for(const child of Object.values(v))scan(child);
}
for(const file of await readdir(dir))if(file.endsWith(".history.json"))scan(await read(dir+"/"+file));
scan(await read(dir+"/source-records.json"));
const pages=[];
for(const name of await readdir(c.pageJournalRoot+"/v3/browser-pages")){
  const path=c.pageJournalRoot+"/v3/browser-pages/"+name;
  const opened=await read(path+"/opened.json").catch(()=>null);if(!opened||!ids.has(opened.taskId))continue;
  const bytes=await readFile(path+"/closed.json");if(!isDeepStrictEqual(JSON.parse(bytes.toString()),opened))throw Error("Cleanup receipt mismatch");
  pages.push({taskId:opened.taskId,targetId:opened.targetId,closedPath:path+"/closed.json",sha256:sha256(bytes)});
}
if(ids.size!==5||pages.length!==5)throw Error(`Expected five exact owned pages, derived=${ids.size} found=${pages.length}`);
const rechecks=[];const runner=new EgoCliRunner();
for(let i=0;i<3;i++){
  const targets=await runner.run(c.browser.cliPath,`await useOrCreateTaskSpace(${c.browser.taskSpaceId});const snapshot=(await listTabs()).map(t=>({targetId:t.targetId}));`,AbortSignal.timeout(15000)) as {targetId:string}[];
  const absent=pages.every(p=>!targets.some(t=>t.targetId===p.targetId));rechecks.push({at:new Date().toISOString(),targetsAbsent:absent});
  if(!absent)throw Error("Owned target still present; preserve permit evidence");
}
const r2=createR2Objects(c.r2,c.r2Credentials),evidence=[];
try{for(const ref of refs.values()){
  const limit=ref.byteSize??8*1024*1024;if(!Number.isSafeInteger(limit)||limit<1||limit>128*1024*1024)throw Error("Evidence bound required");
  const bytes=await r2.store.read(ref.objectKey,limit,AbortSignal.timeout(30000));
  if(!bytes||sha256(bytes)!==ref.sha256||ref.byteSize&&bytes.length!==ref.byteSize)throw Error("Evidence readback mismatch");
  evidence.push({...ref,readbackBytes:bytes.length});
}}finally{r2.close();}
const result={at:new Date().toISOString(),requestId:report.requestId,passed:true,pages,rechecks,evidenceCount:evidence.length,evidence,browserCloseCalls:0};
await writeFile(dir+"/evidence-and-pages.json",JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,pages:pages.length,rechecks,evidence:evidence.length}));
