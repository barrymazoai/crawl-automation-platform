import type { Queryable } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";

/** Only reserve-failure cleanup can release an exact owner whose execution never began. */
export async function assertPermitStopped(
  tx: Queryable,
  permitId: string,
  reserveFailed = false,
): Promise<void> {
  if (reserveFailed) {
    await recordUnstartedPermit(tx, permitId);
  }
  const rows = await tx.query(
    `SELECT p.permit_id FROM resource_permit p WHERE p.permit_id = $1 AND
      (p.released_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM resource_permit_stop s WHERE s.permit_id = p.permit_id
        AND s.state = 'stopped' AND s.activity_ended_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM resource_permit_execution e
          WHERE e.permit_id = p.permit_id AND e.stopped_at IS NULL
        )
      ))`,
    [permitId],
  );
  if (rows.length !== 1) {
    throw resourceGateErrors.create("RESOURCE.CLEANUP_UNVERIFIED", { details: { permitId } });
  }
}

/** Caller holds the exact permit row lock; never replace an existing execution journal. */
async function recordUnstartedPermit(tx: Queryable, permitId: string): Promise<void> {
  await tx.query(
    `INSERT INTO resource_permit_stop (permit_id, state, activity_ended_at, failure)
     SELECT $1, 'stopped', now(), '{"executionFact":"not_executed","reason":"reserve_failed"}'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM resource_permit_execution WHERE permit_id = $1)
     ON CONFLICT DO NOTHING`,
    [permitId],
  );
}
