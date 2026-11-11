# KAN-243 第四个国家：加拿大亚马逊（amazon.ca）计划

2026-11-11。英国全量快跑完（2,515 完成、550 Review，18%；印度 21%），用户说「review 率不算太高……继续找下一个好做的 channel」。比较之后选加拿大，用户批准：「可以，开始做加拿大吧」。做法和英国一样（`KAN-243-uk-plan.md`）。英国已经把只认 `amazon-in` 的列表改成按站点列表走，加拿大主要是加配置。

## 0. 为什么选加拿大

| 国家 | 送货地 | 语言 | 结论 |
|---|---|---|---|
| 加拿大 | 21/21 商品页在加拿大 | 英文（en-ca） | 最好做 |
| 新加坡、墨西哥 | 套餐不支持 `country_code` sg / mx | 新加坡英文 | 拿不到当地价格 |
| 日本、德国、法国、西班牙 | 在本国 | 当地语言 | 要先解决翻译 |
| 意大利 | 3/8 落到德国 | 意大利语 | 送货地不稳 |
| 澳洲 | 约一半落到南非 | 英文 | 用户 11-10 暂不做 |

Supply Smart 正式环境的站点白名单里已经有 `amazon.ca`，那边不用改。

## 1. 第 1 步：样本调研（已完成，130 credits，不改代码）

**抓了什么**
- 1 页 HPC 畅销榜：用来找类目。
- 2 页 Vitamins, Minerals & Supplements 畅销榜：60 个商品。
- 2 页品牌搜索。
- 21 个商品页：
  - 8 个先测送货地；
  - 13 个取自畅销榜和与美国重合的商品。
  - 另有 1 个 B08WVD2YDB 返回 HTTP 500。按规则没有重试，ScraperAPI 也没有扣费。

全部逐字节存进 R2 `research/kan243-geo/scraperapi/ca/`，并回读校验 SHA-256；副本在 Server 一 `~/kan243-research-geo/scraperapi/ca/`。

**类目和品牌搜索**
- 类目：Health & Personal Care > Vitamins, Minerals & Supplements，node `6369748011`，和美国、英国是同一级。
  - 上一级是 Nutrition & Wellness（6369740011）。
  - 子类目有 Vitamins、Minerals、Herbal、Essential Fatty Acids、Amino Acids、Collagen、Sleep 等。
- 搜索分类是 `i=hpc`，和美国、印度一样，和英国（`drugstore`）不同。
  - Webber Naturals（p_123 336554）一共 219 个结果，第 1 页的下一页链接仍是 `i=hpc`，所以翻页没问题。

**页面上的各项（20 个有效商品页）**

| 项目 | 结果 | 例子 / 说明 |
|---|---|---|
| 送货地 | 21/21 在加拿大 | 「Delivering to Montreal H3H」「Balzac T4B 2T3」「Fort Qu'a... S0G」。邮编有时只印前 3 位，有时印全 6 位 |
| 价格 | 20/20 | 「$7.20 with 15 percent savings」。货币是加元，但前缀也是 `$` |
| Best Sellers Rank | 19/20 | 「#186 in Health & Personal Care」「#6 in Vitamin D Supplements」，写法和美国一样（带 #） |
| Date First Available | 19/20 | 「Jan. 23 2013」「June 3 2014」「Oct. 26 2022」：月份短的写缩写加点，长的写全名，没有逗号 |
| 销量徽标「Nk+ bought」 | 20/20 | |
| 页面配料文字 | 19/20 | 文字里带剂量，例：`Each Tablet Contains: Vitamin D3 1000iu, Non-medicinal Ingredients: Cellulose …` |
| 图库 | 4–37 张 | |

**和美国重合**：畅销榜 60 个里有 7 个（12%）是美国站已经验证过的 ASIN。第一次全站调查时算的是 21%。畅销榜以加拿大本土品牌为主：Webber Naturals、Jamieson、Organika、CanPrev、Jacked Factory、ALLMAX、Ddrops。

**标签版式（看了 7 个商品的图库）**

加拿大卫生部的天然保健品（NPN）标签都是英法双语，主要三种写法：
1. **Medicinal ingredients 清单（5 个）**：「Each tablet contains: Vitamin D3 (cholecalciferol) … 1000 IU (25 mcg)」，加「Non-medicinal ingredients: …」或「Also contains: …」。
   - 例子：Webber Naturals、Jamieson、NOW 加拿大版。
   - CanPrev、Sports Research 用的是新的「Product Facts / Info-produit」框，里面同样是「Medicinal ingredients / Ingrédients médicinaux」，加「(In each softgel)」「Each capsule contains / Chaque capsule contient」。
   - 法文常常紧跟在英文后面，或者印在旁边一栏。
2. **Medicinal Ingredients 表（1 个，Jacked Factory）**：「Serving Size / Portions」「Amount Per Serving / Quantité par portion」「%DV / %VQ」，和美国 Supplement Facts 同构。
3. **Medicinal ingredient 清单加 Nutrition Facts / Valeur nutritive 营养表（1 个，Organika 胶原蛋白粉）**。

## 2. 第 2 步：`amazon-ca` 渠道（代码，待用户批准）

| 改什么 | 在哪 | 说明 |
|---|---|---|
| 站点表 | `v3-contracts/src/amazon-marketplaces.ts` | 加 `"amazon-ca": { marketplace: "amazon.ca", countryCode: "CA", currency: "CAD" }` |
| 站点配置 | `channels/amazon/src/site.ts` | 加 `AMAZON_CA`，详见表下 |
| 送货地检查 | 同英国 | 页面有送货地那一行、但里面没有加拿大邮编，就转 Review（`AMAZON.DELIVERY_ABROAD`） |
| 数据库 | 新迁移 | 照 073 的写法，把 `amazon-ca` 加进 channel CHECK；`queue_control` 加一行，默认暂停 |
| 标签 | `v3-contracts/src/label-formats.ts` | 新版本 `in-composition/3`，详见表下 |
| 品牌源 API | `brands.deriveAmazonSources` / `lookupAmazonSources` | `channel` 多一个可选值 `amazon-ca`，查名存档目录是 `amazon-ca-brand-lookup` |
| 服务器配置 | Server 一 `api.private.json`、`worker.private.json` | 照 `amazon-uk` 各加一份 `amazon-ca`（`countryCode: "ca"`，推送目标正式环境，`marketplace: "amazon.ca"`），文件保持 600 权限。Server 二不用改 |
| 销量估算 | 交付层 | 和印度、英国一样：有徽标用徽标，没有就不估 |

**`AMAZON_CA` 的取值**
- 价格前缀：`$`、`C$`、`CAD`。
- 加拿大邮编：`A1A` 或 `A1A 1A1`。
- 上架日期格式：`MMM. d yyyy`、`MMMM d yyyy`。
- 解析器版本：`amazon-ca-rendered/1`。
- 图库按 2560 px 下载。
- 排序和翻页：按畅销排序，每个品牌读 2 页、最多 50 个商品。
- 类目 `6369748011`，搜索分类 `searchAlias: "hpc"`。

**标签：新版本 `in-composition/3`**

和英国的做法一样：沿用印度的格式出新版本，旧版本 `/2` 不动，印度和英国的回放结果不变。`/3` = `/2` 的全部规则，再加：
- 选图关键词：「Medicinal Ingredients」「Product Facts」。
- 「Each … contains」行的新写法：「(In each softgel)」「Ingredients (each softgel contains):」「Medicinal ingredient – each serving (10 g) contains」。
- 只是标题的行：「Product Facts / Info-produit」「Medicinal ingredients / Ingrédients médicinaux」。
- 「%DV / %VQ」列，新增依据 `ca_dv`。
- 给视觉模型的说明：英法双语标签只抄英文，法文翻译行不抄。

`amazon.ca` 使用 `[US_FACTS, "in-composition/3"]`。Nutrition Facts 营养表和 Supplement Facts 式的表由 US 规则读。「Non-medicinal ingredients」本来就算辅料标题，不用改。

## 3. 第 3 步：找加拿大的品牌源

- 用美国站已有的 p_123 品牌 ID 推出加拿大入口（免费），默认不启用。
- 扫描后只启用有商品的。英国这一步约花 6,800 credits，加拿大估计差不多。
- 按品牌名补查等英国那 930 个查完、看效果后再定。

## 4. 第 4 步：验证

1. 部署后先抓 1 个商品页，核对送货地、价格、排名、上架日期和标签。
2. 20 个商品端到端推正式环境，抽查 10 个的剂量和标签图。
3. 通过后全量。

## 5. 成本和时间

- **credits**：
  - 第 1 步 130（已花）；
  - 品牌扫描约 7,000；
  - 商品页按英国的量（约 3,100 个）约 15,000。
- **时间**：
  - 第 2 步约半天到 1 天；
  - 第 3、4 步约半天；
  - 全量约 1 天。
- **前提**：Server 一 磁盘只剩 11G，全量前要清理（删除由用户执行）。
