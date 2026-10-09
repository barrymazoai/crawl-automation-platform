-- Server 二's Ego space 17 for brand enrichment only (owner 2026-10-09): the family check and brand research run
-- there, never sharing a space with DTC catalog scans (space 6) or product captures (14–16). Preserve operator
-- capacity and health when applied again, as in 049 and 056.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('server2-ego-space-17', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
