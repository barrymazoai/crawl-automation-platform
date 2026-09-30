// One explicitly requested native path/hold on the already retained review tab.
// Reuses Adapter target/path code. Never navigates, refreshes, retries or closes the tab.
import {readFile,writeFile,mkdtemp} from "node:fs/promises";
import {join} from "node:path";
import {hostname} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import assert from "node:assert/strict";
import {holdRequest,locateHold,nativeReceiptComplete} from "../src/gnc-mouse-challenge.js";

const [root,...extra]=process.argv.slice(2);assert.equal(extra.length,0);
assert.match(hostname(),/^barrydeMac-mini(?:\.|$)/);
assert.match(root!,/^\/Users\/barry\/apps\/crawlv3-gnc-review-browser\.[A-Za-z0-9]+$/);
const owner=JSON.parse(await readFile(join(root!,"report.json"),"utf8"));
assert.equal(owner.status,"waiting-for-user");
const url="https://www.gnc.com/energy/613701.html",endpoint=owner.browser.endpoint,exec=promisify(execFile);
assert.match(endpoint,/^http:\/\/127\.0\.0\.1:\d+$/);
const ps=(await exec("/bin/ps",["-p",String(owner.browserPid),"-o","command="])).stdout;
assert.ok(ps.startsWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ") && ps.split(/\s+/).includes(`--user-data-dir=${owner.profilePath}`));
const version=await (await fetch(endpoint+"/json/version",{signal:AbortSignal.timeout(5000)})).json() as any;
assert.equal(version.webSocketDebuggerUrl,endpoint.replace("http:","ws:")+"/devtools/browser/"+owner.browser.instanceId);
const tabs=await (await fetch(endpoint+"/json/list",{signal:AbortSignal.timeout(5000)})).json() as any[];
const tab=tabs.find(t=>t.id===owner.targetId);assert.equal(tab?.url,url);
assert.equal(tab.webSocketDebuggerUrl,endpoint.replace("http:","ws:")+"/devtools/page/"+owner.targetId);
// One current-session attempt; repeat invocation refuses, even after uncertain input.
await writeFile(join(root!,"path-attempt-intent.json"),JSON.stringify({at:new Date().toISOString(),targetId:owner.targetId,url}),{flag:"wx",mode:0o600});
const dir=await mkdtemp(join(root!,"path-attempt-"));
const report:Record<string,any>={dir,targetId:owner.targetId,browserPid:owner.browserPid,codexCalls:0,attempts:0,browserRetained:true};
const ws=new WebSocket(tab.webSocketDebuggerUrl);let next=0;
const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:any)=>void,timer:NodeJS.Timeout}>();
ws.addEventListener("message",event=>{const m=JSON.parse(String(event.data));const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error("CDP_ERROR")):p.resolve(m.result);}});
const send=(method:string,params:object={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP_TIMEOUT"));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const save=(name:string,value:any)=>writeFile(join(dir,name),JSON.stringify(value),{flag:"wx",mode:0o600});
async function invoke(name:string,args:string[]) {
  const stdout=join(dir,name+".stdout"),stderr=join(dir,name+".stderr");
  await writeFile(stdout,"",{flag:"wx",mode:0o600});await writeFile(stderr,"",{flag:"wx",mode:0o600});
  await exec("/usr/bin/open",["-n","-g","--stdout",stdout,"--stderr",stderr,"/Applications/Crawler Mouse.app","--args",...args],{timeout:5000});
  for(let n=0;n<100;n++) {
    const raw=await readFile(stdout,"utf8");assert.ok(raw.length<65536);
    let lines:any[]=[];try{lines=raw.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x));}catch{}
    if(nativeReceiptComplete(name,lines))return lines;
    await delay(250);
  }
  throw Error("NATIVE_RECEIPT_UNKNOWN");
}
try {
  await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(Error("CDP_CONNECT")),{once:true});});
  const evaluate=async(expression:string)=>{const r=await send("Runtime.evaluate",{expression,returnByValue:true});assert.ok(!r.exceptionDetails);return r.result.value;};
  const control:any={document:async()=>(await send("DOM.getDocument",{depth:-1,pierce:true})).root,
    box:async(nodeId:number)=>(await send("DOM.getBoxModel",{nodeId})).model,
    hit:async(x:number,y:number)=>send("DOM.getNodeForLocation",{x:Math.round(x),y:Math.round(y)}),evaluate,
    geometry:async()=>{const w=await send("Browser.getWindowForTarget",{targetId:owner.targetId}),l=await send("Page.getLayoutMetrics");return {bounds:w.bounds,layout:l.cssLayoutViewport,visual:l.cssVisualViewport};}};
  const snapshot=async(name:string)=>{
    await save(name+"-dom.json",await control.document());
    const image=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    await writeFile(join(dir,name+".png"),Buffer.from(image.data,"base64"),{flag:"wx",mode:0o600});
  };
  await send("Page.bringToFront");await snapshot("before");
  const [inspection]=await invoke("inspect",["--inspect-gnc"]);
  assert.ok(inspection.accessibility&&inspection.postEventAccess&&inspection.screenRecording);
  const windows=inspection.windows.filter((w:any)=>w.pid===owner.browserPid);assert.equal(windows.length,1);
  const target=await locateHold(control),request=holdRequest(target,windows[0],owner.browserPid);
  assert.equal(request.movePath.length,3);await save("target.json",{request,target});
  report.request=request;report.attempts=1;
  console.log(JSON.stringify({event:"NATIVE_PATH_START",dir,movePath:request.movePath,holdMs:request.holdMs}));
  report.events=await invoke("hold",["--hold",JSON.stringify(request)]);
  console.log(JSON.stringify({event:"NATIVE_PATH_RECEIPT",events:report.events}));
  await delay(10000);await snapshot("after");
  report.page=await evaluate("({url:location.href,title:document.title})");
  const doc=await control.document();const texts:string[]=[];
  const visit=(n:any)=>{if(n.nodeType===3&&n.nodeValue?.trim())texts.push(n.nodeValue.trim());for(const c of [...(n.children??[]),...(n.shadowRoots??[]),...(n.contentDocument?[n.contentDocument]:[])])visit(c);};visit(doc);
  report.visiblePrompts=texts.filter(s=>s.length<300 && /再试|try again|按住|press.*hold|确认.*人类/i.test(s)).slice(0,12);
  report.status=report.events.some((e:any)=>e.event==="UP_POSTED")&&!report.events.some((e:any)=>e.ok===false)?"input-completed":"input-not-completed";
} catch(e) {report.status="failed";report.error=(e as Error).message;process.exitCode=1;}
finally {for(const p of pending.values())clearTimeout(p.timer);ws.close();await save("result.json",report);console.log(JSON.stringify(report));}
