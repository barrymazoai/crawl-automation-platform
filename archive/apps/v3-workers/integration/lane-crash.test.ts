// Built acceptance test, executed on the Mini with its sibling fixture bundle.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { FileLanePoolStore, FixedLanePool, type FixedLane } from "@crawl-automation/v3-acquisition";
const lanes:FixedLane[]=[{laneId:"test",resourceId:"mini/test",expectedIp:"8.8.8.8",route:{routeId:"test",version:"test/1",egressId:"test/1",mode:"static-proxy",managed:true}}];
const child=join(dirname(fileURLToPath(import.meta.url)),"lane-crash-fixture.js");
for(const mode of ["owner","writer"] as const) it(`retains admission after a separate ${mode} process exits without cleanup`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"lane-process-crash-"));
  await expect(promisify(execFile)(process.execPath,[child,root,mode,JSON.stringify(lanes)],{timeout:10000})).rejects.toMatchObject({code:17});
  const p=new FixedLanePool(lanes,new FileLanePoolStore(root),{verify:async lane=>({topologyValid:true,observedIp:lane.expectedIp})});
  await expect(p.acquire("new-owner",AbortSignal.timeout(3000))).rejects.toThrow(mode==="writer"?"LANE_BUSY":"LANE_UNAVAILABLE");
  if(mode==="owner") {
    const state=JSON.parse(await readFile(join(root,"state.json"),"utf8"));
    expect(state.state.leases[0].closed).toBe(false);expect(state.state.leases[0].files[0].closed).toBe(false);
  }
});
