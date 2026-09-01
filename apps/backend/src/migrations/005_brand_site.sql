-- 渠道品牌的官网。
--
-- 拿公司名去猜品牌是在猜，拿域名跟域名比才是证据。GNC 自己不提供品牌官网
-- （品牌页外链只有 GNC 的页脚，JSON-LD 的 brand 只有 name 没有 url），
-- 所以得自己去解析：用品牌 slug/名字猜域名、跟随跳转拿到最终落地域名。
--
-- 关键是这件事按品牌算，不按公司算——目录只有 272 个品牌，而公司有 4092 家。
-- 查一次缓存下来，之后所有公司都白用。
alter table channel_brand_catalog add column if not exists site text;
alter table channel_brand_catalog add column if not exists site_host text;
-- guessed=按 slug/名字猜出来并验证可达 · none=试过但没解析出来
alter table channel_brand_catalog add column if not exists site_source text;
alter table channel_brand_catalog add column if not exists site_checked_at timestamptz;

create index if not exists channel_brand_catalog_site_pending_idx
  on channel_brand_catalog(channel) where site_checked_at is null;
create index if not exists channel_brand_catalog_site_host_idx on channel_brand_catalog(site_host);
