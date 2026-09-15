import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { R2Objects, R2ScopeSchema, type R2Scope } from "./r2.js";

const scope: R2Scope = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "isolated-test", prefix: "v3-tests/contract-15", timeoutMs: 200, retries: 0 };
type Request = { method: string; hostname: string; path: string; headers: Record<string,string>; body?: unknown };
type Reply = { statusCode: number; headers: Record<string,string>; body: Readable };
const clients: S3Client[]=[];
function setup(handler: (request: Request) => Promise<Reply>, overrides: Partial<R2Scope> = {}) {
  // Real AWS serializer + SigV4, fake transport only. No sockets or R2 credentials.
  const client=new S3Client({endpoint:scope.endpoint,region:"auto",forcePathStyle:true,maxAttempts:1,
    credentials:{accessKeyId:"FAKE_TEST_KEY",secretAccessKey:"FAKE_TEST_SECRET"},
    requestChecksumCalculation:"WHEN_REQUIRED",responseChecksumValidation:"WHEN_REQUIRED",
    requestHandler:{handle:async(request:Request)=>({response:await handler(request)})}});
  clients.push(client); return new R2Objects(client,{...scope,...overrides});
}
const reply=(body: string|Uint8Array,statusCode=200):Reply=>({statusCode,headers:{},body:Readable.from([Buffer.from(body)])});
afterEach(()=>clients.splice(0).forEach(client=>client.destroy()));

describe("R2 adapter with actual AWS SDK serialization and fake transport",()=>{
  it("A04: creates fresh signed requests by stable key; no presigned URL in contract",async()=>{
    const seen:Request[]=[]; const store=setup(async request=>{seen.push(request);return reply("hello");});
    for(let i=0;i<2;i++) expect(await store.read("sources/image.png",20,new AbortController().signal)).toEqual(Buffer.from("hello"));
    expect(seen).toHaveLength(2);
    for(const request of seen){
      expect(request.path).toBe("/isolated-test/v3-tests/contract-15/sources/image.png");
      expect(request.headers.authorization).toContain("AWS4-HMAC-SHA256");
      expect(request.path).not.toContain("X-Amz-Signature");
    }
  });
  it("immutable PUT serializes If-None-Match and applies bucket/prefix restriction",async()=>{
    const seen:Request[]=[];const store=setup(async request=>{seen.push(request);return reply("");});
    expect(await store.create("results/file.txt",Buffer.from("hello"),"text/plain",new AbortController().signal)).toBe("created");
    expect(seen[0]?.method).toBe("PUT");expect(seen[0]?.headers["if-none-match"]).toBe("*");
    expect(seen[0]?.path).toBe("/isolated-test/v3-tests/contract-15/results/file.txt");
  });
  it("412 is existing evidence, never followed by an unconditional overwrite",async()=>{
    let calls=0;const store=setup(async()=>{calls++;return reply('<Error><Code>PreconditionFailed</Code></Error>',412);});
    expect(await store.create("x/file",Buffer.from("a"),"text/plain",new AbortController().signal)).toBe("exists");expect(calls).toBe(1);
  });
  it("transport failure makes one write attempt and suppresses sensitive error text",async()=>{
    let calls=0; const store=setup(async()=>{calls++;throw Error("secret signed authorization data");});
    await expect(store.create("x/file",Buffer.from("a"),"text/plain",new AbortController().signal)).rejects.toMatchObject({message:"ARTIFACT.UPLOAD_UNKNOWN"});
    expect(calls).toBe(1);
  });
  it('retains safe transport diagnostics without raw messages or headers',async()=>{
    const store=setup(async()=>{throw Object.assign(Error('Authorization=private-secret'),{name:'TimeoutError',code:'ETIMEDOUT',headers:{authorization:'private-secret'},$metadata:{httpStatusCode:503,requestId:'safe-request-id'}});});
    const e=await store.create('x/file',Buffer.from('a'),'text/plain',new AbortController().signal).catch(e=>e);
    expect(e.diagnostics).toMatchObject({name:'TimeoutError',code:'ETIMEDOUT',status:503,requestId:'safe-request-id'});
    expect(JSON.stringify(e)).not.toContain('private-secret');
  });
  it("expired credentials do not cause a URL/provider retry loop",async()=>{
    let calls=0;const store=setup(async()=>{calls++;return reply('<Error><Code>ExpiredToken</Code></Error>',403);});
    await expect(store.read("x/file",10,new AbortController().signal)).rejects.toMatchObject({code:"ARTIFACT.UNAVAILABLE"});expect(calls).toBe(1);
  });
  it("only NoSuchKey is missing; bucket/auth problems are unavailable",async()=>{
    const missing=setup(async()=>reply('<Error><Code>NoSuchKey</Code></Error>',404));
    expect(await missing.read("x/file",10,new AbortController().signal)).toBeNull();
    const bucket=setup(async()=>reply('<Error><Code>NoSuchBucket</Code></Error>',404));
    await expect(bucket.read("x/file",10,new AbortController().signal)).rejects.toMatchObject({code:"ARTIFACT.UNAVAILABLE"});
  });
  it("bounds actual response body and closes oversized streams",async()=>{
    const body=Readable.from([Buffer.alloc(6),Buffer.alloc(6)]); const store=setup(async()=>({statusCode:200,headers:{},body}));
    await expect(store.read("x/file",10,new AbortController().signal)).rejects.toMatchObject({code:"ARTIFACT.TOO_LARGE"});expect(body.destroyed).toBe(true);
  });
  it("bounds a stalled response after headers, not only the initial request",async()=>{
    const body=new Readable({read(){}}); const store=setup(async()=>({statusCode:200,headers:{},body}));
    await expect(store.read("x/file",10,new AbortController().signal)).rejects.toMatchObject({code:"ARTIFACT.UNAVAILABLE"});expect(body.destroyed).toBe(true);
  });
  it("unsafe keys and deployment endpoints are rejected before SDK requests",async()=>{
    let calls=0; const store=setup(async()=>{calls++;return reply("");});
    for(const key of ["../outside","https://signed.example/file?token=secret","/absolute"])
      await expect(store.read(key,10,new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(0);
    for(const change of [{endpoint:"http://localhost:9000"},{prefix:""},{prefix:"../outside"},{bucket:"other/bucket"}])
      expect(R2ScopeSchema.safeParse({...scope,...change}).success).toBe(false);
  });
});

describe("transient transport failures are retried; decided answers are not",()=>{
  const flaky=(fails:number,then:(request:Request)=>Promise<Reply>)=>{let n=0;return async(request:Request)=>{if(n++<fails){const e=new Error("read ECONNRESET");(e as {code?:string}).code="ECONNRESET";throw e;}return then(request);};};
  it("a reset mid-request is retried and the object still arrives",async()=>{
    const seen:Request[]=[];const store=setup(flaky(2,async r=>{seen.push(r);return reply("hello");}),{retries:3});
    expect(await store.read("sources/a.png",20,new AbortController().signal)).toEqual(Buffer.from("hello"));expect(seen).toHaveLength(1);
  },15000);
  it("a reset on an immutable put is retried; a 412 on the retry means the first attempt landed",async()=>{
    let calls=0;const store=setup(flaky(1,async()=>{calls++;return reply("",412);}),{retries:3});
    expect(await store.create("sources/b.png",Buffer.from("x"),"image/png",new AbortController().signal)).toBe("exists");expect(calls).toBe(1);
  },15000);
  it("404 and size limits are answers, not retried; exhausted retries surface as unavailable",async()=>{
    let calls=0;const missing=setup(async()=>{calls++;return {statusCode:404,headers:{},body:Readable.from([Buffer.from("<Error><Code>NoSuchKey</Code></Error>")])};},{retries:3});
    expect(await missing.read("sources/none.png",20,new AbortController().signal)).toBeNull();expect(calls).toBe(1);
    const dead=setup(flaky(99,async()=>reply("never")),{retries:2});
    await expect(dead.read("sources/c.png",20,new AbortController().signal)).rejects.toMatchObject({code:"ARTIFACT.UNAVAILABLE"});
  },20000);
});
