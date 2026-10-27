# Amazon 月销量估算交付计划（KAN-226，CRAWLV3-225）

2026-10-27。研究结论见 Server 一 `/Users/server/kan226-bsr-fit/round3_results.md` 与 `/Users/server/kan226-head/head_results.md`；本计划只讲怎么做进爬虫、交给 Supply Smart。

## 目标

每个送到 Supply Smart 的 Amazon 商品带上：

1. 页面销量标签（已有，`unitsSold` = 档位下限，`unitsSoldPeriod = trailing_30d`）；
2. 根类目 Best Sellers Rank（`salesRank`，现在恒为 null，Supply Smart 列已存在）；
3. 没有标签时的月销量估计，按 owner 10-27 批准的规则，并标明是估算。

## 规则（owner 2026-10-27）

| 情况 | `unitsSold` | `extras.salesEstimate.source` |
|---|---|---|
| 页面有标签 | 档位下限（不变） | `badge` |
| 无标签，页面列有兄弟规格（多规格子商品） | 25（<50） | `variation_child` |
| 无标签，单规格，根类目 Health & Household，根排名 < 20,000 | 曲线估计（整数） | `rank_model`，附 `range80`、`rank`、`model` |
| 无标签，其余（排名 ≥ 20,000、无排名、非 H&H 根类目） | 25 | `floor` |

- 估算只在 Health & Household 根排名上标定过；其他根类目只给下限。
- 家族合计（各子规格相加）Supply Smart 没有落点（它的商品就是单个 ASIN），第一期只放 `extras.salesEstimate.family`，不进 `unitsSold`。
- `unitsSoldPeriod` 一律 `trailing_30d`，Supply Smart 才会把它当月销量聚合。

## 曲线（数据，不是代码里的公式）

来自 `head_binned_model.json`（round-2 + 榜单头部，留出一档以内 90.2%）。放进 v3-contracts 作为一张节点表，节点之间按 log–log 线性插值，100 名以内取 100 名的值，1,000,000 名以外给下限：

| 根排名 | 100 | 300 | 1,000 | 3,000 | 10,000 | 20,000 | 30,000 | 64,000 | 100,000 | 284,000 | 1,000,000 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 月销量中位数 | 71,319 | 44,400 | 22,535 | 9,552 | 3,010 | 1,115 | 776 | 236 | 117 | 12 | 1 |

80% 区间：排名 < 20,000 乘/除 1.9，其余乘/除 2.7。按 label-rules 的做法，表旁边放真实 ASIN 例子（round-2 留出集和榜单集各几条）做测试。

## 放哪一层、复用什么

| 层 | 改动 | 复用 |
|---|---|---|
| `packages/channels/amazon/src/commerce-rank.ts`（新） | 从 `#detailBullets_feature_div` / `#prodDetails` 读 "Best Sellers Rank: #N in <根类目>"（带 "See Top 100" 标记的那条），子类目排名忽略 | 与 `amazon-listing-date.ts` 同一容器、同一取文方式；旧后端 `archive/.../link-check.ts:339` 的正则作参考 |
| `packages/v3-contracts/src/commerce.ts` | `CommerceEvidence.salesRank?: {rank, category, rawText, selector} \| null`（可选，旧存档照常可读） | 与 `dateFirstAvailable` 同样的可选字段写法 |
| `packages/v3-contracts/src/amazon-sales-estimate.ts`（新） | 节点表 + `estimateMonthlyUnits(rank)` + 例子 | label-rules 的"规则表 + 真实例子"模式 |
| `packages/app/src/history/commerce-metrics.ts` | `salesRank` 取根排名数字（现在写死 null） | 现有 `Metrics` 字段 |
| `packages/app/src/product-delivery/sales-estimate.ts`（新） | `salesEstimateDelivery({channel, metrics, variants})` → `unitsSold`/`unitsSoldPeriod`/`extras.salesEstimate`，只对 amazon；在 `deliveryItem` 里跟在 `observedMetrics` 后 | `listing-date.ts` 的形状；`labelExtras` 同样把它从 label 请求体剥掉，保证已发送的 label 字节不变 |
| `packages/adapters/src/product-sync/marketplace-listing-date.ts` | 原件重解析同一次 `parseProduct` 顺带取 `salesRank`（改名为 retained commerce 读取，返回 DFA + 排名） | 已有的 sha256 校验、identity 校验、warning 路径 |
| `productSync.reopen {channel:'amazon', listingDates:true}` | 不改入口；重发时自动带上排名和估算 | 已有的回填通道（10-22 用它补了 3.5 万个上架日期） |
| `docs/operations/amazon-sales-estimate.md`、`AGENTS.md` | 规则一条 + 回填顺序 | 照 `amazon-listing-date.md` |

不需要新库：插值是两行算术；解析沿用 htmlparser2 已有的 DOM。Supply Smart 不用改（方案 A）。

## 测试

- 排名解析：用 R2 里真实原件做 fixture（有根排名的、只有子类目的、捆绑页无 BSR 的、`/clp/` 页），按 `verify-parsers-on-real-pages` 的规矩。
- 估算函数：节点表例子；留出集抽 20 个真实 ASIN 核对一档以内。
- 交付映射：四种 source 各一例；label 请求体与改前字节一致（照 `listing-date.test.ts`）。
- `pnpm check` + 独立审查，每阶段一次。

## 阶段

1. 解析 + 合约 + metrics + 交付映射 + 测试（一次提交）。
2. 原件重解析路径 + 文档 + AGENTS.md；部署两台；用 `reopen` 分批回填（先 `dryRun`，每批 ≤200，约 1,300/小时，3.5 万个约一天）。
3. 回填后抽查 Supply Smart 测试库：有标签/估算/下限各看 20 个。

## Owner 决定（2026-10-27）

1. **线上字段：方案 A。** 估算直接填 `unitsSold`，Supply Smart 不改；爬虫这边 `extras.salesEstimate.source` 记住它是估算。
2. 下限 25。
3. **其他根类目也套曲线，按类目缩放。** 各类目自己的幂律拟合在同一排名上与 H&H 曲线之比：美容个护 ≈ 1.0（10,000 名 2,997 对 3,010；留出 92%），食品 ≈ 0.5（1,980 对 3,010；自身拟合只有 53%），宠物 ≈ 0.17（547 对 3,010；样本 361）。实现为 H&H 节点表 × 类目系数 `{Health & Household: 1, Beauty & Personal Care: 1, Grocery & Gourmet Food: 0.5, Pet Supplies: 0.17}`，`extras.salesEstimate.model` 记类目和系数；表外根类目（Baby 等，样本 < 300）给下限 25，`source = floor`。
4. 独立审查模型：开审前问 owner。
