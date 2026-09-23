BEGIN;
-- A separately versioned extension: do not invalidate the running product fleet's
-- public V3 migration ledger when adding this independent preparation workflow.
CREATE SCHEMA brand_entry;
CREATE TABLE brand_entry.migration (name text PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE brand_entry.campaign (
  id uuid PRIMARY KEY, manifest_hash text NOT NULL, total integer NOT NULL CHECK(total>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE brand_entry.candidate (
  campaign_id uuid NOT NULL REFERENCES brand_entry.campaign(id), id uuid NOT NULL,
  ordinal integer NOT NULL, input jsonb NOT NULL, input_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','verified','review','failed','cancelled')),
  workflow_id text, run_id uuid, seed jsonb, fetch_job jsonb, result jsonb,
  claimed_at timestamptz, finished_at timestamptz, revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(campaign_id,id), UNIQUE(campaign_id,ordinal), UNIQUE(workflow_id),
  CHECK(input->>'companyId'=id::text),
  CHECK((state IN ('verified','review','failed','cancelled'))=(result IS NOT NULL)),
  CHECK(state<>'verified' OR (result->'cleanup'->>'status'='closed' AND result->>'state'='verified'))
);
CREATE INDEX brand_entry_pending ON brand_entry.candidate(campaign_id,ordinal) WHERE state='pending';
CREATE TABLE brand_entry.mapping (
  campaign_id uuid NOT NULL, candidate_id uuid NOT NULL, brand_id uuid NOT NULL REFERENCES public.brand(id),
  source_ids uuid[] NOT NULL, result_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(campaign_id,candidate_id),
  FOREIGN KEY(campaign_id,candidate_id) REFERENCES brand_entry.candidate(campaign_id,id)
);
CREATE FUNCTION brand_entry.preserve_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(OLD.campaign_id,OLD.id,OLD.ordinal,OLD.input,OLD.input_hash) IS DISTINCT FROM
    ROW(NEW.campaign_id,NEW.id,NEW.ordinal,NEW.input,NEW.input_hash) OR OLD.result IS NOT NULL OR
    (OLD.workflow_id IS NOT NULL AND ROW(OLD.workflow_id,OLD.run_id) IS DISTINCT FROM ROW(NEW.workflow_id,NEW.run_id)) OR
    (OLD.seed IS NOT NULL AND OLD.seed IS DISTINCT FROM NEW.seed) OR
    (OLD.fetch_job IS NOT NULL AND OLD.fetch_job IS DISTINCT FROM NEW.fetch_job) THEN
    RAISE EXCEPTION 'Brand preparation identity and terminal outcomes are immutable' USING ERRCODE='23514';
  END IF;
  NEW.revision=OLD.revision+1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_candidate BEFORE UPDATE OR DELETE ON brand_entry.candidate
  FOR EACH ROW EXECUTE FUNCTION brand_entry.preserve_candidate();
COMMIT;
