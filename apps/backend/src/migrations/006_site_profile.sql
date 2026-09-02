-- 站点 profile（crawl-products Skill 学到的"探索路线"）由控制面托管、存对象存储，
-- 任何节点领到某个域名的任务都能先拉后推：换节点不用搬文件。
--
-- 文件名沿用 Skill 的 profile-store 约定 <host>-<hash10>.json（hash 取自 origin），
-- 同一个 host 下可能有多份（http/https、www 与否）；R2 里的 key 为 crawl-v2/site-profiles/<host>/<file>。
-- profile 只存 selector 和动作语义，不存商品值——复跑重新枚举当前在售，天然覆盖上下架。
create table if not exists site_profile_file(
  host text not null,
  file_name text not null,
  bucket_key text not null,
  sha256 text not null,
  byte_size bigint not null,
  -- Skill 内部的 profile schema 版本；不符的 Skill 会拒绝并重学，这里只记录便于排查
  profile_version integer,
  learned_by text,
  status text not null default 'pending' check (status in ('pending','ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (host, file_name)
);
create index if not exists site_profile_file_ready_idx on site_profile_file(host) where status='ready';
