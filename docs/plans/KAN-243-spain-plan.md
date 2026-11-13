# KAN-243 第六个国家：西班牙亚马逊（amazon.es）计划

2026-11-13。德国跑完后用户说「继续做下面一个 channel」。Robert 在 KAN-243 里要的是「日本和欧洲五国」：英国、德国已做完，剩法国、意大利、西班牙、日本。

## 0. 为什么是西班牙，不是法国

- **法国做不了英文页。** amazon.fr 顶部语言菜单只有 FR；`?language=en_GB` 返回 HTTP 500（标准、premium 都是，不扣额度），`en_US` 和 `/-/en/` 前缀照样是法文页（`lang="fr-fr"`）。做法国要先让解析器读法文页面（可售状态、品牌行、排名、卖家等），和停下的墨西哥是同一件事。
- **西班牙页面是英文。** `?language=en_GB` 返回 `lang="en-gb"`，标题、品牌行、排名都是英文，和德国一样。
- **送货地 22/23 在西班牙**（马德里、马拉加、巴达霍斯、伊列斯卡斯等，5 位邮编）；1 页搜索页写 "Deliver to United Kingdom"，搜索页不读送货地，不影响。
- **标签和德国是同一批货。** 欧洲进口商给美国瓶子贴的多语种贴纸同时印 DE/ES/FR/IT（有的还有 UK）段，德国做好的标签格式和德文翻译可以原样用。
- Supply Smart 正式环境白名单里已有 `amazon.es`（见英国计划 §0），不用改。

## 1. 第 1 步：样本调研（已完成，125 credits，不改代码）

所有页面都用 `country_code`、`premium=true` 抓取，逐字节存进 R2 `research/kan243-geo/scraperapi/{fr,es}/` 并回读校验；副本在 Server 一 `~/kan243-research-geo/scraperapi/{fr,es}/`，西班牙图库在 `~/kan243-research-geo/img-es/`。

- 法国 5 页（2 页成功，均为法文；3 页 500 不计费）。
- 西班牙 23 页：3 页试英文和健康类畅销榜，2 页保健品畅销榜，8 个品牌搜索第 1 页加 Doctor's Best 第 2 页，9 个商品页。

**类目和品牌搜索**
- 类目：Health & Household > Vitamins, Minerals & Supplements，node `4347039031`；搜索分类 `i=hpc`。
- 第 2 页：Doctor's Best 下一页链接是 `/-/en/s?...i=hpc&rh=n:4347039031,p_123:576086...&page=2`，25 个商品，品牌仍勾选，正常。
- 8 个美国品牌用美国站品牌 ID 搜，**6 个保住品牌筛选**（德国是 4 个）：

| 品牌 | 第 1 页商品 | 德国已采过的同一 ASIN |
|---|---|---|
| Doctor's Best | 24（有第 2 页） | 17 |
| Nordic Naturals | 24（有第 2 页） | 16 |
| Natrol | 10 | 1 |
| Ancient Nutrition | 3 | 0 |
| MuscleTech | 1 | 0 |
| Source Naturals | 1 | 1 |
| Sports Research、Vital Proteins | 筛选丢失（"No results for"） | — |

  进口品牌在欧洲用同一个 ASIN 卖：Doctor's Best、Nordic Naturals 第 1 页 48 个里 33 个德国已经采完。

**页面上的各项（9 个商品页，英文版）**

| 项目 | 结果 | 说明 |
|---|---|---|
| 送货地 | 9/9 在西班牙 | 「Delivering to Madrid 28071」，5 位邮编，和德国一样 |
| 价格 | 9/9 | `€` + 整数 + 小数，和德国一样 |
| Best Sellers Rank | 9/9 | 「4,109 in Health & Household (See Top 100 …)」，不带 #，现有写法能读 |
| Date First Available | 8/9 | 「2 Dec. 2021」「13 July 2021」「9 Jun. 2023」「9 Sept. 2016」：日在前，月份缩写带点或全拼 |
| 销量徽标 | 2/9 | 「100+ bought in past month」，现有写法能读 |
| 品牌行、可售状态 | 9/9 | 「Visit the Doctor's BEST Store」「Brand: Natrol」「In stock」「Only 3 left in stock.」，英文 |

**标签（7 个德国没采过的商品）**

| 标签 | 个数 | 例子 |
|---|---|---|
| 美国原版英文 Supplement Facts | 2 | Natrol Melatonin、MuscleTech Glutamine（营销图是西班牙文） |
| 多语种贴纸，含 UK 英文段 | 2 | Doctor's Best Glucosamine（DE/ES/FR/IT/UK）、Nordic Naturals Marine Collagen（ES/DE/FR/IT/UK） |
| 多语种贴纸，无英文段 | 1 | Doctor's Best Magnesium（ES/FR/DE/IT），有 DE 段 |
| 没有标签图 | 2 | Ancient Nutrition（全是西班牙文营销图）、Natrol Biotin（只有 1 张正面图） |

德国现有格式的规则正好覆盖：「有英文段抄英文段，否则只抄 DE 段」，德文再翻成英文。这 7 个里没有只印西班牙文的标签。

## 2. 第 2 步：`amazon-es` 渠道（代码，待用户批准）

照德国做，不新做西班牙文：

| 改什么 | 在哪 | 内容 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-es": { marketplace: "amazon.es", origin, countryCode: "ES", currency: "EUR" }`；标签语言 `"amazon-es": "de"`（抄的是 DE 段，翻译沿用德文） |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_ES`：`€`，5 位邮编，node `4347039031`，`searchAlias: "hpc"`，`language: "en_GB"`，2 页 50 个，按畅销排，图 2560 px；日期 `["d MMM. yyyy", "d MMMM yyyy"]` |
| 标签格式 | `v3-contracts/src/label-formats.ts` | `amazon.es` 用德国同一组：`[US_FACTS, "in-nutritional-information/3", "eu-food-supplement/1"]`，格式本身不改，美、印、英、加、德回放不变 |
| 数据库 | 新迁移 077 | 照 075 把 `amazon-es` 加进 channel CHECK，`queue_control` 加一行，默认暂停 |
| 服务器配置 | Server 一私有配置 | 照 `amazon-de` 加 `amazon-es`（抓取 `countryCode: "es"`、`premium: true`）；四处 ScraperAPI `allowedOrigins` 加 `https://www.amazon.es`；保持 600 |

**要你选的一件事：西班牙要不要直接用德国已经读好的配方？**

现在每个国家站各算各的配方（`formulaFamily` = `amazon-de-asin`），同一个 ASIN 在西班牙会重新读一遍标签。

- A（推荐）**德国、西班牙合成一个欧洲配方组**（`amazon-eu-asin`）。欧洲同一个 ASIN 是同一瓶货、同一张多语种贴纸；德国已完成的 ASIN 在西班牙只抓页面（价格、排名、销量），不再读图，也不用再翻译。样本里 Doctor's Best、Nordic Naturals 约 70% 能直接复用，以后做法国、意大利也一样加进这个组。
- B 不合并，西班牙全部重新读图。

**已知不做的**
- 只印西班牙文的标签（样本里没有）：读不出来时进 Review，等真碰到了再看要不要加西班牙文表头和翻译。
- 「Sept.」这种写法 date-fns 认不了，9 月的首次上架日期会是空（这是可选字段，空着不影响收录）。

## 3. 第 3 步：品牌入口

用美国站品牌 ID 生成 1,269 个 `amazon-es` 品牌入口，扫描后把没货的设为未启用。样本 8 个里 6 个有货，比德国（4/8）好；按德国 217 个品牌有货估，西班牙约 250–400 个，扫描约 1,600–2,500 credits。

## 4. 第 4 步：先 1 个，再 20 个，抽查 10 个

和德国一样：1 个商品跑通 → 20 个 → 抽 10 个对照原图检查标签和英文翻译 → 用户同意后全量放开。

## 5. 第 4 步第一个结果：标签要读西班牙文（用户 11-13「可以，加西班牙文」）

- 部署 c15ab907 后跑的第一个商品 B09BVM4YKB 是 `SCRAPERAPI.PROVIDER_FAILURE`（500，56 秒，不计费）；第二个 B09BVX2XS7（Doctor's Best 镁，贴纸 ES/FR/DE/IT，没有 UK 段）进了 Review：读图抄的是放大印出的西班牙文段（「Ingredientes | Dosis (2 comprimidos) | %VRN*」），表头规则不认「Ingredientes:」。
- §0、§1 里「抄 DE 段、沿用德文翻译」的假设不成立：西班牙站图库里放大的是 ES 段，DE 段只是小图。
- 改法（只影响 amazon.es）：
  - 新格式 `es-food-supplement/1`：选图词 Ingredientes、Dosis diaria、Modo de empleo、Complemento alimenticio、VRN、NRV；「Dosis (…)」「Dosis diaria (…)」「Por …」是剂量列，「%VRN*」「%NRV*」是百分比列；「Modo de empleo: …」「Recomendación de consumo: …」是份量；脚注「*= Porcentaje de los valores de referencia…」「** = Necesidad diaria no determinada」跳过。抄图提示：西班牙文照抄不翻译；有英文段抄英文段，否则只抄 ES 段。`amazon.es` 读 `[US_FACTS, "in-nutritional-information/3", "es-food-supplement/1"]`。
  - 配料表头：用西班牙格式读的标签认「Ingredientes」「Otros ingredientes」「Lista de ingredientes」「Componentes」，不认带 Dosis/VRN/NRV 的表格表头行。
  - 翻译：`amazon-es` 的标签语言是 `es`，翻译提示用西班牙文的常见词；德文提示一字不变。
- 回放：Server 一 保存的 1,076 个读图答案（美国 117、印度 150、英国 150、加拿大 150、德国 509）用 c15ab907 和新代码各解码一遍，1,076 个结果逐条相同。读图配置指纹不变（4 个指纹测试在 c15ab907 上本来就不过，哈希相同）。
