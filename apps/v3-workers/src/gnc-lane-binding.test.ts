import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FixedLanePool, FileLanePoolStore } from "@crawl-automation/v3-acquisition";
import { bindNewGncLaneTask } from "./gnc-lane-binding.js";
async function fixture() {
  const lane = {laneId:"texas",resourceId:"mini/port-24000",expectedIp:"8.8.8.1",
    route:{routeId:"gnc-texas",version:"pool/1",egressId:"texas/1",mode:"static-proxy",managed:true}};
  const pool = new FixedLanePool([lane],new FileLanePoolStore(await mkdtemp(join(tmpdir(),"gnc-binding-"))),
    {verify:async l=>({topologyValid:true,observedIp:l.expectedIp})});
  const grant = await pool.acquire("new-session",new AbortController().signal);
  const task = {schemaVersion:1,implementationVersion:"gnc-acquire/1",
    owner:{schemaVersion:1,requestId:"new-request",observationId:"new-observation",brandId:"brand",sourceId:"gnc",listingId:"123456",variantId:null},
    capture:{kind:"product",requestId:"new-request",operationId:"new-capture",brandId:"brand",sourceId:"gnc",url:"https://www.gnc.com/123456.html",sku:"123456",
      binding:{sessionId:grant.sessionId,egressId:grant.route.egressId}},network:grant.route};
  const runtime={laneId:grant.laneId,browser:{endpoint:"http://127.0.0.1:25000",instanceId:"owned-browser",sessionId:grant.sessionId},proxyUrl:"http://127.0.0.1:24000"};
  return {pool,grant,task,runtime};
}
it("assembles capture and independent file workers with the same selected route/session",async()=>{
  const f=await fixture(),r=await bindNewGncLaneTask(f.pool,f.grant,f.task,f.runtime);
  expect(r.capture.network).toEqual(r.files.network);expect(r.capture.browser.sessionId).toBe(r.task.capture.binding.sessionId);
  expect(JSON.stringify(r.task)).not.toContain("127.0.0.1");expect(JSON.stringify(r.task)).not.toContain(f.grant.token);
});
it("refuses old fixed-Virginia tasks rather than silently rewriting their evidence identity",async()=>{
  const f=await fixture();f.task.capture.binding.egressId="mini-virginia-fixed/1";
  await expect(bindNewGncLaneTask(f.pool,f.grant,f.task,f.runtime)).rejects.toThrow("LEASE_INVALID");
});
it("refuses closed leases, foreign runtime lanes and arbitrary external proxy endpoints",async()=>{
  const f=await fixture();
  await expect(bindNewGncLaneTask(f.pool,f.grant,f.task,{...f.runtime,laneId:"other"})).rejects.toThrow("LEASE_INVALID");
  await expect(bindNewGncLaneTask(f.pool,f.grant,f.task,{...f.runtime,proxyUrl:"http://untrusted.example:443"})).rejects.toThrow("CONFIG");
  await f.pool.closeBrowser(f.grant);
  await expect(bindNewGncLaneTask(f.pool,f.grant,f.task,f.runtime)).rejects.toThrow("LEASE_INVALID");
});
