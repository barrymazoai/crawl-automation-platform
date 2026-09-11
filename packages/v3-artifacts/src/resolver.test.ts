import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { type ArtifactRef, type Observation } from "@crawl-automation/v3-contracts";
import { ArtifactError, type LocalCopies, type ObjectStore } from "./ports.js";
import { ArtifactResolver } from "./resolver.js";
import { FileCopies } from "./local.js";
import { sha256 } from "./integrity.js";

const signal = () => new AbortController().signal;
const owner: Observation = { schemaVersion: 1, requestId: "req-1", observationId: "obs-1", brandId: "brand-1", sourceId: "source-1", listingId: "listing-1", variantId: null };
const bytes = Buffer.from("retained evidence");
function ref(data = bytes): ArtifactRef {
  return { schemaVersion: 1, artifactId: "artifact-1", observationId: "obs-1", sourceId: "source-1", listingId: "listing-1", variantId: null,
    kind: "text", mediaType: "text/plain", sha256: sha256(data), byteSize: data.length, objectKey: "results/evidence.txt",
    producer: { operationId: "operation-1", module: "text", implementationVersion: "text/1" } };
}
class MemoryObjects implements ObjectStore {
  objects = new Map<string, Uint8Array>(); reads = 0; writes = 0; unknown = false; readFailure = false;
  async read(key: string, max: number) {
    this.reads++;
    if (this.readFailure) throw new ArtifactError("ARTIFACT.UNAVAILABLE");
    const value = this.objects.get(key);
    if (value && value.length > max) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    return value ? Buffer.from(value) : null;
  }
  async create(key: string, data: Uint8Array) {
    this.writes++;
    if (this.objects.has(key)) return "exists" as const;
    this.objects.set(key, Buffer.from(data));
    if (this.unknown) throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    return "created" as const;
  }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "v3-artifact-test-"));
  const local = await FileCopies.open(root), remote = new MemoryObjects();
  return { root, local, remote, resolver: new ArtifactResolver(local, remote) };
}
describe("independent artifact storage and local-first resolver", () => {
  it("A05: verifies local bytes without requesting remote data", async () => {
    const {local,remote,resolver} = await setup(); await local.retain(ref(),bytes,signal());
    expect((await resolver.resolve(ref(),owner,signal())).from).toBe("local"); expect(remote.reads).toBe(0);
  });
  it("A04/A05: another invisible local root reads by key and caches without producer paths", async () => {
    const a=await setup(), b=await setup(); await a.resolver.publish(ref(),owner,bytes,signal());
    const resolver=new ArtifactResolver(b.local,a.remote);
    expect((await resolver.resolve(ref(),owner,signal())).from).toBe("remote");
    expect((await resolver.resolve(ref(),owner,signal())).from).toBe("local");
    expect(a.remote.writes).toBe(1);
  });
  it("corrupt cache falls back but is preserved rather than overwritten", async () => {
    const {root,remote,resolver}=await setup(); const path=join(root,`${ref().sha256}.blob`);
    await writeFile(path,Buffer.alloc(bytes.length)); remote.objects.set(ref().objectKey,bytes);
    const result=await resolver.resolve(ref(),owner,signal());
    expect(result).toMatchObject({from:"remote",cacheRetained:false}); expect(result.bytes).toEqual(bytes);
    expect(await readFile(path)).toEqual(Buffer.alloc(bytes.length));
  });
  it("inaccessible local copy uses remote and reports unavailable cache", async () => {
    const remote=new MemoryObjects(); remote.objects.set(ref().objectKey,bytes);
    const local:LocalCopies={read:async()=>{throw Error("EACCES");},retain:async()=>{throw Error("EACCES");}};
    expect(await new ArtifactResolver(local,remote).resolve(ref(),owner,signal())).toMatchObject({from:"remote",cacheRetained:false});
  });
  it("rejects symlink cache entries and never follows another worker path", async () => {
    const {root,remote,resolver}=await setup(), elsewhere=await mkdtemp(join(tmpdir(),"v3-artifact-other-"));
    await writeFile(join(elsewhere,"bytes"),bytes); await symlink(join(elsewhere,"bytes"),join(root,`${ref().sha256}.blob`));
    remote.objects.set(ref().objectKey,bytes);
    expect((await resolver.resolve(ref(),owner,signal())).from).toBe("remote"); expect(remote.reads).toBe(1);
  });
  it("validates owner before local or remote I/O", async () => {
    const {remote,resolver}=await setup();
    await expect(resolver.resolve(ref(),{...owner,observationId:"other"},signal())).rejects.toThrow("OWNERSHIP_CONFLICT");
    expect(remote.reads).toBe(0);
  });
  it.each(["hash","size","media"])("remote %s mismatch never enters cache", async mode => {
    const {root,remote,resolver}=await setup(); remote.objects.set(ref().objectKey,bytes);
    const bad=mode==="hash"?{...ref(),sha256:"a".repeat(64)}:mode==="size"?{...ref(),byteSize:bytes.length+1}:{...ref(),kind:"source-image",mediaType:"image/png"};
    await expect(resolver.resolve(bad,owner,signal())).rejects.toThrow(); expect(await readdir(root)).toEqual([]);
  });
  it("missing remote object is classified, not replaced by a provider call", async () => {
    const {remote,resolver}=await setup(); await expect(resolver.resolve(ref(),owner,signal())).rejects.toMatchObject({code:"ARTIFACT.MISSING"});
    expect(remote.writes).toBe(0);
  });
  it("bounds expected bytes before any read and respects cancellation", async () => {
    const {local,remote}=await setup(), resolver=new ArtifactResolver(local,remote,1);
    await expect(resolver.resolve(ref(),owner,signal())).rejects.toMatchObject({code:"ARTIFACT.TOO_LARGE"});
    const aborted=AbortSignal.abort(); await expect(new ArtifactResolver(local,remote).resolve(ref(),owner,aborted)).rejects.toThrow();
    expect(remote.reads).toBe(0);
  });
  it("A18: immutable original, derived JSON and completion bytes remain after reopening", async () => {
    const {root,remote,resolver}=await setup();
    // Synthetic format fixtures, not a PDF/image processing acceptance.
    const samples=[{data:Buffer.from("%PDF-1.7\nfixture"),kind:"source-pdf",mediaType:"application/pdf",key:"sources/original.pdf"},
      {data:Buffer.from('{"text":"sample"}'),kind:"result-json",mediaType:"application/json",key:"results/derived.json"},
      {data:Buffer.from('{"complete":true}'),kind:"result-json",mediaType:"application/json",key:"completions/proof.json"}];
    for(const s of samples) await resolver.publish({...ref(s.data),kind:s.kind,mediaType:s.mediaType,objectKey:s.key},owner,s.data,signal());
    const reopened=new ArtifactResolver(await FileCopies.open(root),remote);
    for(const s of samples) expect((await reopened.resolve({...ref(s.data),kind:s.kind,mediaType:s.mediaType,objectKey:s.key},owner,signal())).bytes).toEqual(s.data);
    expect(remote.objects.size).toBe(3); expect(remote.writes).toBe(3);
  });
  it("duplicate publication never overwrites a remote object", async () => {
    const {remote,resolver}=await setup(); await Promise.all(Array.from({length:5},()=>resolver.publish(ref(),owner,bytes,signal())));
    expect(remote.objects.size).toBe(1); expect(remote.objects.get(ref().objectKey)).toEqual(bytes);
  });
  it("existing wrong remote bytes conflict and preserve both sets of evidence", async () => {
    const {local,remote,resolver}=await setup(); remote.objects.set(ref().objectKey,Buffer.alloc(bytes.length));
    await expect(resolver.publish(ref(),owner,bytes,signal())).rejects.toMatchObject({code:"ARTIFACT.KEY_CONFLICT"});
    expect(await local.read(ref(),signal())).toEqual(bytes); expect(remote.objects.get(ref().objectKey)).toEqual(Buffer.alloc(bytes.length));
  });
  it("lost upload response reconciles by one read, without a second PUT", async () => {
    const {remote,resolver}=await setup(); remote.unknown=true;
    expect(await resolver.publish(ref(),owner,bytes,signal())).toMatchObject({durable:true});
    expect(remote.writes).toBe(1); expect(remote.reads).toBe(1);
  });
  it("unknown upload and unavailable verification preserve local evidence and stop", async () => {
    const {local,remote,resolver}=await setup(); remote.unknown=true; remote.readFailure=true;
    await expect(resolver.publish(ref(),owner,bytes,signal())).rejects.toMatchObject({code:"ARTIFACT.UPLOAD_UNKNOWN"});
    expect(await local.read(ref(),signal())).toEqual(bytes); expect(remote.writes).toBe(1);
  });
  it("cannot begin remote publication without a retained local copy", async () => {
    const remote=new MemoryObjects(), local:LocalCopies={read:async()=>null,retain:async()=>{throw Error("disk full");}};
    await expect(new ArtifactResolver(local,remote).publish(ref(),owner,bytes,signal())).rejects.toMatchObject({code:"ARTIFACT.CACHE_UNAVAILABLE"}); expect(remote.writes).toBe(0);
  });
});
