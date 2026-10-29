# KAN-229 爬虫侧：每轮报告推给 Supply Smart（统计口径与数据来源）

状态：2026-10-29 上线。API 8230b5e9 部署在 Server 一；工具 `~/apps/crawl-report`，crontab 每周六 20:30 CT（owner：每周一次）。
Supply Smart 契约在 0087 采纳了下面的意见：营销/DTC 发 `ingestWindow`，Regulatory 按 `sync_run_ids` 对，`schedule.everyDays` 可填小数（Regulatory / 原料发 3.5）。

契约：supply-smart-mono `KAN-229-data-update-dashboard` 的 `docs/packages/database-api/domains/crawl-run-report.md`
（`crawlReport.submit`）。按契约 §0，**新增条数 / 新品牌 / 新公司由 Supply Smart 用 run id 在自己的账本里数**，
爬虫只报自己做了什么（targets / fetched / failed / pushed）+ 各渠道明细 `breakdown`。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 轮次统计（只读） | `packages/app/src/round-report/`、`packages/adapters/src/postgres/round-reader.ts`、API `rounds.list` | 从爬虫库算出各渠道的轮次 |
| 定时推送 | `tools/crawl-report/` | 调 `rounds.list` + 读 Regulatory / ingredient-intel 的同步记录 → 契约格式 → 推送 |

按 V3 规则，查库只在 API 里做（一个可重复读的只读事务），工具只调 API。

## 什么是"一轮"（营销渠道 + DTC）

爬虫库没有"轮次"记录。owner 开一轮 = 对一个渠道的所有品牌发 `brands.scan`（或者一次放进大批手工清单，如 Amazon
10-24 的 history recapture）。所以：

- **轮次开始**：一次品牌扫描请求，或一个 ≥100 个商品的手工清单（`startListItems`）。离上一个开始点超过 **72 小时**
  （`gapHours`）就算新一轮；小清单（变体补抓、WF 上看到的 ASIN）归入当时所在的那一轮。
- **轮次窗口**：[本轮开始, 下一轮开始)。清单、扫描、推送都按时间落到窗口里。
- **轮次结束**：窗口内每个商品的**第一次运行**都已结束、每个品牌扫描都已结束；结束时间 = 最后一个结束的时间。
  之后的 requeue 不会把老一轮重新打开，也不会把结束时间往后拖。没结束的轮次不推。

用 Server 一 10-29 的真实数据算出来的轮次（与运营记录对得上：Amazon 10-16 是第 3 轮，其它渠道 10-16 是第 2 轮，
09-30 是试跑）：

| 渠道 | 轮次开始 → 结束 |
|---|---|
| Amazon | 09-30 → 10-06；10-07 → 10-12；10-16 → 10-26；10-24 history recapture → 10-27 |
| Costco | 10-01 → 10-07；10-16 → 10-16 |
| GNC | 09-30 → 10-01；10-07 → 10-09；10-16 → 10-17 |
| Swanson | 09-30 → 10-01；10-05 → 10-08；10-16 → 10-17 |
| Whole Foods | 09-30 → 10-02；10-05 → 10-12；10-16 → 10-18 |
| DTC | 10-02 → 10-21；10-20 → 10-29 |

## 各渠道口径

| source | runId | targets / fetched / failed | pushed / 对账方式 | status | 数据来源 |
|---|---|---|---|---|---|
| amazon / costco / gnc / swanson / wholefoods | `<渠道>-<开始时间到分钟>` | 本轮清单里的队列商品（去重）/ 当前 completed / 当前 review | 窗口内 `product_sync` verified 行数；发 `ingestWindow` [本轮开始, 下一轮开始)，最新一轮到当前时间 | review 占比 > 5% → partial，否则 completed | `link_batch`、`queue_item`、`queue_attempt`(attempt=1)、`brand_scan`、`product_sync` |
| dtc | 同上 | 同上 | 窗口内 brand enrichment `products*` 步骤的 `delivered`；同上发 `ingestWindow` | 同上 | 同上 + `brand_enrichment_step` |
| regulatory | 推送的抓取 run id（regulatory.ingest 带的 runId） | 页面请求数 total / ok / failed+blocked | 推送事件数（各批 `received`） | 有来源不是 ok → partial | `~/regulatory-data/sync/runs/*`、`runs/*/manifest.json`、`last-sync.json` |
| branded_ingredient | ingredient-intel 的 run id | 重新匹配的 Supply Smart 原料名数；failed = 模型未答 | 链接 added + restored + removed | problems → partial，失败 → failed | `~/ingredient-intel-data/runs/*/report.json` |
| clinical_trial | 交付 id `deliver-…`（clinicalTrial.ingest 带的 runId） | ClinicalTrials.gov 读到的试验数；failed = 失败请求 | 推送的试验数 | 同上 | 同上 |

`breakdown` 里放：营销/DTC 的扫描数（总数、品牌源数、complete/partial/review/cancelled）、清单数、推送的 verified/failed/在途；
Regulatory 每个来源的新/改/删/总数 + `regulatory_sync_run` id；原料的名称、链接前后数；试验的新收/更新和各类链接计数。

只推送 Regulatory 的真实推送（10-18 只做了计划、没推送，不算）、ingredient-intel 的 `pushed: true` 运行。
10-20 的 Regulatory 推的是离线重处理的 run，抓取数取同一次同步里在线抓取的那个 run。

## 本地测试结果（2026-10-29）

- 快照：Server 一 爬虫库只读查询；Regulatory / ingredient-intel 只拷了同步记录的 JSON（26 MB，放在本会话 scratchpad）。
- dry-run：29 份报告（营销 17、DTC 2、Regulatory 4、原料 4、临床试验 4），都过契约校验。
- 本地直写：`localhost:5440/product_cloudtest_1018` 的 `crawl_report`（Supply Smart 未提交的迁移 0086）写入 29 行；
  再跑一次 29 份全部 `same`，不重复写。

## 需要 owner 拍板

1. 轮次参数：间隔 72 小时、手工清单 ≥100 个商品才算新一轮、review 占比 > 5% 记 partial。按 5%：Amazon 4 轮、Costco 2 轮、
   GNC 2 轮、DTC 1 轮、Swanson 09-30 试跑是 partial（error 里写明 review 数）。
2. cron 时间：建议每天 20:30 CT（在 Regulatory 18:00、原料 19:00 之后）在 Server 一 跑一次。
3. 部署：API 要多一个只读路由 `rounds.list`，需要按部署流程部署 Server 一 的 API；工具单独 clone 到 `~/apps/crawl-report`。
4. 首次推送会把 09-30 以来的 29 份历史报告一起推上去（测试环境）。

## 给 Supply Smart 的契约意见（总控转）

1. **营销渠道的推送不是按轮的。** product sync 每隔几分钟一批，一轮对应几百个 `marketplace-sync-<渠道>-<ISO>` run，下架走
   `listing-state-<ISO>-<渠道>`。爬虫账本 `product_sync` 每个商品只留**最后一次**的 ingest run id，所以老轮次的
   `ingestRunIds` 不全（被重发的商品挪到了后面的 run），下架 run 也列不出来，`removedRecords` 会漏。
   建议契约加 `ingestWindow: { from, to }`：按 `crawl_run.channel` + `started_at` 落在窗口里来汇总；爬虫发
   [本轮开始, 下一轮开始)。有了它 `ingestRunIds` 可以不发。
2. DTC 的 ingest run id 是 `brand-enrichment-<run>`；同一个 run 有多个域名时会加 `-<siteKey>`，爬虫的步骤记录里没存是哪个，
   可能出现 `runsMissing` 警告。
3. Regulatory（§7 第 2 条）：`runId` = regulatory.ingest 批次带的 runId；`breakdown.supply_smart_push.sync_run_ids` 是
   `regulatory_sync_run.id`，可以直接按它对。
4. `schedule.everyDays` 是整数，Regulatory / 原料是每周二、五两次（间隔 3、4 天交替），表达不了，所以不发 schedule，
   让页面用中位间隔。如果要发，建议支持小数或 `timesPerWeek`。
5. 营销渠道和 DTC 的 `scope` 一律 `partial`（ingest 本来就按 partial 发，一轮不证明某商品下架）；Regulatory / 原料 / 试验发 `full`。
6. 10-12 之前还没有 product sync，所以早期轮次 `pushed` = 0、没有 `ingestRunIds`（按契约默认 `[runId]` 会出 `runsFound: 0`
   警告，这是预期的）。
