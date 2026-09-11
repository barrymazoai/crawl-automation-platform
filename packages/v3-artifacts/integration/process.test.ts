import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArtifactRef, type Observation } from "@crawl-automation/v3-contracts";
import { FileCopies, sha256 } from "../src/index.js";

const run=promisify(execFile), data=Buffer.from("cross-process evidence");
const owner:Observation={schemaVersion:1,requestId:"req-process",observationId:"obs-process",sourceId:"source-process",brandId:"brand-process",listingId:"listing-process",variantId:null};
const ref:ArtifactRef={schemaVersion:1,artifactId:"file-process",observationId:owner.observationId,sourceId:owner.sourceId,listingId:owner.listingId,variantId:null,
  kind:"text",mediaType:"text/plain",sha256:sha256(data),byteSize:data.length,objectKey:"sources/process.txt",
  producer:{operationId:"operation-process",module:"test",implementationVersion:"test/1"}};
const moduleUrl=new URL("../dist/index.js",import.meta.url).href;
const script=`
const { FileCopies, ArtifactResolver, sha256 } = await import(process.argv[1]);
const [root, ref, owner, encoded] = JSON.parse(process.argv[2]);
let reads = 0;
const remote = { read: async () => { reads++; return Buffer.from(encoded, 'base64'); }, create: async () => { throw Error('Unexpected write'); } };
const result = await new ArtifactResolver(await FileCopies.open(root), remote).resolve(ref, owner, new AbortController().signal);
console.log(JSON.stringify({from:result.from,sha256:sha256(result.bytes),reads,pid:process.pid}));
`;
describe("built storage package in separate plain Node processes",()=>{
  it.each([true,false])("visible local root = %s: checks bytes, not hostname",async visible=>{
    const first=await mkdtemp(join(tmpdir(),"v3-artifact-process-a-")),second=await mkdtemp(join(tmpdir(),"v3-artifact-process-b-"));
    await (await FileCopies.open(first)).retain(ref,data,new AbortController().signal);
    const {stdout}=await run(process.execPath,["--input-type=module","-e",script,moduleUrl,JSON.stringify([visible?first:second,ref,owner,data.toString("base64")])],{cwd:second,timeout:10000});
    const result=JSON.parse(stdout);
    expect(result).toMatchObject({from:visible?"local":"remote",sha256:ref.sha256,reads:visible?0:1});expect(result.pid).not.toBe(process.pid);
  });
});
