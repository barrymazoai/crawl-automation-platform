import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FixedLanePool, type FixedLane } from "./lane-pool.js";
import { FileLanePoolStore } from "./lane-store.js";
import { LaneSession, type SourceProcessDriver } from "./lane-session.js";

const lane: FixedLane = { laneId: "texas", resourceId: "mini/port-17891", expectedIp: "8.8.8.8",
  route: { routeId: "texas", version: "pool/1", egressId: "texas/1", mode: "static-proxy", managed: true } };
const signal = () => AbortSignal.timeout(5000);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lane-session-"));
  await mkdir(join(root,"state"), { mode: 0o700 }); await mkdir(join(root,"sessions"), { mode: 0o700 });
  const pool = new FixedLanePool([lane], new FileLanePoolStore(join(root,"state")),
    { verify: async () => ({ topologyValid: true, observedIp: lane.expectedIp }) });
  const events: string[] = [], behavior = { browserStops: true, workerStops: true, workerThrows: false };
  const driver: SourceProcessDriver = {
    browser: async ({grant}) => {
      events.push("browser-start");
      return { pid: 100, config: { endpoint: "http://127.0.0.1:9000", instanceId: "browser", sessionId: grant.sessionId },
        stop: async () => { events.push("browser-stop"); return behavior.browserStops; } };
    },
    worker: async () => {
      events.push("worker-start"); if (behavior.workerThrows) throw Error("UNKNOWN_LAUNCH");
      return { pid: 101, stop: async () => { events.push("worker-stop"); return behavior.workerStops; } };
    },
  };
  const input = { ownerId: "owner", sessionsRoot: join(root,"sessions"), endpoints: { texas: "http://127.0.0.1:17891" } };
  return { root, pool, driver, events, behavior, input, open: () => LaneSession.open(input,pool,driver,signal()) };
}
const spec = { entry: "/private/worker.js", env: {} };
it("stops capture Workers but holds the same browser and lane for human inspection",async()=>{
  const f=await fixture(),s=await f.open();await s.startWorker("capture","capture",spec);
  await s.stopCaptureWorkers();await s.stopCaptureWorkers();
  expect(f.events).toEqual(["browser-start","worker-start","worker-stop"]);
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
  await s.closeAll();expect(f.events.at(-1)).toBe("browser-stop");
  await f.pool.acquire("next",signal());
});
it("does not relaunch an already admitted session or create a second owner", async () => {
  const f = await fixture(), session = await f.open();
  await expect(f.open()).rejects.toThrow("LEASE_INVALID");
  await expect(f.pool.acquire("second",signal())).rejects.toThrow("UNAVAILABLE");
  expect(f.events).toEqual(["browser-start"]);
  await session.closeAll();
  expect((await f.pool.acquire("second",signal())).token).not.toBe(session.grant.token);
});
it("stops capture Worker before Chrome and keeps pending files held across reconstruction", async () => {
  const f = await fixture(), s = await f.open();
  await s.startWorker("capture","capture",spec); await s.planFiles(["image"]);
  await s.closeCapture(); expect(f.events).toEqual(["browser-start","worker-start","worker-stop","browser-stop"]);
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
  await s.startWorker("files","files",spec,["image"]);
  await expect(s.startWorker("capture2","capture",spec)).rejects.toThrow("LEASE_INVALID");
  await s.closeFileWorker("files"); await s.closeFileWorker("files");
  const state = JSON.parse(await readFile(join(f.root,"state/state.json"),"utf8"));
  expect(state.state.leases[0].closed).toBe(true);
  await f.pool.acquire("next",signal());
});
it("keeps lane occupied when worker termination is unconfirmed; a later confirmed stop can close it", async () => {
  const f = await fixture(), s = await f.open(); await s.startWorker("capture","capture",spec);
  f.behavior.workerStops = false;
  await expect(s.closeCapture()).rejects.toThrow("LEASE_INVALID");
  expect(f.events).not.toContain("browser-stop");
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
  f.behavior.workerStops = true; await s.closeAll(); await f.pool.acquire("next",signal());
});
it("unconfirmed browser exit cannot release even when all file Workers have stopped", async () => {
  const f = await fixture(), s = await f.open(); await s.planFiles(["image"]);
  await s.startWorker("files","files",spec,["image"]); f.behavior.browserStops = false;
  await expect(s.closeAll()).rejects.toThrow("LEASE_INVALID");
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
  f.behavior.browserStops = true; await s.closeAll(); await f.pool.acquire("next",signal());
});
it("unknown launch stays occupied and cannot be retried or assigned a duplicate file Worker", async () => {
  const f = await fixture(), s = await f.open(); await s.planFiles(["image"]); f.behavior.workerThrows = true;
  await expect(s.startWorker("files","files",spec,["image"])).rejects.toThrow("UNKNOWN_LAUNCH");
  f.behavior.workerThrows = false;
  await expect(s.startWorker("files","files",spec,["image"])).rejects.toThrow("LEASE_INVALID");
  await expect(s.startWorker("replacement","files",spec,["image"])).rejects.toThrow("LEASE_INVALID");
  await expect(s.closeAll()).rejects.toThrow("LEASE_INVALID");
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
  expect(f.events.filter(e => e === "worker-start")).toHaveLength(1);
});
it("refuses unplanned file operations and does not discard unstarted planned files", async () => {
  const f = await fixture(), s = await f.open();
  await expect(s.startWorker("files","files",spec,["unknown"])).rejects.toThrow("LEASE_INVALID");
  await s.planFiles(["image"]); await s.closeAll();
  await expect(f.pool.acquire("next",signal())).rejects.toThrow("UNAVAILABLE");
});
