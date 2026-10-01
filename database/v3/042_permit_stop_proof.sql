BEGIN;

-- Execution lifetime is independent of Temporal activity/workflow completion.
CREATE TABLE resource_permit_stop (
  permit_id text PRIMARY KEY REFERENCES resource_permit,
  state text NOT NULL CHECK (state IN ('armed', 'running', 'stopped', 'CLEANUP_UNVERIFIED')),
  armed_at timestamptz NOT NULL DEFAULT now(),
  activity_ended_at timestamptz,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  failure jsonb,
  checked_at timestamptz
);
CREATE TABLE resource_permit_execution (
  permit_id text NOT NULL REFERENCES resource_permit_stop,
  execution_id text NOT NULL,
  identity jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  proof jsonb,
  PRIMARY KEY (permit_id, execution_id)
);
CREATE TABLE resource_permit_event (
  permit_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('requested', 'granted', 'released')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request jsonb NOT NULL,
  PRIMARY KEY (permit_id, event)
);

CREATE FUNCTION resource_permit_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM resource_permit_stop s WHERE s.permit_id = NEW.permit_id
      AND s.state = 'stopped' AND s.activity_ended_at IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM resource_permit_execution e
        WHERE e.permit_id = s.permit_id AND e.stopped_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'CLEANUP_UNVERIFIED: %', NEW.permit_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_permit_stop_guard BEFORE UPDATE OF released_at ON resource_permit
  FOR EACH ROW EXECUTE FUNCTION resource_permit_stop_guard();

CREATE FUNCTION resource_permit_event_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_permit_event (permit_id, event, occurred_at, request)
    VALUES (NEW.permit_id, 'granted', NEW.granted_at, NEW.request) ON CONFLICT DO NOTHING;
  IF NEW.released_at IS NOT NULL THEN
    INSERT INTO resource_permit_event (permit_id, event, occurred_at, request)
      VALUES (NEW.permit_id, 'released', NEW.released_at, NEW.request) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_permit_event_log AFTER INSERT OR UPDATE OF released_at ON resource_permit
  FOR EACH ROW EXECUTE FUNCTION resource_permit_event_log();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON resource_permit_stop, resource_permit_execution TO v3_runtime;
    GRANT SELECT, INSERT ON resource_permit_event TO v3_runtime;
  END IF;
END $$;
COMMIT;
