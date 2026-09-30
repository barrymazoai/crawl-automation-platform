// Host-specific composition for the already provisioned Mini; read-only Clash control.
// No selector mutation, configuration reload, alternate proxy daemon or fresh admission store.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";
import { hostname } from "node:os";
import assert from "node:assert/strict";
import { clashConfigHash, FixedClashLaneProbe, FixedLanePool, FileLanePoolStore, type ClashLaneBinding } from "@crawl-automation/v3-acquisition";

export async function miniDefaultClash() {
  assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
  const path = "/Users/barry/apps/crawlv3-default-clash.0A8kyC/deployment.json";
  const deployment = JSON.parse(await readFile(path,"utf8"));
  assert.equal(deployment.mode,"default-clash");
  assert.equal(deployment.stateRoot,"/Users/barry/apps/crawlv3-default-clash.0A8kyC/state");
  assert.equal(deployment.runtimePath,"/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml");
  const bindings: ClashLaneBinding[] = deployment.bindings;
  const yaml = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json")("yaml");
  const topology = async (signal: AbortSignal) => {
    const cfg = yaml.parse(await readFile(deployment.runtimePath,"utf8"));
    const names = ["CRAWLV3-GNC-FRONT",...bindings.map(b=>b.exitName)];
    if(clashConfigHash({proxies:names.map(name=>cfg.proxies.find((p:any)=>p.name===name)),listeners:cfg.listeners})!==deployment.expectedTopologyHash) return false;
    assert.equal(cfg["external-controller-unix"],"/tmp/verge/verge-mihomo.sock");
    const active = await new Promise<any>((resolve,reject)=>{
      const req = http.request({socketPath:cfg["external-controller-unix"],path:"/proxies",method:"GET",signal,
        headers:{Authorization:`Bearer ${cfg.secret}`}},res=>{
        let data="";res.on("data",c=>{data+=c;if(data.length>4000000)req.destroy(Error("CONTROL_SIZE"));});
        res.on("end",()=>{try{if(res.statusCode!==200)throw Error();resolve(JSON.parse(data));}catch{reject(Error("CONTROL_FAILED"));}});
      });req.on("error",()=>reject(Error("CONTROL_FAILED")));req.end();
    });
    return bindings.every(b=>active.proxies[b.exitName]?.type==="Socks5"&&!active.proxies[b.exitName]?.now);
  };
  const probe = new FixedClashLaneProbe(bindings,topology);
  const pool = new FixedLanePool(bindings.map(b=>b.lane),new FileLanePoolStore(deployment.stateRoot),probe);
  const endpoints = Object.fromEntries(bindings.map(b=>[b.lane.laneId,`http://127.0.0.1:${b.port}`]));
  return { pool, endpoints, bindings, stateRoot: deployment.stateRoot as string,
    profilesRoot: "/Users/barry/apps/crawlv3-browser-profiles/gnc" };
}
