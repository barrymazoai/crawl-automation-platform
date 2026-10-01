import type { Queryable } from "@crawl-automation/platform";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";

/** First request survives capacity waits. Grant/release timestamps are written by ledger triggers. */
export async function recordPermitRequest(tx: Queryable, request: ResourceRequest): Promise<void> {
  await tx.query(
    `INSERT INTO resource_permit_event (permit_id, event, request)
     VALUES ($1, 'requested', $2) ON CONFLICT DO NOTHING`,
    [request.permitId, request],
  );
}
