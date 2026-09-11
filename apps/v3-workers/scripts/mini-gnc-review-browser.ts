// Explicit human-inspection session: no CAPTCHA input, Workflow, OCR or model call.
// Keep the owned browser/profile/lane until an explicit release; never timeout-close it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LaneSession, NodeSourceProcesses } from "@crawl-automation/v3-acquisition";
import { miniDefaultClash } from "./mini-default-clash-host.js";

const [root,...extra]=process.argv.slice(2);
assert.equal(extra.length,0);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-gnc-review-browser\.[A-Za-z0-9]+$/);
const id=randomUUID(), url="https://www.gnc.com/energy/613701.html";
const host=await miniDefaultClash();
await writeFile(join(root!,"intent.json"),JSON.stringify({id,url,mode:"human-inspection",automaticInput:false}),{flag:"wx",mode:0o600});
await mkdir(join(root!,"sessions"),{mode:0o700});
let session:LaneSession|undefined, stop=false;
process.once("SIGINT",()=>{stop=true;});process.once("SIGTERM",()=>{stop=true;});
const report:Record<string,any>={id,url,ownerPid:process.pid,status:"preparing",workflows:0,mouseInput:0,automaticClose:false};
const save=()=>writeFile(join(root!,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
await save();
try {
  session=await LaneSession.open({ownerId:`review-browser-${id}`,sessionsRoot:join(root!,"sessions"),endpoints:host.endpoints},host.pool,
    new NodeSourceProcesses({chromeExecutable:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:false,
      profilesRoot:host.profilesRoot,startupMs:120000,stopMs:35000}),AbortSignal.timeout(60000));
  Object.assign(report,{laneId:session.grant.laneId,sessionId:session.grant.sessionId,browserPid:session.browser.pid,
    browser:session.browser.config,profilePath:join(host.profilesRoot,session.grant.laneId,"profile")});
  const endpoint=session.browser.config.endpoint;
  const version=await (await fetch(`${endpoint}/json/version`,{signal:AbortSignal.timeout(5000)})).json() as any;
  assert.equal(version.webSocketDebuggerUrl,endpoint.replace("http:","ws:")+`/devtools/browser/${session.browser.config.instanceId}`);
  // This is Chrome's local control API, not an HTTP fetch of the GNC product.
  const opened=await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`,{method:"PUT",signal:AbortSignal.timeout(15000)});
  assert.ok(opened.ok);const tab=await opened.json() as any;
  assert.match(tab.id,/^[A-Za-z0-9-]{1,100}$/);report.targetId=tab.id;
  const activated=await fetch(`${endpoint}/json/activate/${tab.id}`,{signal:AbortSignal.timeout(5000)});
  assert.ok(activated.ok);
  report.status="waiting-for-user";report.openedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({event:"REVIEW_BROWSER_OPEN",root,...report}));
  while(!stop) {
    try {
      const release=JSON.parse(await readFile(join(root!,"release.json"),"utf8"));
      if(release.sessionId===session.grant.sessionId && release.release===true)stop=true;
    } catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; }
    if(!stop)await delay(1000);
  }
} catch(e) { report.error=(e as Error).name;report.status="failed";process.exitCode=1; }
finally {
  if(session) {
    try { await session.closeAll();report.browserStopped=true;report.laneReleased=true; }
    catch {report.cleanupRequiresInspection=true;}
  }
  if(report.status!=="failed")report.status="closed-by-explicit-release";
  await save();console.log(JSON.stringify({event:"REVIEW_BROWSER_STOPPED",...report}));
}
