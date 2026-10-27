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

`extras.salesEstimate` 只走观测 ingest；label 请求体里连同 `commerce.salesRank` 一起剥掉（`labelExtras`），已发送的 label 字节不变。

## 交付规则（owner 2026-10-27）

| 情况 | `unitsSold` | `unitsSoldPeriod` | `extras.salesEstimate.source` |
|---|---|---|---|
| 页面有 "X+ bought in past month" | 档位下限（不变） | `trailing_30d` | `badge` |
| 无标签，页面列有兄弟规格 | 25 | `trailing_30d` | `variation_child` |
| 无标签，单规格，根排名 < 20,000，根类目有系数 | 曲线值 | `trailing_30d` | `rank_model`，附 `estimate.range80` |
| 其余（排名 ≥ 20,000、无排名、旧存档无排名、无系数类目） | 25 | `trailing_30d` | `floor` |

Supply Smart 按 `unitsSold` 原样显示（owner：线上不区分）；哪个数是估算只在爬虫这边的 `extras.salesEstimate` 里。

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

约 1,300 个/小时；3.5 万个 Amazon 商品约一天。重发走观测 ingest，label 不重发。回填后抽查 Supply Smart 测试库：`badge` / `rank_model` / `floor` 各 20 个。

## 本地验证

```sh
pnpm -C packages/v3-contracts exec vitest run src/amazon-sales-estimate.test.ts
pnpm -C packages/channels/amazon exec vitest run src/sales-rank.test.ts
pnpm -C packages/app exec vitest run src/product-delivery src/history/commerce-metrics.test.ts
pnpm -C apps/api exec vitest run src/amazon-listing-date.test.ts
pnpm check
```
