-- 公司 ↔ 渠道品牌链接的常驻缓存。
--
-- 背景：库里的公司名和它在渠道上的品牌名经常对不上（Alani Nutrition LLC / Alani Nu），
-- 直接拿公司名拼 URL 会大量 404。渠道自己有权威品牌目录，抓一次就拿到全部正确 slug。
-- 把结果缓存下来，解析线和抓取线就能并行：解析出一个品牌链接，立刻排一个抓取任务，
-- 抓取线在忙的同时解析线继续往下查，互不等待。

-- 渠道品牌目录快照：一次浏览器访问换来整页品牌，是解析的免费依据。
create table if not exists channel_brand_catalog (
  channel       text not null,
  slug          text not null,
  label         text not null,
  url           text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (channel, slug)
);

-- 目录快照的抓取批次，用来判断"目录是否过期、该不该再抓一次"。
create table if not exists channel_catalog_snapshot (
  channel      text primary key,
  entry_count  int not null,
  captured_at  timestamptz not null default now(),
  job_id       uuid,
  status       text not null default 'ok'
);

-- 每家公司在每个渠道上的解析结果。一家公司只解析一次，除非目录更新了。
create table if not exists channel_brand_link (
  company_id      text not null,
  channel         text not null,
  company_name    text not null,
  -- resolved=找到且可信 · ambiguous=只共享部分词元需人工确认 · absent=目录里没有
  status          text not null,
  brand_slug      text,
  brand_label     text,
  brand_url       text,
  -- exact/strong=词元完全对齐可直接抓 · subset=部分重合待确认
  tier            text,
  evidence        jsonb not null default '{}'::jsonb,
  -- 依据哪一版目录得出的结论；目录更新后据此重算
  catalog_seen_at timestamptz,
  -- 已经为它排过抓取任务的时间，避免重复入队
  enqueued_at     timestamptz,
  run_id          uuid,
  checked_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (company_id, channel)
);

create index if not exists channel_brand_link_pending_idx
  on channel_brand_link(channel, status) where status = 'resolved' and enqueued_at is null;
create index if not exists channel_brand_link_status_idx on channel_brand_link(channel, status);

-- 解析线的目录刷新任务是一个普通 job，stage 枚举要放行。
alter table pipeline_job drop constraint if exists pipeline_job_stage_check;
alter table pipeline_job add constraint pipeline_job_stage_check
  check(stage in (
    'capture','process','ocr','normalize','ingest','cleanup',
    'capture_catalog','process_text','process_images','product_join','product_unify',
    'catalog_finalize','ingest_staging','cleanup_run',
    'resolve_brand_catalog'
  ));
