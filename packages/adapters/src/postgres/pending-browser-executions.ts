import type { BrowserRecoveryEntry } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** Only ended activities on this exact host/space and new protocol are eligible for automatic cleanup. */
export async function pendingBrowserExecutions(
  database: Queryable,
  scope: { host: string; taskSpaceId: number },
): Promise<BrowserRecoveryEntry[]> {
  return database.query<BrowserRecoveryEntry>(
    `SELECT jsonb_build_object('permitId', p.permit_id, 'workflowId', p.request->>'workflowId',
      'runId', p.request->>'runId') AS owner,
      (SELECT jsonb_agg(jsonb_build_object('identity', e.identity,
        'stopped', e.stopped_at IS NOT NULL, 'recordedAt', e.recorded_at))
       FROM resource_permit_execution e WHERE e.permit_id = p.permit_id) AS executions
     FROM resource_permit p JOIN resource_permit_stop s USING (permit_id)
     WHERE p.released_at IS NULL AND s.activity_ended_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM resource_permit_execution e WHERE e.permit_id = p.permit_id
       AND e.identity->>'kind' = 'browser-round' AND e.identity->'metadata'->>'host' = $1
       AND e.identity->'metadata'->>'protocol' IN ('ego-single-page/1', 'ego-native-capture/1')
       AND e.identity->>'taskSpaceId' = $2
     ) ORDER BY s.checked_at NULLS FIRST, p.granted_at LIMIT 20`,
    [scope.host, String(scope.taskSpaceId)],
  );
}
