import type { HeldPermit, PermitStore, ResourceState, ResourceStore } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { z } from "zod";

const ResourceRow = z.object({
  resourceId: z.string(),
  capacity: z.number(),
  held: z.number(),
  healthy: z.boolean(),
  reason: z.string(),
});

const PermitRow = z.object({
  permitId: z.string(),
  workflowId: z.string(),
  runId: z.string(),
  resources: z.array(z.string()),
  grantedAt: z.date(),
});

const selectHeld = `
  SELECT p.permit_id AS "permitId", p.request->>'workflowId' AS "workflowId",
    p.request->>'runId' AS "runId",
    array_agg(n.resource_id ORDER BY n.resource_id) AS resources, p.granted_at AS "grantedAt"
  FROM resource_permit p JOIN resource_permit_need n USING (permit_id)
  WHERE p.released_at IS NULL`;

function toPermit(raw: unknown): HeldPermit {
  const row = PermitRow.parse(raw);
  return { ...row, grantedAt: row.grantedAt.toISOString() };
}

/** `resource_capacity` and `resource_permit`: capacity, health and who holds what. */
export class PostgresResourceStore implements ResourceStore, PermitStore {
  constructor(private readonly database: Database) {}

  async list(): Promise<ResourceState[]> {
    const rows = await this.database.query(
      `SELECT c.resource_id AS "resourceId", c.capacity,
         coalesce(sum(n.units) FILTER (WHERE p.released_at IS NULL), 0)::int AS held,
         (c.healthy AND c.health_until > now()) AS healthy, c.reason
       FROM resource_capacity c
       LEFT JOIN resource_permit_need n ON n.resource_id = c.resource_id
       LEFT JOIN resource_permit p ON p.permit_id = n.permit_id
       GROUP BY c.resource_id ORDER BY c.resource_id`,
    );
    return rows.map((row) => ResourceRow.parse(row));
  }

  async held(): Promise<HeldPermit[]> {
    const rows = await this.database.query(
      `${selectHeld} GROUP BY p.permit_id ORDER BY p.granted_at`,
    );
    return rows.map(toPermit);
  }

  async heldBy(workflowIds: string[]): Promise<HeldPermit[]> {
    const rows = await this.database.query(
      `${selectHeld} AND p.request->>'workflowId' = ANY($1::text[]) GROUP BY p.permit_id ORDER BY p.granted_at`,
      [workflowIds],
    );
    return rows.map(toPermit);
  }

  async findHeld(permitId: string): Promise<HeldPermit | null> {
    const rows = await this.database.query(
      `${selectHeld} AND p.permit_id = $1 GROUP BY p.permit_id`,
      [permitId],
    );
    return rows[0] ? toPermit(rows[0]) : null;
  }

  async release(permitId: string): Promise<boolean> {
    const rows = await this.database.query(
      "UPDATE resource_permit SET released_at = now() WHERE permit_id = $1 AND released_at IS NULL RETURNING permit_id",
      [permitId],
    );
    return rows.length === 1;
  }
}
