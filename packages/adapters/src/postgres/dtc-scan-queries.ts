/** Released only by the existing stop-proof guard; a settled scan may still need cleanup. */
export const DTC_HELD_SCAN = `SELECT 1 FROM resource_permit permit
  JOIN brand_scan owner ON permit.request->>'workflowId' = 'browser-scan-' || owner.scan_id::text
  WHERE owner.channel = 'dtc' AND permit.released_at IS NULL`;

export const DTC_SCAN_STATUS = `SELECT mode, 1 AS concurrent,
  (SELECT count(*)::int FROM brand_scan WHERE channel='dtc' AND state='queued') AS queued,
  (SELECT count(*)::int FROM brand_scan WHERE channel='dtc' AND state='running') AS running,
  (SELECT count(*)::int FROM resource_permit permit
    JOIN brand_scan owner ON permit.request->>'workflowId' = 'browser-scan-' || owner.scan_id::text
    WHERE owner.channel='dtc' AND owner.finished_at IS NOT NULL AND permit.released_at IS NULL)
    AS "cleanupPending"
  FROM dtc_scan_control WHERE singleton`;
