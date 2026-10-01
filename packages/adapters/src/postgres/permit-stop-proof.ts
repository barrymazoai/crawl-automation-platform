import type { Queryable } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";

/** Old histories retain their commands, but absence of executor proof never authorizes release. */
export async function assertPermitStopped(tx: Queryable, permitId: string): Promise<void> {
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
