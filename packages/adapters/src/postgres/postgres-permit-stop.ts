import { ResourceRequestSchema } from "@crawl-automation/v3-contracts";
import type { Database } from "@crawl-automation/platform";
import { lockPermit } from "./permit-owner.js";
import { z } from "zod";

/** Business activities arm their own journal. Only durable executor receipts can settle a permit. */
export class PostgresPermitStop {
  constructor(private readonly database: Database) {}

  async prepare(raw: unknown): Promise<void> {
    const owner = ResourceRequestSchema.parse(raw);
    await this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      await tx.query(
        `INSERT INTO resource_permit_stop (permit_id, state) VALUES ($1, 'armed')
         ON CONFLICT DO NOTHING`,
        [owner.permitId],
      );
    });
  }

  async verify(raw: unknown) {
    const { cleanupFailure, ...request } = z
      .looseObject({
        cleanupFailure: z.record(z.string(), z.unknown()).nullable(),
      })
      .parse(raw);
    const owner = ResourceRequestSchema.parse(request);
    return this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      const rows = await tx.query<{ state: string; attempts: number }>(
        `UPDATE resource_permit_stop SET checked_at = now(), failure = coalesce(failure, $2),
         cleanup_attempts = cleanup_attempts + 1, state = CASE
         WHEN activity_ended_at IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM resource_permit_execution WHERE permit_id = $1 AND stopped_at IS NULL
         ) THEN 'stopped' ELSE 'CLEANUP_UNVERIFIED' END
         WHERE permit_id = $1 RETURNING state, cleanup_attempts AS attempts`,
        [owner.permitId, cleanupFailure],
      );
      return {
        permitId: owner.permitId,
        state: rows[0]?.state ?? "CLEANUP_UNVERIFIED",
        attempts: rows[0]?.attempts ?? 3,
      };
    });
  }
}
