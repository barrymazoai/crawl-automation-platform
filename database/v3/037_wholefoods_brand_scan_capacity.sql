-- One Whole Foods browser brand scan across all machines, including gap and cool-down.
-- Preserve operator capacity and health on repeated migration application, as in 036.
BEGIN;
INSERT INTO resource_capacity (resource_id, capacity)
VALUES ('wholefoods-brand-scan', 1)
ON CONFLICT (resource_id) DO NOTHING;
COMMIT;
