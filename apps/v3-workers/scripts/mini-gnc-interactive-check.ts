// Bounded browser environment only. All website navigation/clicks are performed by Computer Use.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { LaneSession, NodeSourceProcesses } from "@crawl-automation/v3-acquisition";
import { miniDefaultClash } from "./mini-default-clash-host.js";
const [root]=process.argv.slice(2);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-gnc-interactive\.[A-Za-z0-9]+$/);
const id=randomUUID(), host=await miniDefaultClash();
await writeFile(join(root!,"intent.json"),JSON.stringify({id,at:new Date().toISOString(),mode:"computer-use-check"}),{flag:"wx",mode:0o600});
await mkdir(join(root!,"sessions"),{mode:0o700});
let session:LaneSession|undefined;
const report:Record<string,unknown>={id,businessWorkflows:0,clashMutations:0};
try {
  session=await LaneSession.open({ownerId:`interactive-${id}`,sessionsRoot:join(root!,"sessions"),endpoints:host.endpoints},host.pool,
    new NodeSourceProcesses({chromeExecutable:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:false,profilesRoot:host.profilesRoot}),AbortSignal.timeout(60000));
  Object.assign(report,{laneId:session.grant.laneId,sessionId:session.grant.sessionId,browserPid:session.browser.pid,browser:session.browser.config,
    profilePath:join(host.profilesRoot,session.grant.laneId,"profile"),profilePolicy:"persistent-per-lane"});
  await writeFile(join(root!,"ready.json"),JSON.stringify(report),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({event:"INTERACTIVE_READY",...report}));
  await new Promise<void>(resolve=>{
    const done=()=>{clearTimeout(timer);process.stdin.pause();resolve();};
    const timer=setTimeout(done,10*60*1000);
    process.stdin.once("data",done);process.stdin.resume();
    process.once("SIGINT",done);process.once("SIGTERM",done);
  });
} catch {report.error="INTERACTIVE_SETUP_FAILED";process.exitCode=1;}
finally {
  try{await session?.closeAll();report.processesStopped=true;}catch{report.cleanupRequiresInspection=true;}
  if(session){const state=JSON.parse(await readFile(join(host.stateRoot,"state.json"),"utf8"));report.released=state.state.leases.find((l:any)=>l.sessionId===session!.grant.sessionId)?.closed===true;}
  await writeFile(join(root!,"report.json"),JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({event:"INTERACTIVE_STOPPED",...report}));
}
