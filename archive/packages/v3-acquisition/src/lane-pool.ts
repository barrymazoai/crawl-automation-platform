import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { NetworkRouteSchema, type NetworkRoute } from "@crawl-automation/v3-contracts";
import { publicAddress } from "./network.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/);
export const FixedLaneSchema = z.strictObject({
  laneId: id, resourceId: id, route: NetworkRouteSchema,
  expectedIp: z.string().refine(publicAddress),
}).refine(l => l.route.mode === "static-proxy");
export type FixedLane = z.infer<typeof FixedLaneSchema>;
const leaseSchema = z.strictObject({
  token: z.uuid(), ownerId: id, laneId: id, sessionId: id,
  browserClosed: z.boolean(), files: z.array(z.strictObject({ operationId: id, closed: z.boolean() })).max(10000),
  closed: z.boolean(),
});
export const LanePoolStateSchema = z.strictObject({
  version: z.literal(1), configHash: z.string().regex(/^[a-f0-9]{64}$/), cursor: z.number().int().nonnegative(),
  leases: z.array(leaseSchema).max(10000),
  health: z.array(z.strictObject({ laneId: id, retryAfter: z.number().finite().nonnegative(), verified: z.boolean() })).max(32),
});
export type LanePoolState = z.infer<typeof LanePoolStateSchema>;
export interface LanePoolStore {
  /** Atomic across all owners of these host-local resources. Never silently reset missing/corrupt state. */
  transaction<T>(initial: LanePoolState, change: (state: LanePoolState) => Promise<T>): Promise<T>;
}
export interface LaneProbe {
  /** Trusted host adapter: inspect fixed topology and attest actual IP through THIS listener, not its name. */
  verify(lane: FixedLane, signal: AbortSignal): Promise<{ observedIp: string; topologyValid: boolean }>;
}
export class LanePoolError extends Error {
  constructor(readonly code: "NETWORK.LANE_CONFIG" | "NETWORK.LANE_UNAVAILABLE" | "NETWORK.LANE_BUSY" |
    "NETWORK.LANE_LEASE_INVALID" | "NETWORK.LANE_OWNER_CLOSED" | "NETWORK.LANE_STATE" | "NETWORK.LANE_CAPACITY") {
    super(code); this.name = "LanePoolError";
  }
}
export interface LaneGrant {
  token: string; ownerId: string; laneId: string; sessionId: string; route: NetworkRoute;
}
/** Admission control, NOT a task queue. No selector PUT, task retry, auto-expiry or running-session reroute.
 * Browser ownership and ALL planned source files must close before the lane can be reused.
 */
export class FixedLanePool {
  readonly #lanes: FixedLane[];
  readonly #initial: LanePoolState;
  constructor(raw: unknown, private readonly store: LanePoolStore, private readonly probe: LaneProbe,
    private readonly options: { now?: () => number; cooldownMs?: number; probeTimeoutMs?: number } = {}) {
    const parsed = z.array(FixedLaneSchema).min(1).max(32).safeParse(raw);
    if (!parsed.success) throw new LanePoolError("NETWORK.LANE_CONFIG");
    this.#lanes = parsed.data;
    for (const keys of [this.#lanes.map(l => l.laneId), this.#lanes.map(l => l.resourceId),
      this.#lanes.map(l => l.route.egressId), this.#lanes.map(l => l.route.routeId)]) {
      if (new Set(keys).size !== keys.length) throw new LanePoolError("NETWORK.LANE_CONFIG");
    }
    for (const n of [options.cooldownMs ?? 30000, options.probeTimeoutMs ?? 10000]) {
      if (!Number.isInteger(n) || n < 1 || n > 300000) throw new LanePoolError("NETWORK.LANE_CONFIG");
    }
    this.#initial = { version: 1, configHash: createHash("sha256").update(JSON.stringify(this.#lanes)).digest("hex"),
      cursor: 0, leases: [], health: this.#lanes.map(l => ({ laneId: l.laneId, retryAfter: 0, verified: false })) };
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private tx<T>(change: (state: LanePoolState) => Promise<T>) {
    return this.store.transaction(this.#initial, async state => {
      const parsed = LanePoolStateSchema.safeParse(state);
      if (!parsed.success || state.configHash !== this.#initial.configHash || state.cursor >= this.#lanes.length ||
        JSON.stringify(state.health.map(h => h.laneId)) !== JSON.stringify(this.#lanes.map(l => l.laneId)))
        throw new LanePoolError("NETWORK.LANE_STATE");
      return change(state);
    });
  }
  private grant(lease: z.infer<typeof leaseSchema>): LaneGrant {
    const lane = this.#lanes.find(l => l.laneId === lease.laneId);
    if (!lane) throw new LanePoolError("NETWORK.LANE_STATE");
    return { token: lease.token, ownerId: lease.ownerId, laneId: lease.laneId, sessionId: lease.sessionId, route: structuredClone(lane.route) };
  }
  async acquire(ownerId: string, signal: AbortSignal): Promise<LaneGrant> {
    if (!id.safeParse(ownerId).success) throw new LanePoolError("NETWORK.LANE_CONFIG");
    signal.throwIfAborted();
    const result = await this.tx(async state => {
      const prior = state.leases.find(l => l.ownerId === ownerId);
      if (prior) {
        if (prior.closed || prior.browserClosed) throw new LanePoolError("NETWORK.LANE_OWNER_CLOSED");
        return this.grant(prior); // Lost admission response never creates another browser lease.
      }
      if (state.leases.length >= 10000) throw new LanePoolError("NETWORK.LANE_CAPACITY");
      const start = state.cursor;
      for (let offset = 0; offset < this.#lanes.length; offset++) {
        signal.throwIfAborted();
        const index = (start + offset) % this.#lanes.length, lane = this.#lanes[index]!;
        const health = state.health[index]!;
        if (state.leases.some(l => l.laneId === lane.laneId && !l.closed) || health.retryAfter > this.now()) continue;
        let valid = false;
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.probeTimeoutMs ?? 10000)]);
        try {
          const result = await boundedProbe(this.probe, structuredClone(lane), bounded);
          valid = result.topologyValid && result.observedIp === lane.expectedIp;
        } catch { signal.throwIfAborted(); }
        health.verified = valid;
        health.retryAfter = valid ? 0 : this.now() + (this.options.cooldownMs ?? 30000);
        state.cursor = (index + 1) % this.#lanes.length;
        if (!valid) continue;
        signal.throwIfAborted();
        const token = randomUUID(), lease = { token, ownerId, laneId: lane.laneId,
          sessionId: `lane-session-${randomUUID()}`, browserClosed: false, files: [], closed: false };
        state.leases.push(lease);
        return this.grant(lease);
      }
      return null; // Persist health failures before reporting unavailable.
    });
    if (!result) throw new LanePoolError("NETWORK.LANE_UNAVAILABLE");
    return result;
  }
  private async mutate(grant: LaneGrant, change: (lease: z.infer<typeof leaseSchema>) => void) {
    return this.tx(async state => {
      const lease = state.leases.find(l => l.token === grant.token);
      if (!lease || JSON.stringify(this.grant(lease)) !== JSON.stringify(grant)) throw new LanePoolError("NETWORK.LANE_LEASE_INVALID");
      change(lease);
      lease.closed = lease.browserClosed && lease.files.every(f => f.closed);
    });
  }
  /** Register the complete source-file plan BEFORE closing the browser. Idempotent by operation ID. */
  async retainFiles(grant: LaneGrant, operationIds: string[]) {
    if (!z.array(id).max(10000).safeParse(operationIds).success) throw new LanePoolError("NETWORK.LANE_CONFIG");
    return this.mutate(grant, lease => {
      const fresh = [...new Set(operationIds)].filter(x => !lease.files.some(f => f.operationId === x));
      if (fresh.length && (lease.closed || lease.browserClosed)) throw new LanePoolError("NETWORK.LANE_OWNER_CLOSED");
      if (fresh.length + lease.files.length > 10000) throw new LanePoolError("NETWORK.LANE_CAPACITY");
      lease.files.push(...fresh.map(operationId => ({ operationId, closed: false })));
    });
  }
  /** Call only after owned browser work has stopped; this seals the file plan. Unknown cleanup stays held. */
  async closeBrowser(grant: LaneGrant) { return this.mutate(grant, lease => { lease.browserClosed = true; }); }
  /** Call after file stream/socket termination, not merely after scheduling/timeout notification. */
  async closeFile(grant: LaneGrant, operationId: string) {
    return this.mutate(grant, lease => {
      const file = lease.files.find(f => f.operationId === operationId);
      if (!file) throw new LanePoolError("NETWORK.LANE_LEASE_INVALID");
      file.closed = true;
    });
  }
  async assertHeld(grant: LaneGrant, operationId?: string) {
    return this.mutate(grant, lease => {
      if (lease.closed || (operationId === undefined ? lease.browserClosed : !lease.files.some(f => f.operationId === operationId && !f.closed)))
        throw new LanePoolError("NETWORK.LANE_LEASE_INVALID");
    });
  }
}
async function boundedProbe(probe: LaneProbe, lane: FixedLane, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([probe.verify(lane, signal), new Promise<never>((_, reject) => {
      onAbort = () => reject(new LanePoolError("NETWORK.LANE_UNAVAILABLE"));
      signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
