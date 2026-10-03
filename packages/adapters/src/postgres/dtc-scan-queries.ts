/** Analysis and catalog tasks share the DTC browser lane. A terminal owner may still need cleanup. */
export const DTC_HELD_BROWSER_PERMITS = `SELECT permit.permit_id,owner.terminal
  FROM resource_permit permit JOIN (
    SELECT 'browser-scan-' || scan_id::text AS workflow_id,finished_at IS NOT NULL AS terminal
      FROM brand_scan WHERE channel='dtc'
    UNION ALL
    SELECT 'site-analysis-' || id::text AS workflow_id,
      state NOT IN ('queued','running') AS terminal FROM dtc_site_analysis
  ) owner ON permit.request->>'workflowId'=owner.workflow_id WHERE permit.released_at IS NULL`;

export const DTC_SCAN_STATUS = `SELECT mode, 1 AS concurrent,
  (SELECT count(*)::int FROM brand_scan WHERE channel='dtc' AND state='queued') AS queued,
  (SELECT count(*)::int FROM brand_scan WHERE channel='dtc' AND state='running') AS running,
  (SELECT count(*)::int FROM (${DTC_HELD_BROWSER_PERMITS}) pending WHERE terminal)
    AS "cleanupPending"
  FROM dtc_scan_control WHERE singleton`;
