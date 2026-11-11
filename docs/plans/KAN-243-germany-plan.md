# KAN-243 第五个国家：德国亚马逊（amazon.de）计划

2026-11-11。Robert 在 KAN-243 里说（11-09）「下一步可以做日本和欧洲五国的」；英国已经做完，用户说「可以，开始做德国第 1 步吧」。墨西哥的调研留在 `KAN-243-mexico-plan.md`，先不做。

Robert 定的要求：「我们平台用户都是英语用户，所以数据库展示信息都是英文的。」

## 0. 为什么先做德国

- 欧洲最大的站；`country_code=de` 送货地 7/7 + 本次 26/26 在德国（法兰克福、柏林、波恩、纽伦堡等）。
- 页面可以要英文：网址加 `?language=en_GB` 返回 en-gb 页面（链接带 `/-/en/` 前缀），标题是亚马逊翻好的英文。意大利、日本同样有效，西班牙不加参数默认英文；法国这次 HTTP 500，没重试。
- Supply Smart 白名单里已经有 `amazon.de`（DE、EUR）。

## 1. 第 1 步：样本调研（已完成，150 credits，不改代码）

**抓了什么**（30 页，全部 `country_code=de` + `language=en_GB`，逐字节存进 R2 `research/kan243-geo/scraperapi/de/` 并回读校验；副本在 Server 一 `~/kan243-research-geo/scraperapi/de/`，标签原图在 `~/kan243-research-geo/img-de*/`）
- 3 页试英文 + 3 个美国品牌商品页（第一轮）。
- 1 页 Drugstore 畅销榜找类目，2 页 Vitamins, Minerals & Supplements 畅销榜（60 个）。
- 8 个美国品牌的品牌搜索，13 个商品页（取自其中 4 个品牌）。

**类目和品牌搜索**
- 类目：Drugstore > Vitamins, Minerals & Supplements，node `64374031`。
- 搜索分类是 `i=drugstore`（和英国一样），下一页链接保留 `i=drugstore`、node 和品牌 ID，但路径是 `/-/en/s?...`。
- 8 个品牌里 4 个的品牌 ID 在德国生效：Doctor's Best 62、Nordic Naturals 64、Natrol 7、Source Naturals 2；另 4 个（Ancient Nutrition、Sports Research、Vital Proteins、MuscleTech）筛选丢失，按英国、加拿大的做法算作没货（`SCAN_FILTER_LOST`）。

**畅销榜**：前 60 个全是德国本土品牌（natural elements、Sunday Natural、ESN、Doppelherz、WeightWorld），和美国站采过的 ASIN 重合 0 个。抽的 13 个美国品牌商品也是欧洲专用 ASIN，和美国站重合 0 个，所以不能按 ASIN 复用美国的配方。

**页面上的各项（13 个商品页，英文版）**

| 项目 | 结果 | 说明 |
|---|---|---|
| 送货地 | 13/13 在德国 | 「Delivering to Frankfurt 60313」，5 位邮编 |
| 价格 | 11/13（2 个缺货） | `€` + 整数 + 小数（34,29），`.a-offscreen` 为空，和印度一样读整数和小数部分；划线价「€38.10」 |
| Best Sellers Rank | 13/13 | 「14,462 in Health & Personal Care (See Top 100 …)」，不带 #，现有写法能读 |
| Date First Available | 0/13 | 和英国一样没有 |
| 销量徽标 | 3/13 | 「100+ bought」，现有写法能读 |
| 品牌行 | 13/13 | 「Visit the Doctor's BEST Store」「Brand: Natrol」，英文，能读 |
| 链接 | `/-/en/…/dp/<ASIN>` | 解析器取 ASIN、品牌扫描翻页要认 `/-/en/` 前缀 |

**标签（看了 13 个商品 + 3 个德国本土品牌的图库）**

| 标签 | 个数 | 例子 |
|---|---|---|
| 美国原版英文 Supplement Facts | 4 | Source Naturals DMAE、Tribulus；Natrol Acidophilus、Omega-3（美国进口，营销图里有德文） |
| 德文进口标签 | 7 | Doctor's Best 3 个、Nordic Naturals 4 个：「Mehrsprachiges Etikett, leicht abziehbar」（多语种贴纸），DE 一段：表头「Inhaltsstoffe \| Tagesdosis (2 Weichkapseln)」，「Gesamt-Omega-3 1280mg / davon EPA 650mg」，「Zutaten: …」「Verzehrempfehlung: …」，有的带 %NRV（「Zink 16mg 160%」） |
| 没有标签图 | 2 | Natrol CoQ-10 只有 1 张正面图；Doctor's Best 镁全是营销图 |

德国本土品牌（不在我们范围里，但欧洲品牌会是这样）：「Nährstofftabelle」「Nährwertinformationen」，「Inhalt pro Tablette … %NRV」，和英国 NRV 表同构；WeightWorld 的多语种说明书里有一段英国英文版。

字都清楚：德文进口标签是整张白底文字图，1500 px 就能读，我们下载用 2560 px。

## 2. 第 2 步：`amazon-de` 渠道（代码，待用户批准）

和加拿大一样的部分：

| 改什么 | 在哪 | 内容 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-de": { marketplace: "amazon.de", countryCode: "DE", currency: "EUR" }` |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_DE`：价格前缀 `€`，邮编 5 位，node `64374031`，`searchAlias: "drugstore"`，2 页 50 个，按畅销排，图 2560 px；**新字段 `language: "en_GB"`**，商品页和搜索页都带上 |
| 链接 | 取 ASIN、翻页 | 认 `/-/en/` 前缀 |
| 数据库 | 新迁移 075 | 照 074 加 `amazon-de` 到 7 个 channel CHECK，`queue_control` 加一行，默认暂停 |
| 服务器配置 | Server 一两个私有配置 | 照 `amazon-ca` 加 `amazon-de`（`countryCode: "de"`）；四处 ScraperAPI `allowedOrigins` 加 `https://www.amazon.de`；保持 600 |

**新的部分：德文标签 → 英文**（Robert 点名的难点，法、意、西以后共用）

- 新标签格式 `eu-food-supplement/1`：认德文表头（Inhaltsstoffe、Tagesdosis、Inhalt pro …、Nährwertinformationen、Nährstofftabelle、%NRV / NRV*）、「Zutaten:」（配料）、「Verzehrempfehlung:」（用法）。多语种贴纸只读 DE 一段；同一张图上有英文（UK/EN）一段时读英文那段。`amazon.de` 读 `[US_FACTS, "in-nutritional-information/3", "eu-food-supplement/1"]`（中间是英国在用的 %NRV 格式）。
- **翻译放在哪，两个做法，需要你选：**
  - A（推荐）**照抄原文，再单独翻译。** 读图这一步照抄德文（核对规则不变：抄的必须是图上印的），然后用文字模型把成分名、份量、配料翻成英文，推给 Supply Smart 的是英文，德文原文留在证据里。同一个德文词只翻一次，存起来复用。
  - B **读图时直接写英文。** 少一步，但抄出来的字和图上对不上，现有「抄的必须是图上印的」核对会失效，出错不好查。
- 不做：德国本土品牌专用规则（不在我们的公司范围里）。

## 3. 第 3 步：品牌入口

用美国站的品牌 ID 生成 1,269 个 `amazon-de` 品牌入口，扫描后把没货的设为未启用。抽样 8 个大品牌里 4 个有货；按英国（400/1,269）、加拿大（356/1,269）估，德国约 250–400 个品牌有货，扫描约 2,500 credits。

## 4. 第 4 步：验证

先跑 1 个，再跑 20 个，抽查 10 个标签原图（英文、德文各半）和价格、排名、品牌，再放全量。

## 5. 花费

已用约 150 credits（另有墨西哥调研 80）。第 3 步扫描约 2,500，全量每个商品约 5–10，翻译用文字模型。
