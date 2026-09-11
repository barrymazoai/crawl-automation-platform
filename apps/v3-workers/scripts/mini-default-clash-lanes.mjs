// Explicitly selected deployment: use the host's running Clash. No new proxy/browser process.
import { readFile, writeFile, copyFile, chmod, mkdtemp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import http from "node:http";
import assert from "node:assert/strict";
const [root] = process.argv.slice(2);
assert.match(root, /^\/Users\/barry\/apps\/crawlv3-default-clash\.[a-zA-Z0-9]+$/);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const {attachDefaultClashLanes,clashConfigHash,FixedLanePool,FileLanePoolStore,FixedClashLaneProbe} = await import(pathToFileURL(`${root}/dist/lane-api.js`));
const yaml = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json")("yaml");
const base = "/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev";
const runtimePath=`${base}/clash-verge.yaml`, mergePath=`${base}/profiles/mDI4NLYORHwo.yaml`, proxiesPath=`${base}/profiles/p3z6lBjZSGxm.yaml`;
const paths=[runtimePath,mergePath,proxiesPath], originals=await Promise.all(paths.map(p=>readFile(p,"utf8")));
const [current,merge,proxyOverrides]=originals.map(t=>yaml.parse(t)||{});
const profile=yaml.parse(await readFile(`${base}/profiles.yaml`,"utf8"));
assert.equal(profile.current,"RxCXE1PR7D7Y");
const options=profile.items.find(p=>p.uid===profile.current).option;
assert.equal(options.merge,"mDI4NLYORHwo");assert.equal(options.proxies,"p3z6lBjZSGxm");
assert.equal(current["external-controller-unix"],"/tmp/verge/verge-mihomo.sock");
assert.equal((current.listeners||[]).length,0);assert.equal((merge.listeners||[]).length,0);
assert.ok(Array.isArray(proxyOverrides.append));assert.ok(Array.isArray(proxyOverrides.prepend));
const control={socketPath:current["external-controller-unix"],secret:current.secret};
function api(path,method="GET",body,signal=AbortSignal.timeout(15000)) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:control.socketPath,path,method,signal,headers:{Authorization:`Bearer ${control.secret}`,"Content-Type":"application/json"}},res=>{
      let data="";res.on("data",c=>{data+=c;if(data.length>4000000)req.destroy(Error("CONTROL_SIZE"));});
      res.on("end",()=>{try{if(res.statusCode<200||res.statusCode>=300)throw Error();resolve(data?JSON.parse(data):null);}catch{reject(Error("CONTROL_FAILED"));}});
    });req.on("error",reject);req.end(body?JSON.stringify(body):undefined);
  });
}
const selectors=p=>Object.fromEntries(Object.entries(p.proxies).filter(([,v])=>v.type==="Selector").map(([k,v])=>[k,v.now]));
const active=await api("/proxies"), beforeSelectors=selectors(active), beforeConfig=await api("/configs");
const exitNames=["美国德州ip","美国华盛顿ip","美国雷德蒙德ip","美国 Virginia ip"],ids=["texas","washington","redmond","virginia"];
const exitNodes=exitNames.map(name=>{const p=current.proxies.find(p=>p.name===name);assert.equal(p?.type,"socks5");return p;});
let frontName=exitNodes[3]["dialer-proxy"];const seen=new Set();
while(active.proxies[frontName]?.now){assert.ok(!seen.has(frontName));seen.add(frontName);frontName=active.proxies[frontName].now;}
const originalFront=current.proxies.find(p=>p.name===frontName);assert.ok(originalFront);assert.ok(!originalFront["dialer-proxy"]);
const front={...originalFront,name:"CRAWLV3-GNC-FRONT"};
const exits=exitNodes.map((p,i)=>({...p,name:`CRAWLV3-GNC-${ids[i].toUpperCase()}`}));
const bindings=ids.map((id,i)=>({port:17891+i,exitName:exits[i].name,lane:{laneId:`gnc-${id}`,resourceId:`mini/default-clash/port-${17891+i}`,
  expectedIp:exits[i].server,route:{routeId:`gnc-${id}`,version:"default-clash/1",egressId:`gnc-${id}/default-clash-1`,mode:"static-proxy",managed:true}}}));
const next=attachDefaultClashLanes(current,{front,exits,bindings});
const additions=next.proxies.slice(current.proxies.length);
assert.equal(additions.length,5);assert.deepEqual(next.proxies.slice(0,current.proxies.length),current.proxies);
const nextMerge={...merge,listeners:next.listeners};
const nextOverrides={...proxyOverrides,append:[...proxyOverrides.append,...additions]};
// Verify the existing subscription script doesn't remove/overwrite these reserved entries on regeneration.
const {runInNewContext}=await import("node:vm");
let generated=structuredClone(next);
for(const file of ["sQydBPVEdtS8.js","Script.js"]){
  const source=await readFile(`${base}/profiles/${file}`,"utf8");
  generated=runInNewContext(`${source}\nmain(input)`,{input:generated,console:{log(){},warn(){},error(){}}},{timeout:1000});
}
assert.deepEqual(JSON.parse(JSON.stringify(generated.listeners)),next.listeners);
for(const p of additions)assert.deepEqual(JSON.parse(JSON.stringify(generated.proxies.find(x=>x.name===p.name))),p);
const reservations=[];
for(const b of bindings){const s=createServer();s.listen(b.port,"127.0.0.1");await once(s,"listening");reservations.push(s);}
await writeFile(`${root}/intent.json`,JSON.stringify({at:new Date().toISOString(),front:frontName,mode:"default-clash"}),{flag:"wx",mode:0o600});
const backup=await mkdtemp(`${base}/gnc-default-lanes-backup-`);await chmod(backup,0o700);
for(let i=0;i<paths.length;i++){await copyFile(paths[i],`${backup}/${i}.yaml`);await chmod(`${backup}/${i}.yaml`,0o600);}
const patchExe="/Users/barry/.codex/tmp/arg0/codex-arg0XJtKmI/apply_patch";
function patch(path,before,after){
  const lines=s=>s.replace(/\n$/,"").split("\n");
  const text=`*** Begin Patch\n*** Update File: ${path}\n@@\n${lines(before).map(l=>"-"+l).join("\n")}\n${lines(after).map(l=>"+"+l).join("\n")}\n*** End Patch\n`;
  execFileSync(patchExe,[],{input:text,stdio:["pipe","pipe","pipe"],timeout:30000,maxBuffer:1024*1024});
}
const replacements=[next,nextMerge,nextOverrides].map(c=>yaml.stringify(c));
const report={at:new Date().toISOString(),front:frontName,backup,mode:"default-clash",newProxyProcesses:0,probes:[],assignments:[]};
let reloaded=false,reloadAttempted=false;
try{
  for(let i=0;i<paths.length;i++){assert.equal(await readFile(paths[i],"utf8"),originals[i]);patch(paths[i],originals[i],replacements[i]);}
  assert.deepEqual(yaml.parse(await readFile(runtimePath,"utf8")),next);
  // Configuration validation exits immediately; it does not start another proxy daemon.
  execFileSync("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",["-t","-d",base,"-f",runtimePath],{stdio:["ignore","pipe","pipe"],timeout:20000});
  for(const s of reservations)await new Promise(r=>s.close(r));
  reloadAttempted=true;await api("/configs?force=true","PUT",{path:runtimePath});reloaded=true;
  const after=await api("/configs"),afterSelectors=selectors(await api("/proxies"));
  assert.deepEqual(afterSelectors,beforeSelectors);
  for(const key of ["mode","mixed-port","port","socks-port","allow-lan","tun"])assert.deepEqual(after[key],beforeConfig[key]);
  report.changedSharedSelectors=[];report.configApplied=true;
  const expected=clashConfigHash({proxies:additions,listeners:next.listeners});
  const topology=async signal=>{
    const cfg=yaml.parse(await readFile(runtimePath,"utf8"));
    const subset={proxies:additions.map(p=>cfg.proxies.find(q=>q.name===p.name)),listeners:cfg.listeners};
    if(clashConfigHash(subset)!==expected)return false;
    const p=await api("/proxies","GET",undefined,signal);
    return exits.every(e=>p.proxies[e.name]?.type==="Socks5"&&!p.proxies[e.name]?.now);
  };
  const probe=new FixedClashLaneProbe(bindings,topology);
  const observed={verify:async(lane,signal)=>{
    try{const result=await probe.verify(lane,signal);const item={laneId:lane.laneId,...result};report.probes.push(item);console.log(JSON.stringify(item));return result;}
    catch{const item={laneId:lane.laneId,error:"NETWORK.PROBE_FAILED"};report.probes.push(item);console.log(JSON.stringify(item));throw Error("NETWORK.PROBE_FAILED");}
  }};
  await mkdir(`${root}/state`,{mode:0o700});
  await writeFile(`${root}/deployment.json`,JSON.stringify({schemaVersion:1,mode:"default-clash",runtimePath,bindings,expectedTopologyHash:expected,stateRoot:`${root}/state`},null,2),{flag:"wx",mode:0o600});
  const pool=new FixedLanePool(bindings.map(b=>b.lane),new FileLanePoolStore(`${root}/state`),observed);
  const grants=[];
  for(let i=0;i<4;i++){const g=await pool.acquire(`network-check-${i}`,AbortSignal.timeout(45000));grants.push(g);report.assignments.push(g.laneId);}
  assert.deepEqual(report.assignments,ids.map(id=>`gnc-${id}`));
  await assert.rejects(pool.acquire("fifth",AbortSignal.timeout(1000)),/LANE_UNAVAILABLE/);
  const first=grants[0];await pool.retainFiles(first,["synthetic-file-hold"]);await pool.closeBrowser(first);
  await assert.rejects(pool.acquire("fifth",AbortSignal.timeout(1000)),/LANE_UNAVAILABLE/);await pool.closeFile(first,"synthetic-file-hold");
  const restarted=new FixedLanePool(bindings.map(b=>b.lane),new FileLanePoolStore(`${root}/state`),observed);
  const fifth=await restarted.acquire("fifth",AbortSignal.timeout(45000));assert.equal(fifth.laneId,"gnc-texas");report.assignments.push(fifth.laneId);
  for(const g of [...grants.slice(1),fifth])await restarted.closeBrowser(g);
  report.status="network-rotation-verified";
}catch{
  report.status=reloadAttempted?"configured-verification-incomplete":"validation-failed-restored";
  if(!reloadAttempted){for(let i=0;i<paths.length;i++)if(await readFile(paths[i],"utf8")===replacements[i])patch(paths[i],replacements[i],originals[i]);}
  process.exitCode=1;
}finally{
  for(const s of reservations)if(s.listening)await new Promise(r=>s.close(r));
  report.businessCalls=0;report.atEnd=new Date().toISOString();
  await writeFile(`${root}/report.json`,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});console.log(JSON.stringify(report));
}
