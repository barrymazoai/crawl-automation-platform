// RETIRED: historical independent-core experiment. User selected the host's default Clash instead.
// Evidence is retained, but this entry point must not launch another proxy daemon.
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

throw new Error("RETIRED_USE_MINI_DEFAULT_CLASH_LANES");
const [root, overrideFront] = process.argv.slice(2);
if (overrideFront) assert.ok(["🇯🇵日本东京06-0.1倍 | 高速专线推荐", "🇺🇸美国洛杉矶08 | 三网推荐"].includes(overrideFront));
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root, /^\/Users\/barry\/apps\/crawlv3-lane-pool\.[a-zA-Z0-9]+$/);
const { FixedLanePool, FileLanePoolStore, FixedClashLaneProbe, fixedClashConfig, clashConfigHash } = await import(pathToFileURL(`${root}/dist/lane-api.js`));
const yaml = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json")("yaml");
const sharedPath = "/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml";
const shared = yaml.parse(await readFile(sharedPath, "utf8"));
await writeFile(`${root}/smoke-intent.json`, JSON.stringify({ at: new Date().toISOString(), host: hostname() }), {flag:"wx",mode:0o600});
function api(path, { socketPath, port, secret }, signal = AbortSignal.timeout(5000)) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...(socketPath ? {socketPath} : {hostname:"127.0.0.1",port}), path,
      headers: { Authorization: `Bearer ${secret}` }, signal }, res => {
      let data = ""; res.on("data", c => { data += c; if (data.length > 2000000) req.destroy(Error("CONTROL_SIZE")); });
      res.on("end", () => { try { if (res.statusCode !== 200) throw Error(); resolve(JSON.parse(data)); } catch { reject(Error("CONTROL_RESPONSE")); } });
    }); req.on("error", reject);
  });
}
const sharedControl = {socketPath:"/tmp/verge/verge-mihomo.sock",secret:shared.secret};
const sharedBefore = await api("/proxies", sharedControl);
const selectors = p => Object.fromEntries(Object.entries(p.proxies).filter(([,p]) => p.type === "Selector").map(([k,p]) => [k,p.now]));
const beforeSelectors = selectors(sharedBefore);
const names = ["美国德州ip", "美国华盛顿ip", "美国雷德蒙德ip", "美国 Virginia ip"];
const ids = ["texas", "washington", "redmond", "virginia"];
const exits = names.map(name => { const e = shared.proxies.find(p => p.name === name); assert.equal(e?.type,"socks5"); return e; });
let frontName = exits[3]["dialer-proxy"];
const visited = new Set();
while (sharedBefore.proxies[frontName]?.now) {
  assert.ok(!visited.has(frontName)); visited.add(frontName); frontName = sharedBefore.proxies[frontName].now;
}
if (overrideFront) frontName = overrideFront;
const front = shared.proxies.find(p => p.name === frontName); assert.ok(front); assert.ok(!front["dialer-proxy"]);
const reservations = [];
async function reservePort() { const server = createServer(); server.listen(0,"127.0.0.1"); await once(server,"listening"); reservations.push(server); return server.address().port; }
const controllerPort = await reservePort(), bindings = [];
for (let i=0;i<exits.length;i++) {
  const port = await reservePort(), laneId = ids[i];
  bindings.push({port, exitName:names[i], lane:{laneId,resourceId:`${hostname()}/listener-${port}`,expectedIp:exits[i].server,
    route:{routeId:`gnc-${laneId}`,version:"fixed-pool/1",egressId:`gnc-${laneId}/fixed-pool-1`,mode:"static-proxy",managed:true}}});
}
const secret = randomUUID(), config = fixedClashConfig({front,exits,bindings,controllerPort,secret});
// Reuse the working core's resolver settings INSIDE this private core; no DNS listener, TUN,
// system DNS change or application-side target DNS. Do not inherit fake-IP answers into a second core.
if (shared.dns?.enable) {
  config.dns = Object.fromEntries(["enable","default-nameserver","proxy-server-nameserver","nameserver","fallback","fallback-filter","use-hosts","use-system-hosts"]
    .filter(k => shared.dns[k] !== undefined).map(k => [k, structuredClone(shared.dns[k])]));
  config.dns.ipv6 = false; config.dns["enhanced-mode"] = "redir-host"; config.dns["respect-rules"] = false;
}
const configPath = `${root}/proxy.yaml`, hash = clashConfigHash(config);
await writeFile(configPath, yaml.stringify(config), {flag:"wx",mode:0o600});
await writeFile(`${root}/bindings.json`, JSON.stringify(bindings,null,2), {flag:"wx",mode:0o600});
await mkdir(`${root}/state`, {mode:0o700});
const report = {at:new Date().toISOString(),front:frontName,bindings:bindings.map(b=>({laneId:b.lane.laneId,expectedIp:b.lane.expectedIp,port:b.port})),probes:[],assignments:[],businessCalls:0};
let child;
try {
  execFileSync("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo", ["-t","-d",root,"-f",configPath], {stdio:["ignore","pipe","pipe"],timeout:15000});
  for (const server of reservations) await new Promise(resolve=>server.close(resolve));
  const log = await open(`${root}/proxy.log`,"ax",0o600);
  child = spawn("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",["-d",root,"-f",configPath],{stdio:["ignore",log.fd,log.fd]});
  await once(child,"spawn"); await log.close(); report.proxyPid=child.pid;
  const control = {port:controllerPort,secret};
  const deadline = Date.now()+10000;
  while (true) { try { await api("/version",control); break; } catch { if (Date.now()>deadline||child.exitCode!==null) throw Error("CORE_START_FAILED"); await new Promise(r=>setTimeout(r,100)); } }
  const topology = async signal => {
    if (child.exitCode!==null || clashConfigHash(yaml.parse(await readFile(configPath,"utf8")))!==hash) return false;
    const active = await api("/configs",control,signal), proxies = await api("/proxies",control,signal);
    return active.mode === "rule" && !active.tun?.enable && exits.every(e => proxies.proxies[e.name]?.type === "Socks5") &&
      names.every(name => !proxies.proxies[name]?.now);
  };
  const probe = new FixedClashLaneProbe(bindings,topology);
  const observed = {verify:async(lane,signal)=>{
    try {const r=await probe.verify(lane,signal); const evidence={laneId:lane.laneId,...r};report.probes.push(evidence);console.log(JSON.stringify(evidence));return r;}
    catch {const evidence={laneId:lane.laneId,error:"NETWORK.PROBE_FAILED"};report.probes.push(evidence);console.log(JSON.stringify(evidence));throw Error("NETWORK.PROBE_FAILED");}
  }};
  const pool = new FixedLanePool(bindings.map(b=>b.lane),new FileLanePoolStore(`${root}/state`),observed,{probeTimeoutMs:10000});
  const grants=[];
  for(let i=0;i<4;i++) { const grant=await pool.acquire(`smoke-${i}`,AbortSignal.timeout(45000)); grants.push(grant);report.assignments.push(grant.laneId); }
  assert.deepEqual(report.assignments,ids);
  await assert.rejects(pool.acquire("fifth",AbortSignal.timeout(1000)),/LANE_UNAVAILABLE/);
  const first=grants[0];await pool.retainFiles(first,["synthetic-file-hold"]);await pool.closeBrowser(first);
  await assert.rejects(pool.acquire("fifth",AbortSignal.timeout(1000)),/LANE_UNAVAILABLE/);
  await pool.closeFile(first,"synthetic-file-hold");
  const restarted=new FixedLanePool(bindings.map(b=>b.lane),new FileLanePoolStore(`${root}/state`),observed);
  const fifth=await restarted.acquire("fifth",AbortSignal.timeout(45000));assert.equal(fifth.laneId,"texas");report.assignments.push(fifth.laneId);
  for(const grant of [...grants.slice(1),fifth]) await restarted.closeBrowser(grant);
  report.status="passed";
} catch(error) { report.status="incomplete";report.error=/^NETWORK\.[A-Z_.]+$/.test(error.message)?error.message:"SMOKE_VERIFICATION_FAILED";process.exitCode=1; }
finally {
  for(const server of reservations) if(server.listening) await new Promise(resolve=>server.close(resolve));
  if(child && child.exitCode===null && child.signalCode===null) {
    const stopped=once(child,"exit");child.kill("SIGTERM");await Promise.race([stopped,new Promise(r=>setTimeout(r,3000))]);
    if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await stopped;}
  }
  report.ownProxyStopped=!child||child.exitCode!==null||child.signalCode!==null;
  const afterSelectors=selectors(await api("/proxies",sharedControl));
  report.changedSharedSelectors=[...new Set([...Object.keys(beforeSelectors),...Object.keys(afterSelectors)])].filter(k=>beforeSelectors[k]!==afterSelectors[k]);
  await writeFile(`${root}/smoke-report.json`,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify(report));
}
