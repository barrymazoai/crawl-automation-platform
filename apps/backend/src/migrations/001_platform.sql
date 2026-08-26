create table if not exists platform_schema_migration (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists pipeline_source (
  id uuid primary key,
  url text not null,
  origin text not null,
  source_type text not null check(source_type in ('dtc_browser','sales_channel')),
  adapter text,
  mode text not null check(mode in ('one_off','recurring')),
  schedule_cron text,
  schedule_timezone text not null default 'Asia/Shanghai',
  enabled boolean not null default true,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(origin,mode)
);

create table if not exists pipeline_run (
  id uuid primary key,
  source_id uuid not null references pipeline_source(id) on delete restrict,
  status text not null default 'queued' check(status in ('queued','active','retry_wait','needs_review','failed','completed','abandoned')),
  item_count integer not null default 0 check(item_count >= 0),
  open_review_count integer not null default 0 check(open_review_count >= 0),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pipeline_run_status_idx on pipeline_run(status,created_at desc);

create table if not exists pipeline_job (
  id uuid primary key,
  run_id uuid not null references pipeline_run(id) on delete cascade,
  stage text not null check(stage in ('capture','ocr','normalize','ingest','cleanup')),
  state text not null default 'queued' check(state in ('queued','leased','running','retry_wait','needs_review','failed','completed')),
  required_capability text not null,
  depends_on uuid[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  output jsonb,
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  leased_by text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,stage)
);
create index if not exists pipeline_job_claim_idx on pipeline_job(state,required_capability,available_at,created_at);

create table if not exists pipeline_node (
  id text primary key,
  name text not null,
  platform text not null,
  version text not null,
  capabilities text[] not null,
  max_concurrency integer not null check(max_concurrency between 1 and 16),
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pipeline_artifact (
  id uuid primary key,
  run_id uuid not null references pipeline_run(id) on delete cascade,
  job_id uuid not null references pipeline_job(id) on delete cascade,
  kind text not null check(kind in ('evidence_bundle','ocr_bundle','codex_raw','normalized','review')),
  bucket_key text not null unique,
  file_name text not null,
  content_type text not null,
  sha256 text not null,
  byte_size bigint not null check(byte_size >= 0),
  status text not null default 'pending' check(status in ('pending','ready','delete_pending','deleted','delete_failed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists pipeline_artifact_job_idx on pipeline_artifact(job_id,status);

create table if not exists pipeline_review (
  id uuid primary key,
  run_id uuid not null references pipeline_run(id) on delete cascade,
  job_id uuid references pipeline_job(id) on delete set null,
  reason_code text not null,
  reason_message text not null,
  status text not null default 'open' check(status in ('open','resolved','abandoned')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists pipeline_event (
  id bigint generated always as identity primary key,
  run_id uuid not null references pipeline_run(id) on delete cascade,
  job_id uuid references pipeline_job(id) on delete set null,
  event_type text not null,
  actor text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pipeline_idempotency (
  scope text not null,
  idempotency_key text not null,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(scope,idempotency_key)
);

