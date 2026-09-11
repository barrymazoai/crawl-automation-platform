import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { ExecutionIdSchema } from "@crawl-automation/v3-contracts";
import { sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { BrowserError } from "./browser.js";

export const CdpTaskConfigSchema = z.strictObject({
  endpoint: z.string().url().refine(v => { const u=new URL(v); return u.protocol==="http:"&&u.hostname==="127.0.0.1"&&!!u.port&&u.pathname==="/"&&!u.search&&!u.hash&&!u.username&&!u.password; }),
  instanceId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  pauseFile: z.string().refine(isAbsolute),
});
export type CdpTaskConfig = z.infer<typeof CdpTaskConfigSchema>;
export type CdpTarget = { id:string; type:string; url:string; openerId?:string|undefined };
export interface CdpTaskPort {
  guard(signal:AbortSignal):Promise<void>;
  list(signal:AbortSignal):Promise<CdpTarget[]>;
  create(marker:string,signal:AbortSignal):Promise<string>;
  close(targetId:string,signal:AbortSignal):Promise<void>;
  call(targetId:string,method:string,params:object,signal:AbortSignal):Promise<any>;
}
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
const fail=(code:string):never=>{throw new BrowserError(code);};
const Target=z.object({id:z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),type:z.string(),url:z.string(),openerId:z.string().optional()});

/** Loopback only, fixed browser instance; no browser launch, proxy changes or cookie export. */
export class LoopbackCdp implements CdpTaskPort {
  readonly config:CdpTaskConfig;
  constructor(raw:CdpTaskConfig){this.config=CdpTaskConfigSchema.parse(raw);}
  private async http(path:string,method:string,signal:AbortSignal){
    const r=await fetch(new URL(path,this.config.endpoint),{method,signal,redirect:"error"});
    if(!r.ok){await r.body?.cancel();fail("SOURCE.BROWSER_UNAVAILABLE");}
    const chunks:Uint8Array[]=[];let size=0;
    for await(const b of r.body!){size+=b.length;if(size>2*1024*1024)fail("SOURCE.BROWSER_PROTOCOL");chunks.push(b);}
    return Buffer.concat(chunks).toString("utf8");
  }
  async guard(signal:AbortSignal){
    signal.throwIfAborted();
    try{await stat(this.config.pauseFile);fail("SOURCE.BROWSER_USER_CONTROL");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const version=JSON.parse(await this.http("/json/version","GET",signal));
    if(version.webSocketDebuggerUrl!==this.config.endpoint.replace("http:","ws:").replace(/\/$/,"")+"/devtools/browser/"+this.config.instanceId)fail("SOURCE.BROWSER_INSTANCE_CHANGED");
  }
  async list(signal:AbortSignal){
    await this.guard(signal);
    // /json/list omits openerId on Chrome; Target.getTargets retains popup ancestry.
    const result=await this.rpc("/devtools/browser/"+this.config.instanceId,"Target.getTargets",{},signal);
    return z.array(Target).max(1000).parse(result.targetInfos.map((t:any)=>({...t,id:t.targetId})));
  }
  async create(marker:string,signal:AbortSignal){await this.guard(signal);return Target.parse(JSON.parse(await this.http("/json/new?"+encodeURIComponent(marker),"PUT",signal))).id;}
  async close(id:string,signal:AbortSignal){await this.guard(signal);Target.shape.id.parse(id);await this.http("/json/close/"+id,"GET",signal);}
  async call(targetId:string,method:string,params:object,signal:AbortSignal){
    if(!(await this.list(signal)).some(t=>t.id===targetId&&t.type==="page"))fail("SOURCE.TARGET_MISSING");
    return this.rpc("/devtools/page/"+targetId,method,params,signal);
  }
  private async rpc(path:string,method:string,params:object,signal:AbortSignal){
    signal.throwIfAborted();
    const ws=new WebSocket(this.config.endpoint.replace("http:","ws:").replace(/\/$/,"")+path);
    const lifetime=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
    try{return await new Promise<any>((resolve,reject)=>{
      const abort=()=>{ws.close();reject(new BrowserError("SOURCE.BROWSER_INTERRUPTED"));};
      const done=(error:Error|null,value?:unknown)=>{lifetime.removeEventListener("abort",abort);error?reject(error):resolve(value);};
      lifetime.addEventListener("abort",abort,{once:true});if(lifetime.aborted){abort();return;}
      ws.addEventListener("open",()=>ws.send(JSON.stringify({id:1,method,params})),{once:true});
      ws.addEventListener("error",()=>done(new BrowserError("SOURCE.BROWSER_UNAVAILABLE")),{once:true});
      ws.addEventListener("close",()=>done(new BrowserError("SOURCE.BROWSER_DISCONNECTED")),{once:true});
      ws.addEventListener("message",event=>{try{if(String(event.data).length>8*1024*1024)throw Error();const m=JSON.parse(String(event.data));if(m.id!==1)return;if(m.error)throw Error();done(null,m.result);}catch{done(new BrowserError("SOURCE.BROWSER_PROTOCOL"));}});
    });}finally{ws.close();}
  }
}

export type CdpOwnedPage = {taskId:string;targetId:string;config:CdpTaskConfig};
/** Caller holds the global browser lease. Persistent identity survives Worker crashes.
 * Recovery closes only exact owned targets/descendants, never by host/domain/window. */
export class CdpTaskPages {
  readonly config:CdpTaskConfig;
  constructor(raw:CdpTaskConfig,readonly journal:ObjectStore,readonly port:CdpTaskPort=new LoopbackCdp(raw)){this.config=CdpTaskConfigSchema.parse(raw);}
  private key(id:string,name:string){ExecutionIdSchema.parse(id);return `v3/cdp-pages/${sha256(encode([this.config,id]))}/${name}.json`;}
  private async read(id:string,name:string,s:AbortSignal){const b=await this.journal.read(this.key(id,name),65536,s);return b?JSON.parse(Buffer.from(b).toString()):null;}
  private async save(id:string,name:string,v:unknown,s:AbortSignal){await this.journal.create(this.key(id,name),encode(v),"application/json",s);if(!equal(await this.read(id,name,s),v))fail("SOURCE.PAGE_JOURNAL_CONFLICT");}
  private verify(raw:any,id:string):CdpOwnedPage{if(raw?.taskId!==id||!equal(raw.config,this.config)||!Target.shape.id.safeParse(raw.targetId).success)fail("SOURCE.PAGE_JOURNAL_CONFLICT");return raw;}
  async open(id:string,s:AbortSignal):Promise<CdpOwnedPage>{
    await this.port.guard(s);if(await this.read(id,"closed",s))fail("SOURCE.PAGE_ALREADY_CLOSED");
    const old=await this.read(id,"opened",s);if(old){const p=this.verify(old,id);if(!(await this.port.list(s)).some(t=>t.id===p.targetId))fail("SOURCE.TARGET_MISSING");return p;}
    const intent={taskId:id,config:this.config,marker:`about:blank#crawlv3-${randomUUID()}`};
    if(await this.journal.create(this.key(id,"intent"),encode(intent),"application/json",s)!=="created")fail("SOURCE.PAGE_OPEN_UNKNOWN");
    const targetId=await this.port.create(intent.marker,s),p={taskId:id,targetId,config:this.config};
    const tabs=await this.port.list(s);if(!tabs.some(t=>t.id===targetId&&t.url===intent.marker&&t.type==="page"))fail("SOURCE.PAGE_OPEN_UNKNOWN");
    await this.save(id,"opened",p,AbortSignal.timeout(10000));return p;
  }
  async close(id:string,s:AbortSignal){
    await this.port.guard(s);const closed=await this.read(id,"closed",s);
    if(closed){this.verify(closed.page,id);if((await this.port.list(s)).some(t=>closed.targets.includes(t.id)))fail("SOURCE.PAGE_CLOSE_UNKNOWN");return {taskId:id,status:"closed" as const,targetId:closed.page.targetId};}
    let raw=await this.read(id,"opened",s);
    if(!raw){const intent=await this.read(id,"intent",s);if(!intent)return {taskId:id,status:"not-opened" as const,targetId:null};
      if(intent.taskId!==id||!equal(intent.config,this.config)||!/^about:blank#crawlv3-[a-f0-9-]{36}$/.test(intent.marker))fail("SOURCE.PAGE_JOURNAL_CONFLICT");
      const found=(await this.port.list(s)).filter(t=>t.type==="page"&&t.url===intent.marker);if(found.length!==1)fail("SOURCE.PAGE_OPEN_UNKNOWN");
      raw={taskId:id,config:this.config,targetId:found[0]!.id};await this.save(id,"opened",raw,s);
    }
    const page=this.verify(raw,id),prior=await this.read(id,"close-intent",s),tabs=await this.port.list(s);
    const owned=new Set<string>(prior?.targets??[page.targetId]);if(prior&&!equal(prior.page,page))fail("SOURCE.PAGE_JOURNAL_CONFLICT");
    for(let n=0;n<tabs.length;n++)for(const t of tabs)if(t.openerId&&owned.has(t.openerId)&&t.type==="page")owned.add(t.id);
    const targets=[...owned].sort();if(targets.length>100)fail("SOURCE.PAGE_CLOSE_UNKNOWN");
    // A new descendant after an earlier close intent requires inspection, never widening a stale receipt.
    await this.save(id,"close-intent",{page,targets},s);
    for(const target of targets.filter(t=>t!==page.targetId).concat(page.targetId))if((await this.port.list(s)).some(t=>t.id===target))await this.port.close(target,s);
    for(let n=0;n<30;n++){const remaining=await this.port.list(s);if(!remaining.some(t=>owned.has(t.id)||t.openerId&&owned.has(t.openerId))){await this.save(id,"closed",{page,targets},s);return {taskId:id,status:"closed" as const,targetId:page.targetId};}await new Promise(r=>setTimeout(r,100));}
    throw new BrowserError("SOURCE.PAGE_CLOSE_UNKNOWN");
  }
  async using<T>(id:string,s:AbortSignal,work:(page:CdpOwnedPage)=>Promise<T>):Promise<T>{
    let value:T|undefined,error:unknown;
    try{value=await work(await this.open(id,s));}catch(e){error=e;}
    if(error instanceof Error&&error.message==="SOURCE.BROWSER_USER_CONTROL")throw error;
    try{await this.close(id,AbortSignal.timeout(15000));}catch(cleanup){throw new AggregateError([error,cleanup].filter(Boolean),"SOURCE.PAGE_CLEANUP_PENDING");}
    if(error)throw error;return value as T;
  }
}
