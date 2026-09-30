import type { ResourceHealthRepository, ResourceHealthWrite } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/**
 * Health leases. A configured resource with no controller yet (e.g. a row a migration just added) is claimed by the
 * first monitor that owns it in config; a row another controller owns is never taken over, and capacity never changes.
 */
export class PostgresResourceHealth implements ResourceHealthRepository {
  constructor(private readonly database: Queryable) {}

  async write(state: ResourceHealthWrite): Promise<number> {
    const rows = await this.database.query(
      `UPDATE resource_capacity
       SET healthy = $2, health_until = now() + $5 * interval '1 millisecond', reason = $3,
           controller = $4
       WHERE resource_id = $1 AND (controller = $4 OR controller IS NULL) RETURNING resource_id`,
      [state.resourceId, state.healthy, state.reason, state.controller, state.ttlMs],
    );
    return rows.length;
  }
}
