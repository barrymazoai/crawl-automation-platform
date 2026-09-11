import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GetBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { ArtifactError, ArtifactResolver, FileCopies, R2ScopeSchema, createR2Objects, sha256 } from "../dist/index.js";
import { loadConfig, retentionCheck } from "./live-config.mjs";
import { createInspectionClient, mayContinueWithoutRetention } from "./live-inspection.mjs";

const exec = promisify(execFile), signal = () => AbortSignal.timeout(30000);
const [mode, configPath, statePath] = process.argv.slice(2);
let report, reportPath;
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2), {mode:0o600});
const counts = store => {
  const stats = {reads:0,writes:0};
  return {stats, store:{
    read: async (...args) => { stats.reads++; return store.read(...args); },
    create: async (...args) => { stats.writes++; return store.create(...args); },
  }};
};
async function child(config) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const scope = R2ScopeSchema.parse({...state.scope, endpoint:config.endpoint, bucket:config.bucket});
  const remote = createR2Objects(scope, config.credentials), tracked = counts(remote.store);
  try {
    const resolver = new ArtifactResolver(await FileCopies.open(state.root), tracked.store);
    const first = await resolver.resolve(state.ref, state.owner, signal());
    const second = await resolver.resolve(state.ref, state.owner, signal());
    assert.equal(sha256(first.bytes), state.ref.sha256);
    assert.equal(sha256(second.bytes), state.ref.sha256);
    process.stdout.write(JSON.stringify({pid:process.pid, first:first.from, second:second.from, ...tracked.stats}));
  } finally { remote.close(); }
}
async function main() {
  if (!["--preflight", "--run", "--objects-only", "--child-read"].includes(mode)) throw Error("USAGE_EXPECTED_PREFLIGHT_OR_RUN_AND_ABSOLUTE_ENV_PATH");
  const config = await loadConfig(configPath);
  if (mode === "--child-read") return child(config);
  const id = randomUUID(), root = await mkdtemp(join(tmpdir(), "v3-artifact-live-"));
  const scope = R2ScopeSchema.parse({endpoint:config.endpoint,bucket:config.bucket,prefix:`crawlv3-acceptance/${id}`});
  reportPath = join(root, "report.json");
  report = {schemaVersion:1, mode, startedAt:new Date().toISOString(), bucket:scope.bucket, prefix:scope.prefix,
    root, status:"running", tests:[], objects:[], syntheticFixtures:true, deletes:0,
    boundaries:["Not a production Worker deployment", "No full PDF/image decoding or OCR", "Same-host independent processes, not Windows/container acceptance", "Retention is checked at test time, not guaranteed against future policy changes"]};
  await save();
  console.log(JSON.stringify({phase:"preflight",bucket:scope.bucket,prefix:scope.prefix,reportPath}));
  const client = createInspectionClient(scope, config.credentials);
  try {
    let rules;
    try { rules = (await client.send(new GetBucketLifecycleConfigurationCommand({Bucket:scope.bucket}), {abortSignal:signal()})).Rules ?? []; }
    catch(error) {
      if (error?.name === "NoSuchLifecycleConfiguration" && error?.$metadata?.httpStatusCode === 404) rules = [];
      else {
        report.retention = {checked:false,safeForAcceptance:false,httpStatus:error?.$metadata?.httpStatusCode ?? null,
          reason:error?.name === "AccessDenied" ? "AccessDenied" : "LIFECYCLE_UNVERIFIED"};
        await save();
        // A separately selected object-only diagnostic is not full retention acceptance.
        // Never continue on auth/network/unknown errors: only a bucket-policy AccessDenied.
        if (!mayContinueWithoutRetention(mode, error))
          throw Error("LIFECYCLE_UNVERIFIED_NO_UPLOAD");
      }
    }
    if (rules !== undefined) {
      report.retention = retentionCheck(rules, scope.prefix);
      await save();
      if (!report.retention.safeForAcceptance) throw Error("LIFECYCLE_MAY_EXPIRE_EVIDENCE_NO_UPLOAD");
    }
  } finally { client.destroy(); }
  if (mode === "--preflight") { report.status="preflight-passed-no-upload"; await save(); return; }

  const remote = createR2Objects(scope, config.credentials), tracked = counts(remote.store);
  try {
    const localRoot = join(root,"producer"), local = await FileCopies.open(localRoot);
    const resolver = new ArtifactResolver(local,tracked.store);
    const owner = {schemaVersion:1,requestId:`req-${id}`,observationId:`obs-${id}`,brandId:"acceptance-brand",sourceId:"acceptance-source",listingId:"acceptance-listing",variantId:null};
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const samples = [
      {key:"sources/original.png",kind:"source-image",mediaType:"image/png",data:png},
      {key:"results/derived.json",kind:"result-json",mediaType:"application/json",data:Buffer.from(JSON.stringify({synthetic:true,sourceSha256:sha256(png),text:"R2 acceptance fixture"}))},
      {key:"completions/proof.json",kind:"result-json",mediaType:"application/json",data:Buffer.from(JSON.stringify({synthetic:true,operationId:`operation-${id}`,sourceSha256:sha256(png)}))},
      {key:"results/lost-response.txt",kind:"text",mediaType:"text/plain",data:Buffer.from(`synthetic lost-response ${id}`)},
    ];
    for (const [i,sample] of samples.entries()) sample.ref = {
      schemaVersion:1,artifactId:`artifact-${id}-${i}`,observationId:owner.observationId,sourceId:owner.sourceId,listingId:owner.listingId,variantId:null,
      kind:sample.kind,mediaType:sample.mediaType,sha256:sha256(sample.data),byteSize:sample.data.length,objectKey:sample.key,
      producer:{operationId:`operation-${id}`,module:"acceptance",implementationVersion:"acceptance/1"},
    };
    const check = async (name, operation) => {
      const started = Date.now(); await operation();
      report.tests.push({name,status:"passed",durationMs:Date.now()-started}); await save();
      console.log(JSON.stringify({test:name,status:"passed"}));
    };
    // Write the planned keys before any PUT so uncertain results remain discoverable.
    report.objects = samples.map(s=>({key:`${scope.prefix}/${s.key}`,sha256:s.ref.sha256,byteSize:s.data.length,ref:s.ref}));
    await save();
    await check("real immutable publication and readback",async()=>{
      for(const sample of samples.slice(0,3)) assert.equal((await resolver.publish(sample.ref,owner,sample.data,signal())).durable,true);
    });
    const first = samples[0];
    await check("duplicate conditional create returns exists",async()=>{
      assert.equal(await tracked.store.create(first.key,first.data,first.mediaType,signal()),"exists");
      assert.equal((await resolver.publish(first.ref,owner,first.data,signal())).durable,true);
    });
    await check("same-key conflict cannot overwrite retained remote bytes",async()=>{
      const data=Buffer.from(first.data); data[data.length-1]^=1;
      const candidate={...first.ref,sha256:sha256(data)};
      await assert.rejects(resolver.publish(candidate,owner,data,signal()),{code:"ARTIFACT.KEY_CONFLICT"});
      assert.equal(sha256(await tracked.store.read(first.key,first.data.length,signal())),first.ref.sha256);
      assert.equal(sha256(await local.read(candidate,signal())),candidate.sha256);
    });
    await check("real PUT then injected lost acknowledgement reconciles once",async()=>{
      const sample=samples[3];let writes=0,reads=0;
      const uncertain={create:async(...args)=>{writes++;await tracked.store.create(...args);throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");},
        read:async(...args)=>{reads++;return tracked.store.read(...args);}};
      assert.equal((await new ArtifactResolver(local,uncertain).publish(sample.ref,owner,sample.data,signal())).durable,true);
      assert.deepEqual({writes,reads},{writes:1,reads:1});
    });
    for (const visible of [true,false]) await check(`separate Node process local visibility ${visible}`,async()=>{
      const stateFile=join(root,`reader-${visible}.json`);
      await writeFile(stateFile,JSON.stringify({scope:{prefix:scope.prefix,timeoutMs:scope.timeoutMs},owner,ref:first.ref,root:visible?localRoot:join(root,"consumer")}),{mode:0o600,flag:"wx"});
      const {stdout}=await exec(process.execPath,[fileURLToPath(import.meta.url),"--child-read",configPath,stateFile],{timeout:60000,maxBuffer:8192});
      const result=JSON.parse(stdout);assert.notEqual(result.pid,process.pid);
      assert.equal(result.first,visible?"local":"remote");assert.equal(result.second,"local");assert.equal(result.reads,visible?0:1);assert.equal(result.writes,0);
      (report.children??=[]).push(result);
    });
    await check("corrupt local evidence is preserved and real R2 used",async()=>{
      const badRoot=await mkdtemp(join(root,"corrupt-")),bad=Buffer.alloc(first.data.length);
      const path=join(badRoot,`${first.ref.sha256}.blob`);await writeFile(path,bad,{mode:0o600,flag:"wx"});
      const result=await new ArtifactResolver(await FileCopies.open(badRoot),tracked.store).resolve(first.ref,owner,signal());
      assert.equal(result.from,"remote");assert.equal(result.cacheRetained,false);assert.equal(sha256(result.bytes),first.ref.sha256);assert.deepEqual(await readFile(path),bad);
    });
    await check("real missing key is classified without a new upload",async()=>{
      const missing={...first.ref,objectKey:"missing/never-created.png"};const before=tracked.stats.writes;
      await assert.rejects(new ArtifactResolver(await FileCopies.open(join(root,"missing")),tracked.store).resolve(missing,owner,signal()),{code:"ARTIFACT.MISSING"});
      assert.equal(tracked.stats.writes,before);
    });
    await check("fresh client reads all original derived and completion bytes after success",async()=>{
      const reopened=createR2Objects(scope,config.credentials);
      try { for(const sample of samples) assert.equal(sha256(await reopened.store.read(sample.key,sample.data.length,signal())),sample.ref.sha256); }
      finally { reopened.close(); }
    });
    report.status=report.retention.checked?"passed":"object-checks-passed-retention-unverified";
    report.finishedAt=new Date().toISOString();report.parentRequests=tracked.stats;
    await save();console.log(JSON.stringify({status:report.status,tests:report.tests.length,objects:report.objects.length,reportPath}));
  } finally { remote.close(); }
}
try { await main(); }
catch(error) {
  // Do not print raw SDK errors, config contents, assertions or child stderr.
  const code=error instanceof ArtifactError?error.code:/^[A-Z][A-Z0-9_]+$/.test(error?.message??"")?error.message:"LIVE_ACCEPTANCE_FAILED";
  const locations=[...(error?.stack??"").matchAll(/live-r2\.mjs:\d+:\d+/g)].map(m=>m[0]);
  if(report) {report.status="failed";report.error=code;report.locations=locations;report.finishedAt=new Date().toISOString();await save();}
  console.error(JSON.stringify({status:"failed",code,locations,reportPath}));process.exitCode=1;
}
