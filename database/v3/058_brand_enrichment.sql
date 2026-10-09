-- Brand enrichment (owner 2026-10-08/09): Supply Smart brand requests → crawler. Clues, Codex decisions, Apollo
-- tries and questions for a person live only here; Supply Smart receives decided results through its API.
BEGIN;
SET LOCAL search_path = public;

CREATE TABLE brand_enrichment_run (
  id uuid PRIMARY KEY,
  -- The Supply Smart brand request; null for a sub-brand or owner run started by another run.
  request_id uuid,
  parent_run_id uuid REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('request', 'sub_brand', 'owner')),
  brand_name text NOT NULL,
  brand_url text,
  -- Supply Smart company, once found or created.
  company_id uuid,
  workflow_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'waiting_for_person', 'completed', 'failed', 'cancelled')),
  stage text,
  summary jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((role = 'request') = (request_id IS NOT NULL AND parent_run_id IS NULL))
);
-- One live run per brand request.
CREATE UNIQUE INDEX brand_enrichment_run_live_request
  ON brand_enrichment_run (request_id) WHERE state IN ('running', 'waiting_for_person');
CREATE INDEX brand_enrichment_run_parent ON brand_enrichment_run (parent_run_id);

-- Each finished step's checked output (family check, research, Apollo, enrich, titles, review), so a retried
-- activity reuses it instead of asking Codex or Apollo again.
CREATE TABLE brand_enrichment_step (
  run_id uuid NOT NULL REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  step text NOT NULL,
  output jsonb NOT NULL,
  archive_keys jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, step)
);

CREATE TABLE brand_enrichment_clue (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  signal text NOT NULL CHECK (signal IN ('domain_redirect', 'website_our_brands', 'website_footer', 'web_search',
    'apollo_parent', 'apollo_suborganization', 'shared_apollo_org')),
  owner_name text NOT NULL,
  owner_domain text,
  owner_company_id uuid,
  quote text NOT NULL,
  url text,
  archive_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX brand_enrichment_clue_run ON brand_enrichment_clue (run_id);

-- At most three Apollo searches per run (owner 2026-10-08), enforced here as well as in code.
CREATE TABLE brand_enrichment_apollo_try (
  run_id uuid NOT NULL REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  attempt smallint NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  query jsonb NOT NULL,
  organization_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE brand_enrichment_decision (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  verdict text NOT NULL CHECK (verdict IN ('owner', 'independent', 'cannot_tell')),
  owner_company_id uuid,
  kind text CHECK (kind IN ('brand_of', 'subsidiary_of')),
  confidence numeric(4, 3),
  reason text NOT NULL,
  signals jsonb NOT NULL DEFAULT '[]',
  -- 'codex:<model>' or 'person'.
  decided_by text NOT NULL,
  -- What Supply Smart answered when the decision was sent; null until sent.
  sent jsonb,
  -- Person's spot-check: right / wrong, with a note.
  spot_check jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX brand_enrichment_decision_run ON brand_enrichment_decision (run_id);

-- What Codex could not decide, a possible merge, or a link Supply Smart refused (409): waits for a person.
CREATE TABLE brand_enrichment_question (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES brand_enrichment_run(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('ownership', 'merge', 'link_conflict', 'identity')),
  question jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'dismissed')),
  answer jsonb,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX brand_enrichment_question_open ON brand_enrichment_question (created_at) WHERE state = 'open';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON brand_enrichment_run, brand_enrichment_question, brand_enrichment_decision
      TO v3_runtime;
    GRANT SELECT, INSERT ON brand_enrichment_step, brand_enrichment_clue, brand_enrichment_apollo_try TO v3_runtime;
  END IF;
END $$;
COMMIT;
