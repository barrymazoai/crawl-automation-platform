-- One Costco browser brand scan across all machines, including gap and cool-down.
-- Preserve operator capacity and health when applied again, as in 036 and 037.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('costco-brand-scan', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
