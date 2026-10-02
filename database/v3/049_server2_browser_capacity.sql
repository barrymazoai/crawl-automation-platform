-- Server 二's Ego space 6 browser (R72 per-host routing) and one DTC brand scan at a time across machines.
-- Preserve operator capacity and health when applied again, as in 036-038.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('server2-ego-space-6', 1), ('dtc-brand-scan', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
