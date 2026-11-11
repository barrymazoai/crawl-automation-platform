# KAN-243 第五个国家：墨西哥亚马逊（amazon.com.mx）计划

2026-11-11。加拿大全量快跑完（11:35 UTC：2,210 完成、386 Review，15%），用户说「那我们开始做下一 Channel，找一个好做的 channel 先做着」。比较之后选墨西哥。做法和加拿大一样（`KAN-243-canada-plan.md`）。

## 0. 为什么选墨西哥

| 国家 | 送货地 | 页面语言 | 我们的品牌在卖 | 与美国同 ASIN | 结论 |
|---|---|---|---|---|---|
| 墨西哥 | 不带 `country_code` 也 4/4 送到墨西哥城（另 3 页 Tuxtla / 墨西哥城） | 西语（es-mx），英文切换无效 | 17/20（最多） | 39% | **选它** |
| 新加坡 | 不带 `country_code` 4/4 落到美国、西班牙、斯洛伐克、拉脱维亚；带了套餐不支持 | 英文 | 12/20 | 49% | 送货地拿不到，不做 |
| 日本 | 8/8 在日本 | 日语 | 13/20 | 35% | 语言更难，排在墨西哥后面 |
| 德国、法国、西班牙 | 在本国 | 当地语言（西班牙默认给机翻英文） | 8–12/20 | ≤9% | 我们的品牌少 |
| 意大利 | 3/8 落到德国 | 意大利语 | 3/20 | | 送货地不稳 |
| 澳洲 | 约一半落到南非 | 英文 | | | 用户 11-10 暂不做 |

- Supply Smart 正式环境的站点白名单（supply-smart-mono main `packages/database-api/src/lib/marketplace.ts`）里已经有 `amazon.com.mx`（MX、MXN），那边不用改。
- 我们抓的是自己数据库里公司的品牌，墨西哥站上这些大多是美国进口货，图库里是美国原版英文 Supplement Facts，现有美国标签格式就能读。

## 1. 第 1 步：样本调研（已完成，80 credits，不改代码）

**抓了什么**（16 页，全部不带 `country_code`，逐字节存进 R2 `research/kan243-geo/scraperapi/mx/` 并回读校验 SHA-256；副本在 Server 一 `~/kan243-research-geo/scraperapi/mx/`）
- 4 个商品页测送货地，另 4 个新加坡商品页做对照。
- 1 页 HPC 畅销榜找类目，2 页 Vitaminas y Suplementos 畅销榜（60 个商品）。
- Nature's Truth 品牌搜索 2 页。
- 3 页试英文：`?language=en_US` 和 `lc-acbmx=en_US` cookie 都无效，仍是 es-mx。

脚本：`sa-geo-nocc.cjs`（`sa-geo.cjs` 的副本，`NO_CC=1` 时不带 `country_code`）、`sa-geo-cookie.cjs`（试 cookie 用）。

**类目和品牌搜索**
- 类目：Salud y Cuidado Personal > Vitaminas y Suplementos，node `9845682011`。
- 搜索分类 `i=hpc`，和美国、加拿大一样。Nature's Truth（p_123 477259）93 个结果，第 1、2 页各 24 个，下一页链接保留 `i=hpc`、node 和品牌 ID。品牌筛选生效：筛选项的结构和加拿大一样（复选框勾选），只是文字是西语（「Quitar Nature's Truth filtro」），品牌扫描的筛选检查不用改。

**畅销榜**：前 60 个只有 3 个是美国站采过的 ASIN（Natrol、Nordic Naturals、NOW），其余是墨西哥本土品牌（B Life、Birdman、Beyond Vitamins、Seltz），本土品牌的标签是西语，不在我们的品牌范围里。

**页面上的各项（5 个商品页）**

| 项目 | 墨西哥写法 | 现在的解析器 |
|---|---|---|
| 送货地 | 「Entrega en Mexico City 11000」，5 位邮编 | 只认邮编，能用 |
| 价格 | `$229.00`（比索，`.` 小数点），priceToPay 的 `.a-offscreen` 为空，读整数部分 | 和印度一样，能用 |
| 有货 | 「Disponible」「Sólo queda(n) 7 en stock.」；缺货应为「No disponible por el momento」 | 只认 `unavailable / out of stock`，**要加** |
| 品牌 | 「Marca: Host Defense」，也可能是「Visita la tienda de X」 | 只认 `Brand:` / `Visit the X Store`，**要加** |
| Best Sellers Rank | 详情表「Clasificación en los más vendidos de Amazon」：「nº15,285 en Salud y Cuidado Personal … nº827 en Suplementos Herbales」 | 只认 `Best Sellers Rank` 和 `#… in …`，**要加** |
| Date First Available | 5 页都没有 | 留空（本来也只给美国用） |
| 销量徽标 | 5 页都没有 | 没有就不估（和英国一样） |
| 卖家 | 「Envío desde」「Vendido por」「Remitente / Vendedor」 | 只认英文，**要加** |
| 页面配料文字 | 「Ingredientes …」，西语机翻 | 只认 `Other Ingredients`，**要加**「Otros ingredientes」 |
| 人机验证页 | 未遇到 | 品牌扫描只认「Continue shopping」，**加西语写法** |
| 标题 | 西语机翻（「Vitamina D3 \| 100 cápsulas」） | 照原样存 |

## 2. 第 2 步：`amazon-mx` 渠道（代码，待用户批准）

和加拿大一样的部分：

| 改什么 | 在哪 | 内容 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-mx": { marketplace: "amazon.com.mx", countryCode: "MX", currency: "MXN" }` |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_MX`：价格前缀 `$`/`MXN`，邮编 5 位，node `9845682011`，`i=hpc`，2 页 50 个，按畅销排，图 2560 px |
| 数据库 | 新迁移 075 | 照 074 把 `amazon-mx` 加进 7 个 channel CHECK，`queue_control` 加一行，默认暂停 |
| 标签格式 | `label-formats.ts` | `amazon.com.mx` 读 `[US_FACTS]`；西语本土标签（Información nutrimental）这次不做 |
| 服务器配置 | Server 一 `api.private.json`、`worker.private.json` | 照 `amazon-ca` 加一份，**不带 `countryCode`**（套餐不支持 mx）；四处 ScraperAPI `allowedOrigins` 加 `https://www.amazon.com.mx`；文件保持 600 |

新的部分：**站点文字表**。`AmazonSite` 加一组页面文字（有货/缺货、品牌行、排名标签和「nº … en」、卖家标签、其他配料、人机验证页），美国、印度、英国、加拿大填现在的英文，墨西哥填西语。解析器改成读这张表，不再写死英文。以后做西班牙、日本、德国也是填这张表。每条文字配墨西哥真实页面的测试。

送货地检查：页面送货地不在墨西哥（邮编不是 5 位或写着别国）时转 Review，和其他国家一样。不带 `country_code` 时 7/7 页落在墨西哥，靠的是亚马逊对境外访客的默认城市；全量时如有落到别国的，会以 Review 出现，不会当成下架。

## 3. 第 3 步：品牌入口

和英国、加拿大一样，用美国站的品牌 ID 生成 1,269 个 `amazon-mx` 品牌入口，扫描后把没货的设为未启用。抽样 17/20 有货，预计有货品牌比加拿大（356）多，扫描约 2,500–3,000 credits。

## 4. 第 4 步：验证

先跑 1 个，再跑 20 个，抽查 10 个标签原图和价格、排名、品牌，再放全量。

## 5. 花费

已用 80 credits。第 3 步扫描约 2,500–3,000，全量每个商品约 5–10。
