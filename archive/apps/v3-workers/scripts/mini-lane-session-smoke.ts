import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { LaneSession, NodeSourceProcesses } from "@crawl-automation/v3-acquisition";
import { miniDefaultClash } from "./mini-default-clash-host.js";

const [root]=process.argv.slice(2);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-lane-session\.[A-Za-z0-9]+$/);
const dist=dirname(fileURLToPath(import.meta.url)), id=randomUUID();
const host=await miniDefaultClash();
await writeFile(join(root!,"smoke-intent.json"),JSON.stringify({id,at:new Date().toISOString()}),{flag:"wx",mode:0o600});
await mkdir(join(root!,"sessions"),{mode:0o700});
const report:Record<string,any>={id,at:new Date().toISOString(),businessWorkflows:0,newProxyProcesses:0,clashMutations:0};
let session:LaneSession|undefined;
try {
  session=await LaneSession.open({ownerId:`process-check-${id}`,sessionsRoot:join(root!,"sessions"),endpoints:host.endpoints},host.pool,
    new NodeSourceProcesses({chromeExecutable:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,startupMs:60000}),AbortSignal.timeout(60000));
  const s=session, expectedIp=host.bindings.find(b=>b.lane.laneId===s.grant.laneId)!.lane.expectedIp;
  report.laneId=s.grant.laneId;report.sessionId=s.grant.sessionId;report.browserPid=s.browser.pid;
  const config=async(mode:"browser"|"file")=>{
    const path=join(root!,`${mode}-config.json`);
    await writeFile(path,JSON.stringify({mode,browser:s.browser.config,proxyUrl:s.proxyUrl,egressId:s.grant.route.egressId,
      expectedIp,sessionId:s.grant.sessionId,output:join(root!,`${mode}-result.json`)}),{flag:"wx",mode:0o600});
    return {entry:join(dist,"lane-health-worker.js"),env:{},args:[path]};
  };
  await s.startWorker("capture","capture",await config("browser"));
  report.browser=JSON.parse(await readFile(join(root!,"browser-result.json"),"utf8"));
  console.log(JSON.stringify({event:"BROWSER_EGRESS_VERIFIED",laneId:s.grant.laneId,ip:expectedIp}));
  await s.planFiles([`file-${id}`]); await s.closeCapture();
  await host.pool.assertHeld(s.grant,`file-${id}`);
  await assert.rejects(fetch(`${s.browser.config.endpoint}/json/version`,{signal:AbortSignal.timeout(2000)}));
  report.browserStoppedBeforeFileWorker=true;
  await s.startWorker("files","files",await config("file"),[`file-${id}`]);
  report.file=JSON.parse(await readFile(join(root!,"file-result.json"),"utf8"));
  assert.equal(report.browser.observedIp,report.file.observedIp);
  await s.closeFileWorker("files");
  const state=JSON.parse(await readFile(join(host.stateRoot,"state.json"),"utf8"));
  assert.equal(state.state.leases.find((l:any)=>l.sessionId===s.grant.sessionId)?.closed,true);
  report.releasedAfterProcessesStopped=true; report.status="verified";
} catch(e:any) {
  report.status="needs-inspection";report.code=/^[A-Z0-9_.]+$/.test(e?.code??"")?e.code:"SESSION_SMOKE_FAILED";
  process.exitCode=1;
} finally {
  try{await session?.closeAll();}catch{report.cleanupRequiresInspection=true;}
  report.finishedAt=new Date().toISOString();
  await writeFile(join(root!,"session-report.json"),JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify(report));
}
