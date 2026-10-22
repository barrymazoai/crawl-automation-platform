# Amazon Date First Available（KAN-226）

2026-10-22：本地实现和离线验证；未部署，未读取或写入生产数据库，未执行回填。
本次生产触及产品数为 **0**。约 20,000 是问题背景，不能当作本实现的精确候选数。

## 字段和数据链路

- `packages/channels/amazon/src/listing-date.ts` 只读两个产品详情结构：
  `#detailBullets_feature_div li` 的 `.a-text-bold` 标签，和 `#prodDetails tr` 的 `th/td`。
  标签必须是 `Date First Available`。不使用 Publication date、标题、ASIN 或 first-seen 推断。
- 使用仓库指定的 `date-fns`、en-US locale 解析 `MMMM d, yyyy` 和 `MMMM d yyyy`，
  格式往返验证排除宽松解析的月份缩写、短年份和多余文本，最后保留 Zod `iso.date()` 校验。
  Amazon 包声明已有工作区依赖 `date-fns`；HTML 继续使用现有 LinkeDOM，无通用提取器。
- `amazonCommerce` 输出 `dateFirstAvailable: {date, rawText, selector} | null`。
  `date` 是 `YYYY-MM-DD`；`rawText` 是匹配行原始 `textContent`，保留 RLM/LRM 和空白。
  缺字段返回 `null`；无法识别或冲突日期保留原文、`date: null`，不阻断产品。
- `CommerceEvidenceSchema` 增加可选字段，旧材料仍可读。现有 `capturedPage → MetricsHistory →
  captureHistoryEntry → commerceMetrics` 已完整保留 commerce，因此不复制历史映射逻辑：
  `product_history_source.record.metrics.extras.commerce.dateFirstAvailable` 和
  `product_history_observation.record.extras.commerce.dateFirstAvailable` 随新采集写入，原件引用不变。
- 共用 `product-delivery/mapping.ts` / `listing-date.ts` 将 Amazon 的日期映射为
  `DeliveryItem.listedAt`、`listedAtSource: "amazon_dfa"`，原文也随 `extras.amazonDfa` 投递。
  原有 `marketplaceItem → ProductSyncService → SupplySmartObservationWriter →
  product.ingestObservationBatch` 直接传递这些字段。其他渠道不增加 listedAt。
- `label-mapping.ts` 排除新增 DFA 顶层字段和 extras 字段，以保持旧标签请求正文、operationId
  和 observationId 一致；否则补送相同标签会产生幂等冲突。标签内容不重新 OCR 或模型分析。

## 日期表示

例如 `October 13, 2025` 保留为 `2025-10-13`，投递为 `2025-10-13T12:00:00.000Z`。
12:00 UTC 是日历日期的存储约定，不是声称 Amazon 在中午上架。
UTC 零点在美国会显示前一天；中午在美国各主要时区及中国仍是当天。
不存在对全球所有时区都保持同一天的单一 instant：UTC+12 到 UTC+14 会显示次日。
原始 calendar date 和页面原文是权威值；后续若要求全球一致，需消费端按日历日期显示。
`capturedAt` 和 `first_seen` 的语义与处理逻辑不变。

## 历史回填：复用已有重分析/同步入口

现有 `PostgresMarketplaceReader → MarketplaceMaterials → marketplaceProjection → retainedProjection`
保持原有投影选择：所有渠道均先读 `enrichment.subject.titleEvidence`，再读 `history.evidence`。
Amazon 另由 `marketplaceListingDate` 只从当前 capture 的 `history.evidence` 读取原始 HTML，
复用 `retainedValue` 校验 SHA-256，解析并检查 ASIN/variant 与该历史记录一致。
此独立解析只返回 DFA，作为 `MarketplaceProduct.dateFirstAvailable` 传给共用 mapper；
不替换已选标题投影的标题、图片或规格，其他指标仍使用原历史值。
**DFA 是可选补充，不能阻断原本可同步的商品。** 原件缺失（含 NoSuchKey）、读失败、哈希错误、
身份不符或无法解析时，返回 `dateFirstAvailableWarning`，并记录带 runId、listingId、
observationId、reason 和可用错误 code 的 warning；不把它变成商品的 `problem`。
mapper 省略 listedAt、listedAtSource、extras.amazonDfa，也不回退使用历史 metrics 中的日期。
商品 projection 的读取顺序、完整性错误和身份检查维持原行为；取消信号仍向上传播。

**不 UPDATE 历史表，也不重新 append 假装是新采集的历史记录。**
旧记录与哈希保持原样，日期在同步读取时重算；原始 HTML 继续是可复现证据。
补送保留原始 capturedAt/source。只读核对 Supply Smart 本地参考实现发现：
`product-ingest-service.ts` 将 listedAt 传给 DAO；`product-dao.ts` 先用 COALESCE 补日期，
再执行 snapshot 的 `ON CONFLICT DO NOTHING`。所以旧 snapshot 去重不会阻止补空日期，
也无需更换 source 或伪造新的采集时间。重复 snapshot 的 extras 不会被覆盖；回填原文仍可由
Crawler 的不可变原件和本次 payload 复现，新采集则直接保存在历史字段中。

### 入口和精确范围

现有 **POST `/trpc/productSync.reopen`** 新增 `listingDates: true` 分支。
默认 `dryRun: true`，数据库只发 SELECT，并读取本批 R2 原件；`dryRun: false` 才调整选中
`product_sync` 行的同步水位，再检查实际重开项的原件。不会因为 DFA 不可用而排除商品。
它不修改 `queue_item`、不调用 requeue、不启动抓取。已有品牌 enrichment worker 的
`ProductSyncSweep` 会在下一次正常 sweep 中解析保留材料并发送 partial ingest。

候选条件共同使用现有 `settledMarketplace`：

1. Amazon 最新 queue item 已成功 settled，且没有 unlisted 结果；不会退回更旧成功任务。
2. 品牌已有匹配公司；同步状态是 `verified` 或 `present`，且没有错误/待审核标记。
3. 同步水位已经覆盖当前材料，排除本来就在 pending 的产品；排除已重开的 `-infinity`。
4. `product_sync.updated_at < before`，可额外指定 `listingIds`；每次最多 200 个身份。

预览返回 `eligible`（上述条件下的总身份数，LIMIT 前）及 `selected`（本批 listingId/variantId
和实际材料的 runId/sourceId/url，跟随任务使用原 leader 的材料）。执行的 `selected` 只包含
UPDATE RETURNING 实际重开的项，`reopened` 为其数量，不将并发时未更新的候选算进去。
两种调用都返回 `originals.checked`、`originals.noReadableOriginal`、`originals.warnings`。
`noReadableOriginal` 指无法读取并验证为当前商品原件的项数，包含缺失、读取/解析失败、哈希或身份
不符；warnings 逐项提供身份、runId、reason 和可用错误 code。原页可读但没有 DFA 的 bundle
**不计入**此数。历史记录缺失或完整性校验失败单列为 `history_unavailable`，也计入不可用数。
这些是本次检查时的可用性计数，不代表未来同步一定能读到原件，也不是下游填入日期数。
API 未配置原件读取时，此操作在修改水位前返回 `PRODUCT_SYNC.ORIGINALS_NOT_CONFIGURED`。
保持同一个过去的 `before`，已经处理过的行
updated_at 会越过截止点，不会被下一批再选中。
**eligible 是待重分析产品数，不是成功填入日期的数目**：页面无 DFA、原件损坏/缺失、
Supply Smart 已有 listed_at、并发材料变化等都会让实际补空数更少。

### Owner 执行顺序（本次未运行）

先按仓库流程审核/部署此改动并在 Mini 做一件真实产品的端到端验收。
确保 API 和既有同步 worker 都运行此版本；不启动抓取队列，也不新增启动机制。
取启用修复前的一个过去时间作为固定 `before`。以下日期仅是示例，实际替换为所选截止点。
请求正文就是 JSON 对象，不需要 `{json: ...}` 包装。

1. 先预览并保存响应。此调用会读取本批 R2 原件，不写数据库、不调用 Supply Smart、不重抓网页。

   ```http
   POST /trpc/productSync.reopen
   Content-Type: application/json

   {"channel":"amazon","listingDates":true,"before":"2026-10-22T00:00:00Z","limit":200,"dryRun":true}
   ```

   `result.data.eligible` 就是当时的精确候选数 N，不预设为 20,000。
   `result.data.selected.length` 是该批数量（≤200）。记录这两个数、完整 ASIN 清单及
   `result.data.originals.noReadableOriginal` 和 warnings；不可用的原件不靠重抓填补。

2. 从返回的 `selected` 选一个 ASIN 做 pilot；同一请求加 `listingIds:["该ASIN"]`、
   `limit:1`、`dryRun:false`。例如该 ASIN 确实在预览中时：

   ```json
   {"channel":"amazon","listingDates":true,"before":"2026-10-22T00:00:00Z","listingIds":["B0013LAQS6"],"limit":1,"dryRun":false}
   ```

   等现有 sweep 完成；通过 `GET /trpc/productSync.status` 和现有 worker 的 `product sync batch`
   日志查看 pending、verified、failed 和 ingestRunId。
   Supply Smart 当前 `verifyObservationBatch` 的 listing 回读不含 listedAt，因此该 verified 状态
   **不能单独证明日期已落库**；owner 需通过 Supply Smart 产品查询/页面核对 pilot 的 listed_at、
   source 和原页面日期，再扩大批次。不得因 failed/sent 状态自动重试。

3. pilot 通过后，使用步骤 1 的预览，然后对返回的至多 200 个 ASIN 使用同一 cutoff、
   `listingIds` 和 `dryRun:false`。记录 `reopened`、执行结果的 originals 计数及 warnings，
   等该批处理完再预览下一批。
   仅选新预览中的 ASIN，不使用宽泛的旧 `withLabel/present/unfinished` 重开模式。
   结束条件是 `eligible:0`，同时单独核对 pending/failed/sent，不能把重开数当作成功数。
   并发同步可能令执行数小于预览数，以 `reopened` 为实际影响数。

无 DFA 的页面正常发送产品而省略 listedAt；DFA 原件不可用时记录 warning，并按原有标题投影
继续同步该商品，不增加任何 DFA 投递字段，绝不联网补抓。只有商品投影自身按原规则失败时才会
产生 material failure。此分支不重开 failed、sent、审核记录，也不更改
Supply Smart 已有日期或 New Listing 规则。未成功 settled、品牌未匹配和缺同步基线的产品
不属于此批：正常新同步仍会携带 DFA，它们不能计作此次回填成功。

## 本地验证

六份原始保存页面均完整调用 V3 Amazon reader，未复制页面入 git：

| 页面 | 结果 |
| --- | --- |
| `amazon-static-B0013LAQS6.html.gz` | `2007-06-13` |
| `amazon-static-B0G963NB8Q.html.gz` | `2025-12-19` |
| `us/B0FRQMSCGV.html` | `2025-10-13` |
| `us/B07NQMLYMQ.html` | `2019-02-14` |
| `us/B084P2MVRJ.html` | `2016-05-19` |
| `pages/B0GR1L7J9J.html`（prodDetails） | `null`，产品解析继续 |

另对真实保存的详情行做受控 DOM 搬移，验证含日期的 prodDetails 表格分支；这不是独立网站新观测。
两份 gzip 原件还跑了离线全链路：真实 parser → capture history → 模拟旧历史缺字段 →
真实 marketplace reader（R2/数据库用内存替身）→ 实际 DeliveryItem。
验证日期/原文/采集时间、历史未变、原件哈希错误、串 ASIN 拒绝，以及五个查看时区。
新增带 `titleEvidence` 的回归：人为保留与当前真实 HTML 解析不同的历史标题/图片/规格，
证明所选投影和完整标签请求（含幂等键）逐字节不变；observation 仅增加 listedAt、
listedAtSource、extras.amazonDfa。即使标题投影有效，缺失、损坏、串 ASIN 的原件也不能提供 DFA。
补充回归覆盖原件不可用时商品/标签请求仍逐字节等同原行为、warning 可见、取消传播，以及
预览和执行的原件计数；真实无 DFA bundle 的可读原件不误计为缺失。

测试调用：设置 `V3_TEST_DATA_DIR` 为用户指定的 `scratchpad/us`，
`V3_AMAZON_DFA_DATA_DIR` 为同一 scratchpad 目录（包含 us/ 和 pages/），执行
`pnpm exec vitest run --config vitest.v3.config.ts --exclude '**/*.integration.test.ts'
packages/channels/amazon/src packages/app/src
apps/api/src/amazon-listing-date.test.ts apps/api/src/amazon-listing-date-backfill.test.ts
apps/api/src/product-sync-router.test.ts
packages/adapters/src/product-sync/marketplace-materials.test.ts
packages/adapters/src/postgres/product-sync-listing-dates.test.ts
packages/adapters/src/product-delivery/retained-projection.test.ts
packages/adapters/src/product-delivery/delivery-service.test.ts`，再执行 `pnpm check`。

本次可选降级修复后的结果：上述回归 115 个测试文件通过、6 个文件跳过；999 项通过、135 项跳过。
另取消 `V3_TEST_DATA_DIR`、保留 `V3_AMAZON_DFA_DATA_DIR`，同一命令仅选择
`packages/channels/amazon/src`、两个 `apps/api/src/amazon-listing-date*.test.ts` 和
`packages/app/src/product-delivery/listing-date.test.ts`，补测仓库中已有保存页及降级路径：
21 个文件通过、1 个跳过；265 项通过、45 项跳过。
两轮有重叠，不相加；跳过原因均为其余既有外部夹具未提供。六份指定原页和新增投影/标签幂等测试全部通过。
`pnpm check` 通过（lint、依赖边界/版本、重复代码、22 个 package 的类型检查）；
`git diff --check` 通过。Turbo 报缓存 IO 权限警告，但所有检查正常结束，退出码为 0。

未运行生产回填、真实 PostgreSQL/Provider/浏览器集成测试或在线 Supply Smart 写入。
数据库候选 SQL 已通过离线仓库/API 测试；Mini 上的 SQL 集成及一件真实下游落库验收仍待 owner 执行。

## 改动文件索引

| 文件（同目录以逗号分隔） | 目的 |
| --- | --- |
| `packages/channels/amazon/src/listing-date.ts`, `commerce.ts` | DFA 专用双布局解析并接入 commerce |
| `packages/channels/amazon/package.json`, `pnpm-lock.yaml` | 声明工作区已有的 date-fns，替换手写月份表 |
| `packages/v3-contracts/src/amazon-listing-date.ts`, `commerce.ts`, `product-delivery.ts`, `index.ts` | 可选原始字段与投递类型，共用契约 |
| `packages/app/src/product-delivery/listing-date.ts`, `listing-date-read.ts`, `mapping.ts`, `wire.ts`, `label-mapping.ts`, `index.ts` | 统一日期表示/传输；不可用原件的可选降级；保持标签请求不变 |
| `packages/app/src/product-sync/marketplace-model.ts`, `sync-control.ts`, `ledger.ts`, `listing-date-originals.ts`, `brand-company-errors.ts`, `index.ts` | 原件读取诊断、预览/执行结果的检查计数和有限补送控制 |
| `packages/adapters/src/product-sync/marketplace-projection.ts`, `marketplace-listing-date.ts`, `marketplace-materials.ts`, `marketplace-history.ts` | 保留原投影选择，独立读取同次采集原件的 DFA；共用原历史的读取/校验，失败带 run ID 警告 |
| `packages/adapters/src/product-sync/listing-date-originals.ts`, `packages/adapters/src/index.ts` | 复用同一原件读取路径，报告准确选中范围的不可用数量和原因 |
| `apps/api/src/product-sync-parts.ts`, `routers/product-sync.ts`, `apps/worker/src/product-sync-parts.ts` | API 接入只读原件检查和取消信号，worker 复用日志配置 |
| `packages/adapters/src/product-delivery/retained-value.ts`, `retained-projection.ts` | 共用保留原件读取与 SHA-256 验证 |
| `packages/adapters/src/postgres/postgres-product-sync.ts`, `product-sync-listing-dates.ts` | 复用已有同步入口；候选计数和受限水位更新 |
| `packages/channels/amazon/src/listing-date.test.ts`, `testing/saved-pages.ts` | 六个指定保存页面、日历边界、表格分支；外部夹具路径可配置 |
| `packages/app/src/product-delivery/listing-date.test.ts`, `packages/app/src/product-sync/sync-control.test.ts` | 时区、空值、渠道隔离、标签幂等、控制校验 |
| `apps/api/src/amazon-listing-date.test.ts`, `amazon-listing-date-backfill.test.ts`, `amazon-listing-date.fixture.ts`, `product-sync-router.test.ts` | 离线真实页面全链路、原件不可用的降级、预览/执行计数和 API 默认只读行为 |
| `packages/adapters/src/postgres/product-sync-listing-dates.test.ts` | 确认预览无写入、执行仅改变同步水位 |
| 本文 | 操作步骤、影响范围、证据与验收限制 |
