import { isDeepStrictEqual } from "node:util";
import type { Database, Queryable } from "@crawl-automation/platform";
import { ResourceRequestSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { storeErrors } from "../errors.js";
import { recordPermitRequest } from "./permit-events.js";
import { assertPermitStopped } from "./permit-stop-proof.js";

type Decision = {
  permitId: string;
  status: "granted" | "waiting" | "released";
  reason: string;
  host?: string;
};

interface CapacityRow {
  capacity: number;
  ready: boolean;
  reason?: string;
}

const conflict = () => storeErrors.create("RESOURCE.IDENTITY_CONFLICT");

/**
 * Resource permits (`resource_permit`): short transactions only; the waiting happens in Temporal, never while an
 * OCR, browser or model slot is held. All of a request's resources are taken together or not at all.
 */
export class PostgresResourceAdmission {
  constructor(private readonly database: Database) {}

  async reserve(raw: unknown): Promise<Decision> {
    const request = ResourceRequestSchema.parse(raw);
    return this.database.transaction(async (tx) => {
      await recordPermitRequest(tx, request);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `permit:${request.permitId}`,
      ]);
      const prior = await priorDecision(tx, request);
      if (prior) {
        return prior;
      }
      if (request.pool) {
        return reservePooled(tx, { ...request, pool: request.pool });
      }
      // Resources lock in one canonical order, so two requests can never hold parts of each other's capacity.
      const needs = [...request.needs].sort((left, right) =>
        left.resourceId.localeCompare(right.resourceId),
      );
      for (const need of needs) {
        const waiting = await capacityFor(tx, need);
        if (waiting) {
          return { permitId: request.permitId, status: "waiting", reason: waiting };
        }
      }
      await insertPermit(tx, request, needs);
      return { permitId: request.permitId, status: "granted", reason: "available" };
    });
  }

  async release(raw: unknown): Promise<Decision> {
    const request = ResourceRequestSchema.parse(raw);
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<{ request: unknown }>(
        "SELECT request FROM resource_permit WHERE permit_id = $1 FOR UPDATE",
        [request.permitId],
      );
      const prior = rows[0];
      if (!prior || !isDeepStrictEqual(ResourceRequestSchema.parse(prior.request), request)) {
        throw conflict();
      }
      await assertPermitStopped(tx, request.permitId);
      await tx.query(
        "UPDATE resource_permit SET released_at = coalesce(released_at, now()) WHERE permit_id = $1",
        [request.permitId],
      );
      return { permitId: request.permitId, status: "released", reason: "released" };
    });
  }
}

/**
 * A pooled request takes its fixed needs plus the least-used free pool member (owner 2026-10-06: three Ego spaces for
 * DTC products). Every involved row is locked once in canonical order before anything is decided.
 */
async function reservePooled(
  tx: Queryable,
  request: ResourceRequest & { pool: string[] },
): Promise<Decision> {
  const all = [...request.needs.map((need) => need.resourceId), ...request.pool].sort();
  await tx.query(
    "SELECT resource_id FROM resource_capacity WHERE resource_id = ANY($1) ORDER BY resource_id FOR UPDATE",
    [all],
  );
  for (const need of request.needs) {
    const waiting = await capacityFor(tx, need);
    if (waiting) {
      return { permitId: request.permitId, status: "waiting", reason: waiting };
    }
  }
  const members = await poolUse(tx, request.pool);
  let waiting: string | null = null;
  for (const host of members) {
    const reason = await capacityFor(tx, { resourceId: host, units: 1 });
    if (!reason) {
      await insertPermit(tx, request, [...request.needs, { resourceId: host, units: 1 }]);
      return { permitId: request.permitId, status: "granted", reason: "available", host };
    }
    // A full healthy member means the pool is only busy, which never consumes the wait deadline.
    waiting = waiting === "capacity" ? waiting : reason;
  }
  return { permitId: request.permitId, status: "waiting", reason: waiting ?? "capacity" };
}

/** Pool members, least held first; ties keep the configured order. */
async function poolUse(tx: Queryable, pool: string[]): Promise<string[]> {
  const rows = await tx.query<{ resource_id: string; used: number }>(
    `SELECT n.resource_id, coalesce(sum(n.units), 0)::int AS used
       FROM resource_permit_need n JOIN resource_permit p USING (permit_id)
      WHERE n.resource_id = ANY($1) AND p.released_at IS NULL GROUP BY n.resource_id`,
    [pool],
  );
  const used = new Map(rows.map((row) => [row.resource_id, row.used]));
  return [...pool].sort((left, right) => (used.get(left) ?? 0) - (used.get(right) ?? 0));
}

async function insertPermit(
  tx: Queryable,
  request: ResourceRequest,
  needs: ResourceRequest["needs"],
): Promise<void> {
  await tx.query("INSERT INTO resource_permit (permit_id, request) VALUES ($1, $2)", [
    request.permitId,
    request,
  ]);
  for (const need of needs) {
    await tx.query(
      "INSERT INTO resource_permit_need (permit_id, resource_id, units) VALUES ($1, $2, $3)",
      [request.permitId, need.resourceId, need.units],
    );
  }
}

/** The same request again gets its first answer; a different request under the same permit ID is a conflict. */
async function priorDecision(tx: Queryable, request: ResourceRequest): Promise<Decision | null> {
  const rows = await tx.query<{ request: unknown; released_at: Date | null }>(
    "SELECT request, released_at FROM resource_permit WHERE permit_id = $1",
    [request.permitId],
  );
  const prior = rows[0];
  if (!prior) {
    return null;
  }
  if (!isDeepStrictEqual(ResourceRequestSchema.parse(prior.request), request)) {
    throw conflict();
  }
  const released = prior.released_at !== null;
  return {
    permitId: request.permitId,
    status: released ? "released" : "granted",
    reason: released ? "released" : "available",
    ...(request.pool ? { host: await heldMember(tx, request.permitId, request.pool) } : {}),
  };
}

async function heldMember(tx: Queryable, permitId: string, pool: string[]): Promise<string> {
  const rows = await tx.query<{ resource_id: string }>(
    "SELECT resource_id FROM resource_permit_need WHERE permit_id = $1 AND resource_id = ANY($2)",
    [permitId, pool],
  );
  if (rows.length !== 1 || !rows[0]) {
    throw conflict();
  }
  return rows[0].resource_id;
}

/** Why this need must wait ("unhealthy" or "capacity"), or null when it fits now. */
async function capacityFor(
  tx: Queryable,
  need: ResourceRequest["needs"][number],
): Promise<string | null> {
  const rows = await tx.query<CapacityRow>(
    `SELECT capacity, healthy AND health_until > now() AS ready, reason
       FROM resource_capacity WHERE resource_id = $1 FOR UPDATE`,
    [need.resourceId],
  );
  const resource = rows[0];
  if (!resource || need.units > resource.capacity) {
    throw storeErrors.create("RESOURCE.NOT_CONFIGURED", {
      details: { resourceId: need.resourceId },
    });
  }
  if (!resource.ready) {
    return resource.reason?.startsWith("browser:") ? resource.reason : "unhealthy";
  }
  const used = await tx.query<{ used: number }>(
    `SELECT coalesce(sum(n.units), 0)::int AS used
       FROM resource_permit_need n JOIN resource_permit p USING (permit_id)
      WHERE n.resource_id = $1 AND p.released_at IS NULL`,
    [need.resourceId],
  );
  return (used[0]?.used ?? 0) + need.units > resource.capacity ? "capacity" : null;
}
