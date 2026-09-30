import { z } from "zod";
import { createHash } from "node:crypto";
import { FixedLaneSchema, LanePoolError, type FixedLane, type LaneProbe } from "./lane-pool.js";
import { StaticProxyTransport } from "./proxy.js";
const port = z.number().int().min(1024).max(65535);
const nodeSchema = z.looseObject({ name: z.string().min(1), type: z.string().min(1), server: z.string().min(1), port: z.number().int().min(1).max(65535) });
const bindingSchema = z.strictObject({ lane: FixedLaneSchema, port, exitName: z.string().min(1) });
export type ClashLaneBinding = z.infer<typeof bindingSchema>;
/** Preferred deployment: append dedicated entries to the host's EXISTING Clash, preserving all
 * unrelated rules, selectors, DNS, TUN, ports and credentials. Caller owns backup/validate/reload.
 * Reserved names must be unique; never overwrite a user's existing node or inbound.
 */
export function attachDefaultClashLanes(existing: unknown, raw: { front: unknown; exits: unknown[]; bindings: unknown }) {
  const base = z.looseObject({ proxies: z.array(nodeSchema), listeners: z.array(z.looseObject({ name: z.string(), port: z.union([z.number(), z.string()]) })).optional() }).safeParse(existing);
  if (!base.success) throw new LanePoolError("NETWORK.LANE_CONFIG");
  // Reuse endpoint validation, but DO NOT copy standalone-core settings into the host configuration.
  const candidate = fixedClashConfig({ ...raw, controllerPort: 65535, secret: "validation-only-not-a-control-secret" });
  const proxyNames = new Set(base.data.proxies.map(p => p.name));
  const groupNames = new Set(Array.isArray(base.data["proxy-groups"]) ? base.data["proxy-groups"].map((g: any) => g.name) : []);
  const listeners = base.data.listeners ?? [], listenerNames = new Set(listeners.map(l => l.name));
  const occupied = new Set<number>();
  for (const key of ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"]) {
    const value = base.data[key]; if (typeof value === "number" && value > 0) occupied.add(value);
  }
  const controller = base.data["external-controller"];
  if (typeof controller === "string") { const value = Number(controller.split(":").at(-1)); if (value) occupied.add(value); }
  for (const listener of listeners) {
    // Fail closed on complex ranges rather than accidentally collide with an existing listener.
    if (!/^\d+$/.test(String(listener.port))) throw new LanePoolError("NETWORK.LANE_CONFIG");
    occupied.add(Number(listener.port));
  }
  if (candidate.proxies.some(p => proxyNames.has(p.name) || groupNames.has(p.name)) ||
    candidate.listeners.some(l => listenerNames.has(l.name) || occupied.has(l.port))) throw new LanePoolError("NETWORK.LANE_CONFIG");
  return { ...structuredClone(base.data), proxies: [...structuredClone(base.data.proxies), ...candidate.proxies],
    listeners: [...structuredClone(listeners), ...candidate.listeners] };
}
/** Build a NEW, dedicated core. Never update a shared selector. No proxy-provider or mutable upstream group.
 * Runtime file contains credentials and stays private. Returned public lane metadata does not.
 * Historical test path; host default Clash attachment above is the selected deployment mode.
 */
export function fixedClashConfig(raw: { front: unknown; exits: unknown[]; bindings: unknown; controllerPort: number; secret: string }) {
  const parsed = z.strictObject({ front: nodeSchema, exits: z.array(nodeSchema).min(1).max(32),
    bindings: z.array(bindingSchema).min(1).max(32), controllerPort: port, secret: z.string().min(32) }).safeParse(raw);
  if (!parsed.success) throw new LanePoolError("NETWORK.LANE_CONFIG");
  const { front, exits, bindings, controllerPort, secret } = parsed.data;
  const names = [front.name, ...exits.map(e => e.name)], ports = [controllerPort, ...bindings.map(b => b.port)];
  if (front["dialer-proxy"] || new Set(names).size !== names.length || new Set(ports).size !== ports.length ||
    bindings.length !== exits.length || new Set(bindings.map(b => b.exitName)).size !== bindings.length ||
    new Set(bindings.map(b => b.lane.laneId)).size !== bindings.length ||
    bindings.some(b => !exits.some(e => e.name === b.exitName && e.type === "socks5" && e.server === b.lane.expectedIp)))
    throw new LanePoolError("NETWORK.LANE_CONFIG");
  return {
    "mixed-port": 0, "allow-lan": false, "bind-address": "127.0.0.1", mode: "rule", "log-level": "warning", ipv6: false,
    "external-controller": `127.0.0.1:${controllerPort}`, secret, tun: { enable: false },
    proxies: [front, ...exits.map(e => ({ ...e, "dialer-proxy": front.name }))],
    "proxy-groups": [],
    listeners: bindings.map(b => ({ name: b.lane.laneId, type: "mixed", listen: "127.0.0.1", port: b.port, udp: false, proxy: b.exitName })),
    rules: ["MATCH,REJECT"],
  };
}
export function clashConfigHash(config: unknown) { return createHash("sha256").update(JSON.stringify(config)).digest("hex"); }
/** The topology callback is host-owned and checks the exact immutable config/owned running core.
 * A successful generic 204 is NOT IP attestation; this reads IP through the selected fixed listener.
 */
export class FixedClashLaneProbe implements LaneProbe {
  readonly #bindings: ClashLaneBinding[];
  constructor(raw: unknown, private readonly topology: (signal: AbortSignal) => Promise<boolean>) {
    const parsed = z.array(bindingSchema).min(1).max(32).safeParse(raw);
    if (!parsed.success || new Set(parsed.data.map(b => b.port)).size !== parsed.data.length)
      throw new LanePoolError("NETWORK.LANE_CONFIG");
    this.#bindings = parsed.data;
  }
  async verify(lane: FixedLane, signal: AbortSignal) {
    const b = this.#bindings.find(b => JSON.stringify(b.lane) === JSON.stringify(lane));
    if (!b || !await this.topology(signal)) return { topologyValid: false, observedIp: "" };
    const transport = new StaticProxyTransport(lane.route.egressId, `http://127.0.0.1:${b.port}`);
    const response = await transport.get(new URL("https://api.ipify.org/"), undefined, {}, signal);
    try {
      if (response.status !== 200) throw new LanePoolError("NETWORK.LANE_UNAVAILABLE");
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > 128) throw new LanePoolError("NETWORK.LANE_UNAVAILABLE");
        chunks.push(chunk);
      }
      return { topologyValid: await this.topology(signal), observedIp: Buffer.concat(chunks).toString("utf8").trim() };
    } finally { response.close(); }
  }
}
