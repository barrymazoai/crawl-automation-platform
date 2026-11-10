# KAN-243 第二个国家：澳大利亚亚马逊（amazon.com.au）计划

2026-11-10，待用户批准。用户 11-10 选了澳大利亚（「先做澳大利亚吧，出个计划」）。印度的做法见 `KAN-243-india-research.md`。

## 0. 为什么先做澳大利亚（11-10 实测）

- ScraperAPI 可以抓，`country_code=au` 能用，每页 5 credits，没有遇到验证页。
- 抽了 20 个我们的美国品牌，按 p_123 品牌 ID 去搜，11 个在澳洲有卖。同样的方法印度是 8 个，而且澳洲这次没限定营养补充品类，数字偏高。
- 搜到的商品里 41% 和我们已采完的美国商品是同一个 ASIN。这些多半是进口货，标签是英文 Supplement Facts。
- 网站是英文，不用翻译。
- Supply Smart 正式环境的站点白名单里已经有 `amazon.com.au → AU / AUD`（`packages/database-api/src/lib/marketplace.ts`，main），跨站判同查询 `getCrossMarketListings` 也已经在 main 上。Supply Smart 那边不用改。

从实测页面看到的澳洲站特点：
- 价格要取 `priceToPay`，和印度一样：第一个 `.a-offscreen` 可能是原价或单价（例如 $0.04/片）。
- BSR 写作 `Best Sellers Rank: 312 in Health, Household & Personal Care`，和美国一样。
- 上架日期格式是 `9 May 2018`，和印度一样是 `d MMMM yyyy`。
- 营养补充品类：`Vitamins & Supplements`，node 5148202051。它的上一级是 Health, Household & Personal Care（4851917051），下面有 Vitamins, Minerals & Supplements（5148231051）。运动营养是不是在 5148202051 下面，第 1 步要核实。
- 本土品牌（例：Cenovis）的成分写在页面文字里，是 TGA 的写法：`Ingredients: Colecalciferol (Vitamin D3 1000IU) 25micrograms`。标签图上一般是「Each tablet contains」加「Active ingredients」，和印度的「Each … contains」那种成分写法很像。

## 1. 原则

- 印度接入时，Amazon 渠道已经改成「一个站点一份配置」（`c4fcacac`），交付、判同和标签格式也都按站点走。澳洲尽量只加配置，不复制代码。
- 印度接入时留下的「只认 `amazon-in`」的地方，这次改成按站点列表（`AMAZON_CHANNELS`）判断，免得每加一个国家就多一个写死的值。这类地方约有 24 个文件，下面第 3 步逐个列出。
- 推送直接推正式环境（用户 11-09 定的），带 `marketplace: "amazon.com.au"`。
- 标签规则只加在澳洲自己的规则集里，美国和印度不变，回放结果逐字节相同。

## 2. 第 1 步：澳洲样本调研（约 200 credits，不改代码）

和印度第 1 步一样：从澳洲 Vitamins & Supplements 畅销榜取 20 个商品，存下原始页面（只放在 Server 一和 R2，不进 git），然后统计：
- 标签版式和占比。预计有三类：美国 Supplement Facts（进口货）、TGA「Each tablet contains / Active ingredients」、只有配料没有表。
- 标签是在页面文字里还是只在图片里。Cenovis 的成分在文字里。
- 现有解析器在澳洲页面上能读出哪些字段：标题、价格、BSR、上架日期、图库、卖家、规格。
- 现有挑图关键词和照抄提示词能不能认出 TGA 标签。

产出：一张版式表，加上要不要新加 `au-tga/1` 标签格式的结论。如果 TGA 写法用印度的 `in-composition` 规则就能读，就不新加格式，只在澳洲的格式列表里复用。

### 2.1 第 1 步结果（2026-11-10）

- **抓了什么**：
  - 畅销榜 2 页（node 5148202051，60 个商品）。
  - 商品页 22 个：20 个榜单商品，加 2 个和美国同 ASIN 的进口货（Nature's Truth、Host Defense）。
  - 另抓 24 页，用来测送货地，见下面第一条。
  - 共 46 页，每页 5 credits，合计 230 credits。
  - 全部逐字节存进 R2 `research/kan243-au/scraperapi/`，回读校验 SHA-256；副本在 Server 一 `~/kan243-research-au/`。
- **运动营养在 5148202051 下面**：子类目有 Sports Supplements（5148230051）、Nutrition Bars & Drinks、Vitamins, Minerals & Supplements。
- **送货地有一半落到南非（最大的问题）**：
  - 带 `country_code=au` 的请求，Amazon 有一半把送货地显示成 `Deliver to South Africa`，页面显示 Currently unavailable，没有价格。
  - 实测落到南非的比例：普通请求 15/32，premium 6/10，ultra premium 1/4。三档每页都是 5 credits。
  - 换档位解决不了。ScraperAPI 的邮编定位只支持美国站。
  - 落到南非的页面，标题、图库、成分文字都正常，只缺价格和库存；送货地是悉尼 2000 的页面，价格都对。
  - 所以采集时必须先看送货地：不是澳洲邮编就再请求，否则会把有货的商品当成无货。
- **现有解析器（套印度设置，改成 AUD、4 位邮编）在 22 页上的表现**：
  - 读对的：ASIN、上架日期（`9 May 2018`）、图库、规格、邮编 2000。
  - 价格：落到澳洲的 10 页全部读对，取的是 priceToPay，原价进 listPrice。
- **页面文字里就有成分（20/22）**：在 Important information 的 Ingredients 一栏，大多是 TGA 写法，例：`EACH TABLET CONTAINS: VITAMIN B12 (cyanocobalamin) 1000 mcg`、`Active ingredients (per tablet): …`。
  - Nature's Way 一例：页面文字的配方和图上的配方不一样，图上是新版。所以页面文字只能在图库没有标签时用。
- **标签版式（看了 12 个商品的图库）**：
  - TGA「Each tablet/capsule contains」两列清单，没有 %DV：6 个（Centrum、Life-Space、Nature's Way、Swisse B12、Blackmores、Cenovis）。其中 Swisse、Blackmores、Nature's Way 的字竖排或很小。
  - FSANZ「Nutrition Information」表（per serve / per 100 g）加 Ingredients：1 个（Musashi，运动食品）。
  - 美国 Supplement Facts：2 个（Nature's Truth、Host Defense，都是进口货）。
  - 图库里没有成分表：3 个（Ostelin 只有正面的 `Colecalciferol 25 micrograms`，Hydralyte 和 ON Whey 全是营销图）。这三个页面文字里都有成分。
  - TGA 清单和印度的「Each … contains」写法同构，结论是复用 `in-composition` 的读法，不新加 `au-tga/1` 格式。

## 3. 第 2 步：`amazon-au` 渠道（代码）

| 改什么 | 在哪 | 说明 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-au": { marketplace: "amazon.com.au", origin, countryCode: "AU", currency: "AUD" }` |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_AU`：hosts、价格前缀 `$` / `A$`、4 位邮编、`d MMMM yyyy`、按畅销排序、每个品牌读 2 页、node 5148202051（第 1 步核实）、图库按高分辨率下载 |
| 数据库 | 新迁移 `07x_amazon_au_channel.sql` | 照 071 的写法，把 `amazon-au` 加进 6 张表的 channel CHECK，`queue_control` 加一行，默认暂停 |
| 渠道列表 | `v3-contracts/src/channels.ts`、`channel-plan.ts`、`channel-evidence.ts`、`channels/core/src/planning/source-order.ts`、`apps/worker/src/config.ts`、`app/src/brand-scans/scan-model.ts`、`app/src/product-sync/{ledger,marketplace-model,sync-control,brand-company-model}.ts`、`adapters/.../brand-company-queries.ts`、`postgres-product-sync.ts`、`product-sync-enrichments.ts` | 写死了 `"amazon-in"` 的列表改成从 `AMAZON_CHANNELS` 推出来；SQL 里的列表用同一个常量拼 |
| 推送目标 | `apps/worker/src/brand-enrichment-settings.ts`、`product-sync-parts.ts` | `targets` 的键从只有 `"amazon-in"` 改成任何非美国站点。澳洲也配一个目标（指向正式环境），这样跨站判同和按域名找公司对澳洲同样生效 |
| 标签 | `v3-contracts/src/label-formats.ts`、`processing/src/label/markets/market-rules.ts` | `amazon.com.au` 用美国格式加澳洲格式（按第 1 步结论）；`AU_RULES` 先等于美国规则，加上第 1 步证明需要的规则 |
| 销量估算 | 交付层 | 澳洲不套美国的 BSR 销量曲线，和印度一样：有销量徽标就用徽标，没有就不估 |

## 4. 第 3 步：找澳洲的品牌源（复用印度的两个办法）

- **按品牌 ID 推出来**：`brands.deriveAmazonInSources` 现在只会推印度，改成带 `channel` 参数，同一套代码推澳洲。不用抓页面，免费。
- **按品牌名查**：`brands.lookupAmazonInSources` 同样改成带 `channel`，在澳洲营养补充品类里按品牌名搜，读左侧 Brands 筛选。存档目录用 `<channel>-brand-lookup`。每个品牌一页，5 credits。
- 推出来或查到的来源默认不启用。扫一遍之后，没商品的（FILTER_LOST）留着不启用，有商品的才启用，做法和印度一样。

## 5. 第 4 步：验证（按 AGENTS.md：先 1 个请求，再放量）

1. 部署之后先抓 1 个商品页，核对地区、价格和单价。
2. 20 个商品端到端推正式环境。看页面字段、配方和 Review 率，并抽查 10 个商品的剂量和标签图对不对。目标和印度一样：Review 率 < 10%，而且不能把读错的收进来。
3. 通过后再做全量：先按品牌名查一遍我们全部公司的品牌，再扫有商品的品牌，最后采商品。

## 6. 成本和时间估计

- **credits**：第 1 步约 200；按品牌名全量查一遍（约 2,200 个品牌）约 11,000；品牌扫描和商品页按印度的量级算，约 3 万到 5 万。全量开跑前我会再按查名结果报一次准确数字。
- **时间**：
  - 第 1 步半天；
  - 第 2、3 步约 1.5 天（大部分是改列表和测试）；
  - 第 4 步验证半天；
  - 全量采集约 1 天。
- **每步做完的检查**：每步结束都跑 `pnpm check` 并做独立审查，部署照常拿部署锁。

## 7. 要用户决定

1. **同 ASIN 的进口货要不要直接用美国配方？** 澳洲 41% 是同 ASIN，比印度多得多。
   - A（推荐）：照印度的做法，澳洲标签照样读，交付前跟美国那条判同。成本是多跑一遍标签读取，但不会把美国配方错挂到澳洲本地版上；判同用的配方逐行比对规则也能用上。
   - B：同 ASIN 直接复用美国配方，不读澳洲标签。能省掉约四成的标签读取，但澳洲版有时配方不同（TGA 要求的剂型、剂量可能不一样），会挂错配方，而且要新做一步「先判同再决定读不读」。
2. **第一期范围**：按我们库里全部公司的品牌查，和印度一样；还是先只做 Top 200 品牌？
3. **第 1 步的 200 credits** 和第 4 步 20 个商品的验证，可以直接做吗？
