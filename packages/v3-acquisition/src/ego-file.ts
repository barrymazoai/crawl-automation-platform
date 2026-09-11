import { z } from "zod";
import { EgoBrowserConfigSchema, EgoCliRunner, type EgoCommandRunner } from "./ego-browser.js";
import { AcquisitionError, type Address, type FileTransport, type Response } from "./ports.js";
import { permittedUrl } from "./network.js";

// Deliberately bounded below the CLI's 8 MiB private JSON envelope, not the generic 32 MiB policy.
export const EGO_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const EgoFileConfigSchema = z.strictObject({ browser: EgoBrowserConfigSchema,
  pageUrl: z.string().url(), allowedUrls: z.array(z.string().url()).min(1).max(100) });
type Config = z.infer<typeof EgoFileConfigSchema>;
const Snapshot = z.strictObject({ taskSpaceId:z.number().int(), targetId:z.string(), pageUrl:z.string(),
  url:z.string(), status:z.number().int().min(100).max(599), contentType:z.string().max(1024),
  body:z.string().max(Math.ceil(EGO_FILE_MAX_BYTES / 3) * 4), byteSize:z.number().int().min(0).max(EGO_FILE_MAX_BYTES),
});

/** One exact resource through an already-owned browser page. No cookies exported, navigation,
 * redirect, retry, fallback, proxy switch, or canvas/image re-encoding. Browser owns DNS/TLS/CORS.
 * The coordinator must exclusively lease this task space across processes for the grant lifetime.
 */
export class EgoFileTransport implements FileTransport {
  readonly targetResolution = "browser" as const;
  private readonly config: Config;
  private busy = false;
  constructor(raw: Config, readonly egressId: string, private readonly runner: EgoCommandRunner = new EgoCliRunner()) {
    this.config = EgoFileConfigSchema.parse(raw);
    if (!egressId) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    for (const url of [this.config.pageUrl,...this.config.allowedUrls])
      if (permittedUrl(url,[new URL(url).origin]).href !== url) throw new AcquisitionError("SOURCE.ORIGIN_BLOCKED");
  }
  async get(url: URL, address: Address | undefined, headers: Readonly<Record<string,string>>, abort: AbortSignal): Promise<Response> {
    abort.throwIfAborted();
    const c = this.config, b = c.browser;
    if (!c.allowedUrls.includes(url.href)) throw new AcquisitionError("SOURCE.ORIGIN_BLOCKED");
    // Browser supplies its own cookie/header context. Do not silently ignore a foreign session grant.
    if (address !== undefined || Object.keys(headers).length || this.busy) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    this.busy = true;
    const signal = AbortSignal.any([abort,AbortSignal.timeout(30000)]);
    const expression = `(async () => {
      if(location.href!==${JSON.stringify(c.pageUrl)})throw Error('EGO_PAGE_CHANGED');
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
      try {
        const response=await fetch(${JSON.stringify(url.href)},{method:'GET',credentials:'same-origin',redirect:'error',signal:controller.signal});
        if(response.type==='opaque'||response.redirected||response.url!==${JSON.stringify(url.href)})throw Error('EGO_RESPONSE_UNVERIFIED');
        const reader=response.body?.getReader();const chunks=[];let length=0;
        if(reader)try {while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;
          if(length>${EGO_FILE_MAX_BYTES})throw Error('EGO_FILE_LIMIT');chunks.push(r.value);}}
        finally{await reader.cancel();}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
        if(location.href!==${JSON.stringify(c.pageUrl)})throw Error('EGO_PAGE_CHANGED');
        return {pageUrl:location.href,url:response.url,status:response.status,contentType:response.headers.get('content-type')||'',body:btoa(binary),byteSize:length};
      }catch(error){return {failure:error?.message==='EGO_FILE_LIMIT'?'ARTIFACT.TOO_LARGE':error?.message==='EGO_PAGE_CHANGED'?'SOURCE.SESSION_MISMATCH':'SOURCE.NETWORK_UNAVAILABLE'};}
      finally{clearTimeout(timer);controller.abort();}
    })()`;
    const selection = `const selected=tabs.filter(t=>t.targetId===${JSON.stringify(b.targetId)}&&t.url===${JSON.stringify(c.pageUrl)}${b.sdk==="2"?"&&t.label":""});
if(selected.length!==1)throw Error('EGO_TARGET_MISMATCH');`;
    const script = b.sdk === "1" ? `await useOrCreateTaskSpace(${b.taskSpaceId});const tabs=await listTabs();${selection}
await switchTab(selected[0].targetId);const value=await js(${JSON.stringify(expression)});
const snapshot={taskSpaceId:${b.taskSpaceId},targetId:selected[0].targetId,...value};` :
      `const task=await taskSpace(${b.taskSpaceId});const tabs=await task.tabs();${selection}
const value=await task.page(selected[0].label).evaluate(${JSON.stringify(expression)});
const snapshot={taskSpaceId:${b.taskSpaceId},targetId:selected[0].targetId,...value};`;
    try {
      const raw = await this.runner.run(b.cliPath,script,signal).catch(error=>{
        if(error instanceof Error && (error.message==="SOURCE.BROWSER_USER_CONTROL" ||
          ("code" in error && error.code==="SOURCE.BROWSER_USER_CONTROL")))throw new AcquisitionError("SOURCE.BROWSER_USER_CONTROL");
        throw error;
      });
      signal.throwIfAborted();
      const failure = z.strictObject({taskSpaceId:z.literal(b.taskSpaceId),targetId:z.literal(b.targetId),
        failure:z.enum(["ARTIFACT.TOO_LARGE","SOURCE.SESSION_MISMATCH","SOURCE.NETWORK_UNAVAILABLE"])}).safeParse(raw);
      if(failure.success)throw new AcquisitionError(failure.data.failure);
      const parsed=Snapshot.safeParse(raw);
      if(!parsed.success)throw new AcquisitionError("ARTIFACT.INTEGRITY");
      const value=parsed.data;
      if(value.taskSpaceId!==b.taskSpaceId||value.targetId!==b.targetId||value.pageUrl!==c.pageUrl||value.url!==url.href)
        throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
      const bytes=Buffer.from(value.body,"base64");
      if(bytes.toString("base64")!==value.body||bytes.length!==value.byteSize)throw new AcquisitionError("ARTIFACT.INTEGRITY");
      let closed=false;
      // Fetch has already decoded any HTTP content encoding. Describe the delivered entity bytes,
      // not the wire content-length. No pixel compression/resizing is performed here.
      return {status:value.status,headers:{"content-type":value.contentType,"content-length":String(bytes.length)},
        body:(async function*(){signal.throwIfAborted();if(!closed)yield bytes;})(),close(){closed=true;}};
    } finally {this.busy=false;}
  }
}
