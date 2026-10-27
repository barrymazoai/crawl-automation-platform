# Amazon 月销量：排名解析、估算与回填（KAN-226，CRAWLV3-225）

2026-10-27。规则由 owner 当日批准；研究在 Server 一 `/Users/server/kan226-bsr-fit/round3_results.md` 与 `/Users/server/kan226-head/head_results.md`，计划在 `docs/spark/2026-10-27-amazon-sales-estimate-plan.md`。

## 字段和数据链路

| 环节 | 位置 | 内容 |
|---|---|---|
| 页面解析 | `packages/channels/amazon/src/sales-rank.ts` | 根类目 Best Sellers Rank（带 "See Top 100 in <类目>" 的那条），`#detailBullets_feature_div li` 或 `#prodDetails tr`；子类目排名不取；两处布局不一致时为 null |
| 合约 | `packages/v3-contracts/src/amazon-sales-rank.ts`、`commerce.ts` | `CommerceEvidence.salesRank?: {rank, category, rawText, selector} \| null`，10-27 以前的存档没有这个字段，照常可读 |
| 曲线 | `packages/v3-contracts/src/amazon-sales-estimate.ts` | 节点表（排名 → 月销量中位数）、类目系数、`estimateMonthlyUnits()`；例子见同名测试 |
| 历史 metrics | `packages/app/src/history/commerce-metrics.ts` | `salesRank` = 根排名数字（以前恒为 null） |
| 交付 | `packages/app/src/product-delivery/sales-estimate.ts` | 见下表；只对 amazon，其他渠道原样 |
| 回填 | `packages/adapters/src/product-sync/marketplace-listing-date.ts` | 重解析原件时与上架日期同一次解析顺带得到 `salesRank`，挂在 `MarketplaceProduct.salesRank`，交付时优先于历史 metrics |

`extras.salesEstimate` 只走观测 ingest。label 请求体由 `labelListing` 整理：剥掉 `extras.salesEstimate`、`extras.commerce.salesRank` 和顶层 `salesRank`；`unitsSold`/`unitsSoldPeriod` 只在来源是 `badge`（metrics 本来就带的标签数）时保留，估算出来的 25 或曲线值不进 label。已发送的 label 字节不变（`listing-date.test.ts` 用真实 collected-product 对比整份请求体）。

解析只认 amazon.com 的英文写法（`See Top 100 in …`，区分大小写）；其他站点没有这一条，得 null。

## 交付规则（owner 2026-10-27）

| 情况 | `unitsSold` | `unitsSoldPeriod` | `extras.salesEstimate.source` |
|---|---|---|---|
| 页面有 "X+ bought in past month" | 档位下限（不变） | `trailing_30d` | `badge` |
| 无标签，页面列有兄弟规格 | 25 | `trailing_30d` | `variation_child` |
| 无标签，单规格，根排名 < 20,000，根类目有系数 | 曲线值 | `trailing_30d` | `rank_model`，附 `estimate.range80` |
| 其余（排名 ≥ 20,000、无排名、旧存档无排名、无系数类目） | 25 | `trailing_30d` | `floor` |

Supply Smart 按 `unitsSold` 原样显示（owner：线上不区分）；哪个数是估算只在爬虫这边的 `extras.salesEstimate` 里。`salesEstimate.rankRead` 为 false 表示这次根本没读到排名（10-27 以前的存档、且重发时原件不可用），这种 `floor` 和"页面真没排名"的 `floor` 以此区分，回填时可据此找出来再送一次。

交付项（观测 ingest）的 `salesRank` 是本次决策用的排名：新抓取来自历史 metrics，重发来自原件重解析；原件说没有排名时为空。

类目系数：Health & Household 1、Beauty & Personal Care 1、Grocery & Gourmet Food 0.5、Pet Supplies 0.17；其他根类目不估。

为什么排名靠前却没有标签：10-27 查过 88 个（单规格、排名 < 20,000），78 个是 OTC 药品子类目（Amazon 不给药品挂标签，这些本来就不送 Supply Smart），其余是新品或极少数；多规格子商品没标签则是该口味真的不到 50。

## 回填已同步的商品

用上架日期那条通道，不新增入口：

```sh
# 预览（dryRun 默认 true）
curl -s -X POST http://127.0.0.1:4188/trpc/productSync.reopen -H 'content-type: application/json' \
  -d '{"channel":"amazon","listingDates":true,"before":"<ISO 时间>","limit":200}'
# 真跑：加 "dryRun":false；每批 ≤200，已有 sweep 会重发，带上排名和估算
```

10-27 实测符合条件 45,046 个（含规格），每次最多 200，重发约 1,300 个/小时，全量约 35 小时。重发走观测 ingest；label 也会随每个商品重发，10-26 enrichment /4 之后约 12% 会报 `idempotency_conflict`（label 请求体的语义字段变了，owner 10-26 决定不改 operationId），这些行在 `product_sync` 里落 `failed`，但观测在 label 之前已经发出，不影响销量。

**Supply Smart 的快照键是 (listing, captured_at, source)，冲突静默丢弃。** 重发用原件、captured_at 不变，所以 source 必须随内容变：`sync-send.ts` 的 `batchSource` 用整批 payload hash 的指纹做后缀（10-27 之前是固定值，当天第一批 175 个 verified 在 Supply Smart 里 0 条快照；10-25/26 的上架日期回填同理只落了 247 条）。回填结果要在 Supply Smart 测试库核对，不能只看我们这边的 verified：

```sql
SELECT extras->'salesEstimate'->>'source', count(*) FROM listing_snapshot
WHERE created_at >= '<回填开始时间>' AND extras ? 'salesEstimate' GROUP BY 1;
```

sweep 对"verified 且 payload hash 和上次一样"的行只 touch 不发；10-27 起 ledger 读取时带 `reopened`（`material_at = -infinity`），reopen 过的行不走这个捷径，所以已经发过一次、被 Supply Smart 丢掉的行再 reopen 会真的重发。（不能改成清 `payload_hash`：`061_product_sync.sql` 约束 verified 行必须有 hash。）这条对所有 reopen 入口生效：`withoutLabel` / `withLabel` / `enriched` 过滤器重开的 verified 行以后也会真发一次（ingest + label + 回读），内容没变时 label 回 replayed、快照被 Supply Smart 去重，只多花调用；发送失败的行会从 verified 变 failed，但 ID 和 hash 保留。

sweep 节奏（worker 私有配置 `brandEnrichment.productSync`）：每 15 分钟一轮，每批 50，一轮最多 10 批；一批里一个都不用发就停到下一轮。实际发送约每分钟 50 个，上限约 2,000/小时。

回填后抽查 `badge` / `rank_model` / `floor` 各 20 个。

## 本地验证

```sh
pnpm -C packages/v3-contracts exec vitest run src/amazon-sales-estimate.test.ts
pnpm -C packages/channels/amazon exec vitest run src/sales-rank.test.ts
pnpm -C packages/app exec vitest run src/product-delivery src/history/commerce-metrics.test.ts
pnpm -C apps/api exec vitest run src/amazon-listing-date.test.ts
pnpm check
```
