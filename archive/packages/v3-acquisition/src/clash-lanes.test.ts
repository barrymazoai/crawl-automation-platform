import { expect, it } from "vitest";
import { fixedClashConfig, attachDefaultClashLanes } from "./clash-lanes.js";
const front = { name: "front", type: "vless", server: "front.example", port: 443, uuid: "synthetic" };
const exits = [1, 2, 3, 4].map(n => ({ name: `exit-${n}`, type: "socks5", server: `8.8.8.${n}`, port: 443, password: "synthetic", "dialer-proxy": "OLD-SHARED-GROUP" }));
const bindings = exits.map((e, i) => ({ port: 21000 + i, exitName: e.name, lane: { laneId: `lane-${i}`, resourceId: `listener-${i}`, expectedIp: e.server,
  route: { routeId: `r-${i}`, version: "1", egressId: `e-${i}/1`, mode: "static-proxy", managed: true } } }));
const raw = { front, exits, bindings, controllerPort: 22000, secret: "synthetic-control-secret-32-characters" };
it("builds four fixed listener-to-exit bindings and one immutable shared front, with no selector", () => {
  const result = fixedClashConfig(raw);
  expect(result.listeners.map(l => l.proxy)).toEqual(exits.map(e => e.name));
  expect(result["proxy-groups"]).toEqual([]); expect(result.rules).toEqual(["MATCH,REJECT"]);
  expect(result.proxies.slice(1).every(e => e["dialer-proxy"] === "front")).toBe(true);
  expect(exits[0]!["dialer-proxy"]).toBe("OLD-SHARED-GROUP"); // input untouched
  expect(result.tun.enable).toBe(false); expect(result.listeners.every(l => l.listen === "127.0.0.1")).toBe(true);
});
it("rejects mutable/nested front dependencies without leaking credentials", () => {
  expect(() => fixedClashConfig({ ...raw, front: { ...front, "dialer-proxy": "SHARED" } })).toThrow("NETWORK.LANE_CONFIG");
  expect(() => fixedClashConfig({ ...raw, front: { password: "SECRET" } })).toThrow(/^NETWORK.LANE_CONFIG$/);
});
it("rejects duplicate ports, missing exits and wrong configured IP identities", () => {
  expect(() => fixedClashConfig({ ...raw, controllerPort: bindings[0]!.port })).toThrow("CONFIG");
  expect(() => fixedClashConfig({ ...raw, exits: exits.slice(1) })).toThrow("CONFIG");
  expect(() => fixedClashConfig({ ...raw, bindings: bindings.map(b => ({ ...b, exitName: "exit-1" })) })).toThrow("CONFIG");
});
it("adds four lanes to default Clash while preserving existing TUN/DNS/selectors/rules exactly", () => {
  const host = {proxies:[{...front,name:"user-front"}],"proxy-groups":[{name:"AI/X",type:"select",proxies:["user-front"]}],
    "mixed-port":7897,"external-controller":"127.0.0.1:9097",tun:{enable:true},dns:{enable:true,"enhanced-mode":"fake-ip"},
    secret:"user-secret",rules:["MATCH,AI/X"],listeners:[{name:"user-listener",type:"mixed",port:23000,proxy:"user-front"}]};
  const before = structuredClone(host), next = attachDefaultClashLanes(host,{front,exits,bindings});
  expect(host).toEqual(before);expect(next.proxies).toHaveLength(6);expect(next.listeners).toHaveLength(5);
  expect({...next,proxies:host.proxies,listeners:host.listeners}).toEqual(host);
  expect(next.listeners.slice(1).map(l=>l.proxy)).toEqual(exits.map(e=>e.name));
});
it("refuses collisions with host ports/names and cannot reapply by overwriting user nodes", () => {
  const host = {proxies:[{...front,name:"user"}],"mixed-port":bindings[0]!.port};
  expect(()=>attachDefaultClashLanes(host,{front,exits,bindings})).toThrow("CONFIG");
  expect(()=>attachDefaultClashLanes({proxies:[front]},{front,exits,bindings})).toThrow("CONFIG");
  const next = attachDefaultClashLanes({proxies:[{...front,name:"user"}]},{front,exits,bindings});
  expect(()=>attachDefaultClashLanes(next,{front,exits,bindings})).toThrow("CONFIG");
});
