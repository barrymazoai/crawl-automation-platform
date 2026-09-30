import { describe,it,expect,vi } from "vitest";
import { EgoFileTransport,EGO_FILE_MAX_BYTES } from "./ego-file.js";
import { transportAddress } from "./network.js";
import { runInNewContext } from "node:vm";
import { acquireFile } from "./file.js";
import { fileInput, lease } from "./testing.fixture.js";
const pageUrl="https://www.gnc.com/energy/613701.html",url="https://www.gnc.com/image.jpg";
const config={browser:{engine:"ego-lite",sdk:"1",cliPath:"/usr/local/bin/ego-browser",taskSpaceId:1,targetId:"target",sessionId:"session"},pageUrl,allowedUrls:[url]} as const;
const signal=()=>new AbortController().signal;
function fixture(){const value={taskSpaceId:1,targetId:"target",pageUrl,url,status:200,contentType:"image/jpeg",body:"AQID",byteSize:3};
  const runner={run:vi.fn(async()=>value)};
  return {value,runner,transport:new EgoFileTransport({...config,allowedUrls:[url]},"ego-host/1",runner)};}
describe("Ego single file transport",()=>{
  it("uses browser resolution, no local DNS, exact URL, raw bytes and no navigation/credential export",async()=>{
    const f=fixture(),dns={resolve:vi.fn()};expect(await transportAddress(new URL(url),f.transport,dns,signal())).toBeUndefined();expect(dns.resolve).not.toHaveBeenCalled();
    const r=await f.transport.get(new URL(url),undefined,{},signal());const chunks=[];for await(const b of r.body)chunks.push(...b);
    expect(chunks).toEqual([1,2,3]);expect(r.headers).toEqual({"content-type":"image/jpeg","content-length":"3"});
    const script=(f.runner.run.mock.calls[0] as unknown as [string,string])[1];
    expect(script).toContain("redirect:'error'");expect(script).toContain("credentials:'same-origin'");
    expect(script).not.toMatch(/getCookies|Page.navigate|claimTaskSpace|takeOverTaskSpace|mouse|closeTab|canvas|serverFetch/);
  });
  it.each([{pageUrl:pageUrl+"?other"},{targetId:"other"},{taskSpaceId:2},{url:url+"?other"}])("rejects changed binding %j",async patch=>{
    const f=fixture();Object.assign(f.value,patch);await expect(f.transport.get(new URL(url),undefined,{},signal())).rejects.toThrow("SOURCE.SESSION_MISMATCH");});
  it.each([{status:0},{status:200.5},{status:600},{body:"AQI!"},{byteSize:2},{body:"AQID\n"},{byteSize:EGO_FILE_MAX_BYTES+1}])("rejects unverifiable response %j",async patch=>{
    const f=fixture();Object.assign(f.value,patch);await expect(f.transport.get(new URL(url),undefined,{},signal())).rejects.toThrow("ARTIFACT.INTEGRITY");});
  it("preserves HTTP failures, rather than treating HTML as an image",async()=>{const f=fixture();f.value.status=403;
    expect((await f.transport.get(new URL(url),undefined,{},signal())).status).toBe(403);});
  it("rejects foreign URL, headers, and pinned addresses before browser IO",async()=>{const f=fixture();
    await expect(f.transport.get(new URL(url+"?other"),undefined,{},signal())).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
    await expect(f.transport.get(new URL(url),undefined,{cookie:"foreign"},signal())).rejects.toThrow("SOURCE.SESSION_MISMATCH");
    await expect(f.transport.get(new URL(url),{address:"1.1.1.1",family:4},{},signal())).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();});
  it("does not retry a user-control refusal",async()=>{const f=fixture();f.runner.run.mockRejectedValue(Error("SOURCE.BROWSER_USER_CONTROL"));
    await expect(f.transport.get(new URL(url),undefined,{},signal())).rejects.toThrow("SOURCE.BROWSER_USER_CONTROL");expect(f.runner.run).toHaveBeenCalledTimes(1);});
  it("rejects overlap, late result after abort and pre-abort",async()=>{const f=fixture();let finish!:(v:typeof f.value)=>void;
    f.runner.run.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const c=new AbortController();
    const pending=f.transport.get(new URL(url),undefined,{},c.signal);
    await expect(f.transport.get(new URL(url),undefined,{},signal())).rejects.toThrow();c.abort(Error("cancelled"));finish(f.value);
    await expect(pending).rejects.toThrow("cancelled");await expect(f.transport.get(new URL(url),undefined,{},c.signal)).rejects.toThrow("cancelled");
    expect(f.runner.run).toHaveBeenCalledTimes(1);});
  it("bounds failures and supports SDK2 without adopting tabs",async()=>{const f=fixture();
    const runner={run:vi.fn(async()=>({taskSpaceId:1,targetId:"target",failure:"ARTIFACT.TOO_LARGE"}))};
    const t=new EgoFileTransport({...config,browser:{...config.browser,sdk:"2"},allowedUrls:[url]},"ego-host/1",runner);
    await expect(t.get(new URL(url),undefined,{},signal())).rejects.toThrow("ARTIFACT.TOO_LARGE");
    expect((runner.run.mock.calls[0] as unknown as [string,string])[1]).toContain("task.page(selected[0].label).evaluate");});
  it("closing response prevents consumption",async()=>{const f=fixture(),r=await f.transport.get(new URL(url),undefined,{},signal());r.close();
    expect((await r.body[Symbol.asyncIterator]().next()).done).toBe(true);});
});

describe("actual generated browser fetch script",()=>{
  function pageRunner(fetch:typeof globalThis.fetch, tabs=[{targetId:"target",url:pageUrl}], currentUrl=pageUrl){return {run:async(_cli:string,script:string,_signal:AbortSignal)=>{
    const context={useOrCreateTaskSpace:async()=>{},listTabs:async()=>tabs,switchTab:async()=>{},
      js:async(expression:string)=>runInNewContext(expression,{location:{href:currentUrl},fetch,AbortController,setTimeout,clearTimeout,btoa})};
    return runInNewContext(`(async()=>{${script};return snapshot;})()`,context);
  }};}
  it("returns byte-exact response and rejects automatic redirect configuration",async()=>{
    const bytes=Uint8Array.from([0,128,255,10,13]);
    const fetch=vi.fn(async(_url:unknown,options:any)=>{expect(_url).toBe(url);expect(options.redirect).toBe("error");expect(options.credentials).toBe("same-origin");
      const response=new Response(bytes,{headers:{"content-type":"image/png","content-encoding":"gzip","content-length":"100"}});
      Object.defineProperty(response,"url",{value:url});return response;});
    const transport=new EgoFileTransport({...config,allowedUrls:[url]},"ego-host/1",pageRunner(fetch));
    const r=await transport.get(new URL(url),undefined,{},signal());const out=[];for await(const chunk of r.body)out.push(...chunk);
    expect(out).toEqual([...bytes]);expect(r.headers["content-length"]).toBe("5");expect(r.headers["content-encoding"]).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds decoded body before serializing it",async()=>{
    const transport=new EgoFileTransport({...config,allowedUrls:[url]},"ego-host/1",pageRunner(async()=>{
      const response=new Response(new Uint8Array(EGO_FILE_MAX_BYTES+1));Object.defineProperty(response,"url",{value:url});return response;
    }));await expect(transport.get(new URL(url),undefined,{},signal())).rejects.toThrow("ARTIFACT.TOO_LARGE");
  });
  it("does not retry fetch/CORS errors",async()=>{
    const fetch=vi.fn(async()=>{throw TypeError("Failed to fetch");});
    const transport=new EgoFileTransport({...config,allowedUrls:[url]},"ego-host/1",pageRunner(fetch));
    await expect(transport.get(new URL(url),undefined,{},signal())).rejects.toThrow("SOURCE.NETWORK_UNAVAILABLE");expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['query','target','missing','duplicate','navigation'])('keeps %s mismatch distinct from a network error through file acquisition',async mode=>{
    const input=fileInput(),base=lease(),fetch=vi.fn(async()=>new Response());
    const tabs=mode==='missing'?[]:mode==='duplicate'?[{targetId:'target',url:pageUrl},{targetId:'target',url:pageUrl}]:[{targetId:mode==='target'?'foreign':'target',url:mode==='query'?pageUrl+'?th=1':pageUrl}];
    const transport=new EgoFileTransport({...config,allowedUrls:[base.url]},base.binding.egressId,pageRunner(fetch,tabs,mode==='navigation'?pageUrl+'?changed=1':pageUrl));
    const dns={resolve:vi.fn()};
    await expect(acquireFile(input,{access:{acquire:async()=>({...base,transport,headersFor:()=>({})})},dns},signal())).rejects.toThrow('SOURCE.SESSION_MISMATCH');
    expect(fetch).not.toHaveBeenCalled();expect(dns.resolve).not.toHaveBeenCalled();
  });
  it('does not silently strip query parameters when binding the verified observed URL',async()=>{
    const observed=pageUrl+'?th=1',fetch=vi.fn(async()=>{const r=new Response(Uint8Array.from([1,2,3]));Object.defineProperty(r,'url',{value:url});return r;});
    const transport=new EgoFileTransport({...config,pageUrl:observed,allowedUrls:[url]},'ego-host/1',pageRunner(fetch,[{targetId:'target',url:observed}],observed));
    expect((await transport.get(new URL(url),undefined,{},signal())).status).toBe(200);expect(fetch).toHaveBeenCalledOnce();
  });
  it('reports an unverified response URL as integrity failure',async()=>{
    const transport=new EgoFileTransport({...config,allowedUrls:[url]},'ego-host/1',pageRunner(async()=>{const r=new Response();Object.defineProperty(r,'url',{value:url+'?other'});return r;}));
    await expect(transport.get(new URL(url),undefined,{},signal())).rejects.toThrow('ARTIFACT.INTEGRITY');
  });
});
