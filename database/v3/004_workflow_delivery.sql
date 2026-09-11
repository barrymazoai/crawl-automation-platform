-- Narrow handoff journal, never an Activity queue or a substitute Workflow engine.
BEGIN;
SET LOCAL search_path = public;
CREATE TABLE workflow_delivery (
  request_id uuid PRIMARY KEY REFERENCES collection_submission(request_id) ON DELETE RESTRICT,
  target jsonb NOT NULL CHECK (jsonb_typeof(target)='object'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  run_id uuid,
  observed_status text CHECK (observed_status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT','CONTINUED_AS_NEW')),
  last_issue text CHECK (last_issue IN ('NOT_FOUND','UNAVAILABLE','IDENTITY_MISMATCH','RUN_CHANGED','CHAIN_CONTINUED','UNCONFIRMED_TERMINAL')),
  terminal_event_id text CHECK (terminal_event_id ~ '^[1-9][0-9]*$'),
  intent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz,
  closed_at timestamptz,
  CHECK ((closed_at IS NULL AND terminal_event_id IS NULL) OR
    (closed_at IS NOT NULL AND terminal_event_id IS NOT NULL AND run_id IS NOT NULL
      AND last_issue IS NULL AND observed_status IN ('COMPLETED','FAILED','CANCELLED','TERMINATED','TIMED_OUT')))
);
CREATE FUNCTION preserve_workflow_delivery_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Delivery intent cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.request_id,NEW.target,NEW.input_hash,NEW.intent_at) IS DISTINCT FROM
     ROW(OLD.request_id,OLD.target,OLD.input_hash,OLD.intent_at)
     OR (OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Delivery identity and terminal proof are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_delivery_identity BEFORE UPDATE OR DELETE ON workflow_delivery
  FOR EACH ROW EXECUTE FUNCTION preserve_workflow_delivery_identity();
COMMENT ON TABLE workflow_delivery IS 'Durable one-shot Start authorization and verified remote facts. Existing intent never authorizes another Start; unknown outcome preserves the source guard.';
COMMIT;
