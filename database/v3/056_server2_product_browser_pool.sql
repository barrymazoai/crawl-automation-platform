-- Server 二's DTC product browser pool (owner 2026-10-06): Ego spaces 14, 15 and 16, one capture each; catalog scans keep
-- space 6. Preserve operator capacity and health when applied again, as in 049.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('server2-ego-space-14', 1), ('server2-ego-space-15', 1), ('server2-ego-space-16', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
