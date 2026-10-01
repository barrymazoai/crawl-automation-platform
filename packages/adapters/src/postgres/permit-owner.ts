import type { PermitOwner, Queryable } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";

/** Serialize ownership/proof/release against the same row. Never attach evidence to a reused owner. */
export async function lockPermit(tx: Queryable, owner: PermitOwner): Promise<void> {
  const rows = await tx.query(
    `SELECT permit_id FROM resource_permit WHERE permit_id = $1
       AND request->>'workflowId' = $2 AND request->>'runId' = $3
       AND released_at IS NULL FOR UPDATE`,
    [owner.permitId, owner.workflowId, owner.runId],
  );
  if (rows.length !== 1) {
    throw resourceGateErrors.create("RESOURCE.IDENTITY_CONFLICT", { details: { owner } });
  }
}
