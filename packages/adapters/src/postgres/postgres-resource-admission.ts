import { isDeepStrictEqual } from "node:util";
import type { Database, Queryable } from "@crawl-automation/platform";
import { ResourceRequestSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { storeErrors } from "../errors.js";
import { recordPermitRequest } from "./permit-events.js";
import { assertPermitStopped } from "./permit-stop-proof.js";

type Decision = { permitId: string; status: "granted" | "waiting" | "released"; reason: string };

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
  };
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
