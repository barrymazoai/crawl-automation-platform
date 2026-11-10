# KAN-243 第三个国家：英国亚马逊（amazon.co.uk）计划

2026-11-10，用户已批准（「那就开始先做UUK吧」，三个问题见第 6 节的决定）。11-10 实测日本和欧洲五国的送货地之后，用户说「我们做哪个国家最好做的？开始」。英国最容易：英文站、不用翻译、送货地 8/8 都在英国。澳洲计划（`KAN-243-australia-plan.md`）因为送货地有一半落到南非，暂停，等 ScraperAPI 那边的答复。印度的做法见 `KAN-243-india-research.md`。

## 0. 为什么先做英国（11-10 实测）

- **送货地**：带 `country_code=uk` 的请求，英国商品页 26/26 都送到英国（伦敦、埃克塞特等），而且都有价格。
  - 对比：意大利 3/8 落到德国，澳洲约一半落到南非。
  - ScraperAPI 在通用网站上不给英国 IP（套餐只有 us 和 eu），但请求亚马逊时是正常的。
- **语言**：页面是英文（en-gb），不需要加语言参数。西班牙、意大利要加 `?language=`。
- **Supply Smart 不用改**：正式环境的站点白名单里已经有 `amazon.co.uk`（supply-smart-mono main 的 `packages/database-api/src/lib/marketplace.ts`），还有 de、fr、it、es、ca。
- **和美国的重合少**：英国保健品畅销榜前 60 个里，只有 3 个是我们美国站已采过的 ASIN（澳洲是 41%）。英国本土品牌为主：Vitabiotics、Nutrition Geeks、Zipvit、BetterYou、Bulk、Natures Aid。

## 1. 第 1 步：英国样本调研（已完成，105 credits，不改代码）

- **抓了什么**：
  - 畅销榜 2 页，node 2826484031（Health & Personal Care > Vitamins, Minerals & Supplements），共 60 个商品。另抓了 1 页上一级类目页，用来找这个 node。
  - 商品页 26 个：榜单前 18 个，加上和美国同 ASIN 的 3 个，再加上前面测送货地时抓的 8 个，其中 3 个和前两类重合。
  - 全部逐字节存进 R2 `research/kan243-geo/scraperapi/uk/`，回读校验 SHA-256；副本在 Server 一 `~/kan243-research-geo/`。
- **子类目**：Vitamins、Minerals、Herbal Supplements、Collagen、Essential Fatty Acids、Amino Acids 等 22 个。运动营养（creatine 在这个榜里也有）是否另有上级类目，第 2 步定 node 时再核实。
- **现有解析器（套印度设置，改成 GBP、£、英国邮编）在 26 页上的表现**：
  - 读对的：标题、价格（26/26，取 priceToPay，原价进 listPrice）、送货邮编（E17 7QZ、SW1A、WD3 等）、图库（5–12 张）、规格（0–14 个）。
  - 页面上有 Best Sellers Rank（例：`51 in Health & Personal Care … 2 in Iron`），写法和美国一样。
  - 页面上有「100K+ bought」销量徽标（印度看不到）。
  - **没有 Date First Available**：26 页都没有这一行。这是网站本身不给，字段留空即可。
- **页面文字里就有配料（25/26）**：Important information 下的 Ingredients 一栏，是完整配料表，例：`Bulking Agents (Microcrystalline Cellulose & Pregelatinised Starch), Vitamin D3 …`。剂量一般不在文字里。
- **标签版式（看了 8 个商品的图库）**：
  - 英国 / 欧盟的「Nutritional Information」表，列是每份含量加 %NRV：7 个。
    - 例：Vitabiotics `Av. per Tablet | %NRV`，Nutrition Geeks `Per Daily Intake (Two Capsules) | %NRV`，Zipvit `Per Serving | %NRV`，BetterYou `Each daily dose (3 sprays) contains`，Optimum Nutrition `Typical Values | Per 3.4 g`。
    - Pregnacare 是两张表（片剂、胶囊各一张），字很密。
  - 只有包装背面小图、字太小：1 个（Bulk 肌酸）。
  - 美国 Supplement Facts：这 8 个里没有。
- **结论**：
  - 英国的表和印度的「Nutritional Information」同构，只是百分比列叫 %NRV（印度是 %RDA），每份含量的列名写法也更多。
  - 用户 11-10 定：和印度用同一个格式。做法是印度格式出一个新版本 `in-nutritional-information/3`（格式的规则改动只能出新版本，不能改旧版本）：`/2` 的全部规则，加上 %NRV 列、`Av. per Tablet`、`Per Daily Intake (…)`、`Each daily dose … contains` 这些列名和 NRV 脚注。英国用 `/3`；印度先留在 `/2`，所以印度回放结果不变。
  - 图库按 2560 px 下载（和印度一样），Bulk 这类背面小字才有机会读出来。

## 2. 第 2 步：`amazon-uk` 渠道（代码）

和澳洲计划第 3 节同一套改法。哪个国家先做，就由它先把「只认 `amazon-in`」的列表改成按站点列表走；后做的国家只加配置。

| 改什么 | 在哪 | 说明 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-uk": { marketplace: "amazon.co.uk", origin, countryCode: "GB", currency: "GBP" }` |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_UK`：hosts、价格前缀 `£`、英国邮编、按畅销排序、每个品牌读 2 页、node 2826484031、图库 2560 px。上架日期格式先配 `d MMMM yyyy`，页面上没有就留空 |
| 送货地检查 | 解析层 `parseAmazonProduct` | 非美国站点的页面有送货地那一行、但里面没有本站邮编时，转 Review（`AMAZON.DELIVERY_ABROAD`），不重试。英国 26/26、印度 2,642/2,645 都有本站邮编；印度另外 3 页没有送货地那一行，照旧读。美国站不检查。用户以后批准「重新请求」的例外时，澳洲、意大利共用这个检查 |
| 数据库 | 新迁移 `07x_amazon_uk_channel.sql` | 照 071 的写法，把 `amazon-uk` 加进 6 张表的 channel CHECK；`queue_control` 加一行，默认暂停 |
| 渠道列表 | 同澳洲计划第 3 节列的约 24 个文件 | 写死 `"amazon-in"` 的列表改成从 `AMAZON_CHANNELS` 推出来 |
| 推送目标 | `brand-enrichment-settings.ts`、`product-sync-parts.ts` | 任何非美国站点都能配目标；英国指向正式环境，带 `marketplace: "amazon.co.uk"` |
| 标签 | `v3-contracts/src/label-formats.ts` | `amazon.co.uk` 用 `[US_FACTS, "in-nutritional-information/3", "in-composition/2"]`；`DailyValueBasis` 加 `eu_nrv`。非美国格式自动走印度的标签规则集（`market-rules.ts` 不用改）。美国、印度的格式列表不动，回放结果逐字节相同 |
| 品牌源 API | `brands.deriveAmazonSources` / `brands.lookupAmazonSources` | 原来的 `deriveAmazonInSources` / `lookupAmazonInSources` 改名，多一个必填的 `channel`（`amazon-in` 或 `amazon-uk`）。印度的查名存档目录名不变（`amazon-in-brand-lookup`），英国是 `amazon-uk-brand-lookup` |
| 服务器配置 | Server 一 `api.private.json`、`worker.private.json` | 照 `amazon-in` 各加一份 `amazon-uk`：抓取和品牌扫描的 `countryCode: "uk"`、pipeline 和 delivery 的路由、productSync 的 channels 和 targets（正式环境）。Server 二不用改 |
| 销量估算 | 交付层 | 和印度一样：有徽标就用徽标，没有就不估（美国 BSR 曲线不套到英国） |

## 3. 第 3 步：找英国的品牌源

复用印度的两个办法，改成带 `channel` 参数：
- **按品牌 ID 推出来**：用美国站的 p_123 品牌 ID 生成英国的品牌入口。免费。
- **按品牌名查**：在英国保健品类目里按品牌名搜。每个品牌 1 页，5 credits。

推出来或查到的来源默认不启用。扫一遍之后，有商品的才启用。

## 4. 第 4 步：验证（先 1 个请求，再放量）

1. 部署后先抓 1 个商品页，核对送货地、价格和标签。
2. 20 个商品端到端推正式环境。抽查 10 个商品的剂量和标签图，Review 率目标 < 10%。
3. 通过后再全量：按品牌名查一遍我们全部公司的品牌，再扫有商品的品牌，最后采商品。

## 5. 成本和时间

- **credits**：
  - 第 1 步 105（已花）；
  - 按品牌名全量查一遍约 11,000；
  - 品牌扫描和商品页约 3 万到 5 万，按查名结果再报准确数字。
- **时间**：
  - 第 2 步约 1.5 天（大部分是改渠道列表和测试，澳洲以后可直接复用）；
  - 第 3、4 步约 1 天；
  - 全量采集约 1 天。

## 6. 用户的决定（11-10）

1. **标签格式**：「如果他们很像的话，就用一样的」→ 用印度的格式（新版本 `/3`，见第 1 节结论）。
2. **图库里没有成分表时**：用页面上的配料文字收成「只有配料」的商品。
3. **第一期范围**：按我们库里全部公司的品牌查，「先把英国的公司找到」。
