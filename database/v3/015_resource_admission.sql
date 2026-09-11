BEGIN;
CREATE TABLE resource_capacity (
  resource_id text PRIMARY KEY, capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 64),
  healthy boolean NOT NULL DEFAULT false, health_until timestamptz NOT NULL DEFAULT '-infinity',
  reason text NOT NULL DEFAULT 'not_checked', controller text
);
-- Resource control state is separate from immutable business evidence. No timeout auto-reclaims a permit.
CREATE TABLE resource_permit (
  permit_id text PRIMARY KEY, request jsonb NOT NULL, released_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resource_permit_need (
  permit_id text NOT NULL REFERENCES resource_permit, resource_id text NOT NULL REFERENCES resource_capacity,
  units integer NOT NULL CHECK(units BETWEEN 1 AND 64), PRIMARY KEY(permit_id,resource_id)
);
CREATE INDEX resource_need_by_resource ON resource_permit_need(resource_id);
COMMIT;
