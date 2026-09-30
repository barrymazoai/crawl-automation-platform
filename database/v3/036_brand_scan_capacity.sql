-- One Swanson brand listing at a time. Health is supplied by the existing resources worker.
-- Preserve any operator-configured capacity or health when this migration is applied again.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('swanson-brand-scan', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
