import { mkdtemp, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FixedLanePool, type FixedLane, type LanePoolState, type LaneProbe, type LanePoolStore } from "./lane-pool.js";
import { FileLanePoolStore } from "./lane-store.js";

const lanes: FixedLane[] = ["texas", "washington", "redmond", "virginia"].map((laneId, i) => ({
  laneId, resourceId: `mini/listener-${i}`, expectedIp: `8.8.8.${i + 1}`,
  route: { routeId: laneId, version: "pool/1", egressId: `${laneId}/1`, mode: "static-proxy", managed: true },
}));
class Memory implements LanePoolStore {
  state?: LanePoolState;
  busy = false;
  async transaction<T>(initial: LanePoolState, change: (state: LanePoolState) => Promise<T>) {
    if (this.busy) throw Error("NETWORK.LANE_BUSY"); this.busy = true;
    try { const next = structuredClone(this.state ?? initial); const r = await change(next); this.state = next; return r; }
    finally { this.busy = false; }
  }
}
const good: LaneProbe = { verify: async lane => ({ topologyValid: true, observedIp: lane.expectedIp }) };
const signal = () => new AbortController().signal;
it("round-robins four fixed lanes and returns to first without mutating any route", async () => {
  const p = new FixedLanePool(lanes, new Memory(), good), order: string[] = [];
  for (let i = 0; i < 8; i++) { const g = await p.acquire(`s-${i}`, signal()); order.push(g.laneId); await p.closeBrowser(g); }
  expect(order).toEqual([...lanes, ...lanes].map(l => l.laneId));
});
it("allows four concurrent owners, refuses fifth, never reclaims by elapsed time", async () => {
  let now = 100; const p = new FixedLanePool(lanes, new Memory(), good, { now: () => now });
  const grants = []; for (let i = 0; i < 4; i++) grants.push(await p.acquire(`s-${i}`, signal()));
  now += 864000000;
  await expect(p.acquire("fifth", signal())).rejects.toThrow("NETWORK.LANE_UNAVAILABLE");
  expect(new Set(grants.map(g => g.laneId)).size).toBe(4);
});
it("keeps the same lease on lost-response recovery, rejects reusing a closed owner", async () => {
  const store = new Memory(), p = new FixedLanePool(lanes, store, good);
  const a = await p.acquire("same", signal());
  const restarted = new FixedLanePool(lanes, store, good);
  expect(await restarted.acquire("same", signal())).toEqual(a);
  await restarted.closeBrowser(a);
  await expect(p.acquire("same", signal())).rejects.toThrow("NETWORK.LANE_OWNER_CLOSED");
});
it("retains a lane until browser AND every planned source file are closed", async () => {
  const p = new FixedLanePool([lanes[0]], new Memory(), good), g = await p.acquire("s", signal());
  await p.retainFiles(g, ["a", "b", "a"]); await p.closeFile(g, "a"); await p.closeBrowser(g);
  await p.assertHeld(g, "b");
  await expect(p.assertHeld(g)).rejects.toThrow("LEASE_INVALID");
  await expect(p.retainFiles(g, ["c"])).rejects.toThrow("OWNER_CLOSED");
  await expect(p.acquire("next", signal())).rejects.toThrow("UNAVAILABLE");
  await p.closeFile(g, "b"); await p.closeFile(g, "b");
  const next = await p.acquire("next", signal()); expect(next.token).not.toBe(g.token);
  await p.closeBrowser(g); // old idempotent completion cannot release the NEW lease
  await expect(p.acquire("third", signal())).rejects.toThrow("UNAVAILABLE");
});
it("skips failed/mismatched routes and rechecks only after cooldown", async () => {
  let now = 1, broken = true; const calls: string[] = [];
  const probe: LaneProbe = { verify: async l => { calls.push(l.laneId); return { topologyValid: !broken || l.laneId !== "texas", observedIp: l.expectedIp }; } };
  const p = new FixedLanePool(lanes, new Memory(), probe, { now: () => now, cooldownMs: 100 });
  const g = await p.acquire("a", signal()); expect(g.laneId).toBe("washington"); await p.closeBrowser(g);
  for (const owner of ["b", "c", "d"]) await p.closeBrowser(await p.acquire(owner, signal()));
  expect(calls.filter(x => x === "texas")).toHaveLength(1);
  now = 200; broken = false;
  for (const owner of ["e", "f", "g"]) await p.closeBrowser(await p.acquire(owner, signal()));
  expect(calls.filter(x => x === "texas")).toHaveLength(2);
});
it("rejects wrong public exit even if proxy name and HTTP health appear healthy", async () => {
  const store = new Memory(), p = new FixedLanePool(lanes, store, { verify: async () => ({ topologyValid: true, observedIp: "1.1.1.1" }) });
  await expect(p.acquire("x", signal())).rejects.toThrow("UNAVAILABLE");
  expect(store.state!.health.every(x => !x.verified && x.retryAfter > 0)).toBe(true);
  expect(store.state!.leases).toHaveLength(0);
});
it("bounded probe timeout skips a hung health probe without starting a business task", async () => {
  const p = new FixedLanePool([lanes[0]], new Memory(), { verify: () => new Promise(() => {}) }, { probeTimeoutMs: 10 });
  await expect(p.acquire("x", signal())).rejects.toThrow("UNAVAILABLE");
});
it("pre-aborted admission never probes", async () => {
  let calls = 0; const p = new FixedLanePool(lanes, new Memory(), { verify: async l => { calls++; return good.verify(l, signal()); } });
  const c = new AbortController(); c.abort(); await expect(p.acquire("x", c.signal)).rejects.toThrow(); expect(calls).toBe(0);
});
it("rejects duplicate mutable resources/route identities and invalid configuration", () => {
  for (const field of ["laneId", "resourceId"] as const) {
    expect(() => new FixedLanePool([lanes[0], { ...lanes[1], [field]: lanes[0]![field] }], new Memory(), good)).toThrow("CONFIG");
  }
  expect(() => new FixedLanePool([{ ...lanes[0], expectedIp: "198.18.0.1" }], new Memory(), good)).toThrow("CONFIG");
});
it("rejects forged grant, unknown file completion and config changes across restart", async () => {
  const s = new Memory(), p = new FixedLanePool(lanes, s, good), g = await p.acquire("a", signal());
  await expect(p.closeBrowser({ ...g, laneId: "virginia" })).rejects.toThrow("LEASE_INVALID");
  await expect(p.closeFile(g, "unknown")).rejects.toThrow("LEASE_INVALID");
  await expect(new FixedLanePool([...lanes].reverse(), s, good).acquire("b", signal())).rejects.toThrow("STATE");
});
it("filesystem store survives reconstruction, including file holds and cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-test-"));
  const p = new FixedLanePool(lanes, new FileLanePoolStore(root), good), g = await p.acquire("a", signal());
  await p.retainFiles(g, ["image"]); await p.closeBrowser(g);
  const p2 = new FixedLanePool(lanes, new FileLanePoolStore(root), good);
  await p2.assertHeld(g, "image"); expect((await p2.acquire("b", signal())).laneId).toBe("washington");
  await p2.closeFile(g, "image");
  const data = JSON.parse(await readFile(join(root, "state.json"), "utf8")); expect(data.state.leases[0].closed).toBe(true);
});
it("writer contention returns busy, business rejections do not strand writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-test-"));
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(r => ready = r), wait = new Promise<void>(r => release = r);
  const p = new FixedLanePool(lanes, new FileLanePoolStore(root), { verify: async l => { ready(); await wait; return good.verify(l, signal()); } });
  const first = p.acquire("a", signal()); await entered;
  const p2 = new FixedLanePool(lanes, new FileLanePoolStore(root), good);
  await expect(p2.acquire("b", signal())).rejects.toThrow("BUSY"); release(); const g = await first;
  await p2.closeBrowser(g); await expect(p.acquire("a", signal())).rejects.toThrow("OWNER_CLOSED");
  expect((await p2.acquire("b", signal())).laneId).toBe("washington");
});
it("missing state after initialization and orphan writer lock fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-test-"));
  const p = new FixedLanePool(lanes, new FileLanePoolStore(root), good); await p.acquire("a", signal());
  await rename(join(root, "state.json"), join(root, "retained-state.json"));
  await expect(p.acquire("b", signal())).rejects.toThrow("STATE");
  await mkdir(join(root, "writer.lock")); await expect(p.acquire("b", signal())).rejects.toThrow("BUSY");
});
