import {z} from "zod";
import{AcquisitionError,type FileTransport,type Address,type Response}from"./ports.js";
import{type CdpTaskPort,type CdpOwnedPage}from"./cdp-task-pages.js";
import{permittedUrl}from"./network.js";
export const CDP_FILE_MAX_BYTES=4*1024*1024;
export class CdpOwnedFileTransport implements FileTransport{
 readonly targetResolution="browser" as const;private busy=false;
 constructor(readonly page:CdpOwnedPage,readonly port:CdpTaskPort,readonly pageUrl:string,readonly allowedUrls:string[],readonly egressId:string){}
 async get(url:URL,address:Address|undefined,headers:Readonly<Record<string,string>>,abort:AbortSignal):Promise<Response>{
  abort.throwIfAborted();if(address!==undefined||Object.keys(headers).length||this.busy||!this.allowedUrls.includes(url.href))throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
  permittedUrl(url.href,[new URL(url.href).origin]);this.busy=true;const signal=AbortSignal.any([abort,AbortSignal.timeout(30000)]),c={pageUrl:this.pageUrl};
    const expression = `(async () => {
      if(location.href!==${JSON.stringify(c.pageUrl)})throw Error('DTC_PAGE_CHANGED');
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
      try {
        const response=await fetch(${JSON.stringify(url.href)},{method:'GET',credentials:'same-origin',redirect:'error',signal:controller.signal});
        if(response.type==='opaque'||response.redirected||response.url!==${JSON.stringify(url.href)})throw Error('DTC_RESPONSE_UNVERIFIED');
        const reader=response.body?.getReader();const chunks=[];let length=0;
        if(reader)try {while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;
          if(length>${CDP_FILE_MAX_BYTES})throw Error('DTC_FILE_LIMIT');chunks.push(r.value);}}
        finally{await reader.cancel();}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
        if(location.href!==${JSON.stringify(c.pageUrl)})throw Error('DTC_PAGE_CHANGED');
        return {pageUrl:location.href,url:response.url,status:response.status,contentType:response.headers.get('content-type')||'',body:btoa(binary),byteSize:length};
      }catch(error){return {failure:error?.message==='DTC_FILE_LIMIT'?'ARTIFACT.TOO_LARGE':error?.message==='DTC_PAGE_CHANGED'?'SOURCE.SESSION_MISMATCH':'SOURCE.NETWORK_UNAVAILABLE'};}
      finally{clearTimeout(timer);controller.abort();}
    })()`;

  try{const r=await this.port.call(this.page.targetId,"Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},signal);if(r.exceptionDetails)throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");const value=r.result?.value;
   if(value?.failure)throw new AcquisitionError(["ARTIFACT.TOO_LARGE","SOURCE.SESSION_MISMATCH"].includes(value.failure)?value.failure:"SOURCE.NETWORK_UNAVAILABLE");
   const v=z.object({pageUrl:z.literal(this.pageUrl),url:z.literal(url.href),status:z.number().int().min(100).max(599),contentType:z.string().max(1024),body:z.string().max(Math.ceil(CDP_FILE_MAX_BYTES/3)*4),byteSize:z.number().int().min(0).max(CDP_FILE_MAX_BYTES)}).parse(value);
   const b=Buffer.from(v.body,"base64");if(b.length!==v.byteSize||b.toString("base64")!==v.body)throw new AcquisitionError("ARTIFACT.INTEGRITY");let closed=false;
   return{status:v.status,headers:{"content-type":v.contentType,"content-length":String(b.length)},body:(async function*(){signal.throwIfAborted();if(!closed)yield b;})(),close(){closed=true;}};
  }finally{this.busy=false;}
 }
}
