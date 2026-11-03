# KAN-243 多国亚马逊：印度（amazon.in）设计

2026-11-03。只是设计，没有改生产代码。工单 KAN-243（12 国亚马逊保健品）；Robert 11-01 定先做印度；11-02 会议定 Supply Smart 产品页加「售卖国家」筛选，避免多国合并后产品太多。

依据：仓库代码（`packages/channels/amazon`、`packages/platform/src/fetch/scraperapi-*`、`packages/app/src/product-sync`、`database/v3`）+ 11-03 用 Ego Lite 手动看的 5 个 amazon.in 页面（下表）。没有用 ScraperAPI，没花钱。页面原件没进 git（测试数据不入库）。

| # | 页面 | 看什么 |
|---|---|---|
| 1 | `/gp/bestsellers/hpc/` | 根类目叫 **Health & Personal Care**，保健品在子类目 **Diet & Nutrition**（节点 `1374489031`） |
| 2 | `/gp/bestsellers/hpc/1374489031/` | 前 30 名：蛋白粉、肌酸、Ayurveda（Isabgol、Chyawanprash）、奶粉（Lactogen、PediaSure、Ensure）、普通补剂混在一起；印度本土品牌占大多数 |
| 3 | `/dp/B08CZ916RD`（Carbamide Forte 镁，印度品牌） | 价格、M.R.P.、销量徽标、BSR、上架日期、GTIN、包装图 |
| 4 | `/s?k=NOW+Foods` | 品牌筛选 `rh=p_123:231615`、48 条/页、最多 7 页 |
| 5 | `/dp/B0019LWV92`（NOW Glutathione，美国进口） | 和 amazon.com **同一个 ASIN**，页面写 "labelled to United States standards"，第三方进口商卖 |

---

## 1. 美国链路哪些能直接用

逐项对照 `packages/channels/amazon/src` 和两个真实商品页。

| 环节 | 美国现状（文件） | amazon.in 实测 | 结论 |
|---|---|---|---|
| 页面结构 / 选择器 | `#productTitle`、`#corePriceDisplay_desktop_feature_div`、`#buybox`、`#detailBullets_feature_div`、`#prodDetails`、`#important-information`、`#wayfinding-breadcrumbs_feature_div` | 全部同名存在 | **直接用** |
| 图片 | `images.ts`：`colorImages` 脚本里的 `hiRes`，CDN `m.media-amazon.com` | 同一 CDN、同一结构（B08CZ916RD 8 张 hiRes） | **直接用**，`AMAZON_FILE_ORIGINS` 不用改 |
| 变体家族 | `family.ts`（twister 脚本） | 有 twister；Carbamide Forte 用 "Size" + "Set name" 两维，"Set name" 下其实是不同配方（甘氨酸镁 / 苏糖酸镁 / 柠檬酸镁） | 解析能用。配方复用本来就要过 `sibling-label-check`，不同配方不会被误复用；第一期抽查确认 |
| 价格数字 | `commerce-prices.ts` `priceText()` | `.a-offscreen` 为空，走 symbol+whole+fraction 能拼出 `₹650.00` | `priceText` 能用 |
| 价格解析 | `amount()` 只认 `$` / `USD`；`commerce.ts` 写死 `currency: "USD"` | `₹650.00`、`₹1,075`、`M.R.P.: ₹1,075.00` | **要改**：按站点给货币符号（`₹`/`INR`）和币种 `INR` |
| 划线价 | `listPrice`（strike / basisPrice） | 印度的划线价是 **M.R.P.**（法定最高零售价，含税） | 选择器能用；语义要标成 MRP（见 §3） |
| 评分 / 评论数 | `rating()`、`reviewCount()` | "4.2 out of 5 stars"、"9,556 Reviews" | **直接用** |
| 销量徽标 | `commerce-sales.ts`，`#socialProofingAsinFaceout_feature_div`，正则 `X+ bought in past month` | "10K+ bought in past month"、"200+ bought in past month" | **直接用**，写法完全一样 |
| BSR | `sales-rank.ts`，认 `(See Top 100 in <类目>)` | "#139 in Health & Personal Care (See Top 100 in Health & Personal Care) #1 in Magnesium" | **解析直接用**。根类目是 Health & Personal Care |
| 月销量估算 | `v3-contracts/src/amazon-sales-estimate.ts`，曲线是美国标定的，类目系数表里没有 Health & Personal Care | — | 不用改代码：没有系数的类目自动走 `floor`（25）；有徽标的照用徽标。**美国曲线不能套印度**，要估就得单独标定（以后再说） |
| 上架日期 | `listing-date.ts` 只认 `MMMM d, yyyy`（en-US） | "30 June 2020"、"7 August 2012"（`d MMMM yyyy`） | **要改**：加 `d MMMM yyyy` 格式，否则全是 null |
| 配送地 / 邮编 | `commerce-purchase.ts` 取 5 位邮编 `\d{5}`；`delivery.countryCode` 恒 null | "Delivering to Mumbai 400001"（印度 PIN 6 位） | **要改**：按站点认 6 位 PIN，`countryCode: "IN"`。印度 MRP 含税、全国统一，不需要像美国那样固定邮编 |
| 立即购买判断 | `nativePurchase()` 用 `https://www.amazon.com` 作 base 解析相对 formaction | formaction 是相对路径 `/cart/add-to-cart/...` | 现在碰巧能过；改成按站点 origin 解析 |
| 卖家 / 发货 | `commerce-seller.ts` | "Sold by Amazon Retail / Ships from Amazon"；"Sold by USA Supplements Direct / Delivered by Amazon" | 选择器能用；Whole Foods 自提那段（`otherOffer`）印度不会出现 |
| 文字成分 | `facts.ts`：`#important-information` 下 Ingredients 段；"完整" 必须出现 `Supplement Facts` | B08CZ916RD 只有 "Ingredients: Magnesium"；B0019LWV92 只有 "Ingredients: Glutathione" | 解析能用；印度页面几乎不会"文字完整"，基本都走图片 OCR（和美国大部分商品一样） |
| 标签图片 + OCR + 视觉模型 | Windows OCR → Server 一 Codex 视觉/文字 | 包装图是英文；印度本土标签标题常是 **"Nutritional Information (Approx. values)" / "%RDA"**，不是 "Supplement Facts / %Daily Value" | OCR 和模型流程能用。风险：`label-vision.ts` 的 `retainDailyValueHeading` 只认 "% Daily Value"，"%RDA" 列要确认会被当作每日值而不是第二个剂量列；"Eq. to elemental magnesium 440 mg" 是等量换算，提示词已要求不取等量值。第一期抽 30 个看 |
| 非保健品类目拦截 | `adapter.ts` `nonSupplementCategories`（美国类目名） | 印度类目树不同：Bath & Shower、Skin Care、Personal Care、Household Supplies、Oral Care、Home Medical Supplies & Equipment、Personal Care & Health Appliances、Tools & Accessories；食品叫 "Grocery & Gourmet Foods" | **要另配一份印度表**（名字逐个用面包屑核对） |
| 验证页 | `access-challenge.ts`（captcha / checkpoint / Robot Check），升级一次到 ultra premium | 本次没遇到 | 标记相同（同一套前端），照用；第一期看实际遇到率 |
| 品牌扫描 | `brand-scan-address.ts`：只认 `amazon.com` 的 `/s?rh=p_123:…`，7 页上限，`s=date-desc-rank` | `rh=p_123:231615`（NOW Foods）、48 条/页、分页显示到 7 | **逻辑直接用**，origin 按站点；Store 页（`/stores/`）照旧走浏览器 |
| ScraperAPI | `scraperapi-settings.ts`：`countryCode` 默认 `us`，按渠道配；`allowedOrigins` 私有配置 | — | 加渠道配置 `countryCode: "in"`，`allowedOrigins` 加 `https://www.amazon.in`。**未确认**：我们的 ScraperAPI 套餐能不能用 `in` 地区（ScraperAPI 文档写 us/eu 以外的国家要 Business 及以上）；上线前用 1 个请求确认，不行就先不带 `country_code`，看页面是否仍是印度价格 |
| 每页 credits | 美国 Amazon 5 credits/页（09-15 实测） | 未测 | 预计相同（ScraperAPI 按域名类型计价），第一期按收据里的 `sa-credit-cost` 核对 |
| GTIN | 美国 adapter 不读 GTIN；`marketplace-attributes.ts` 能透传 gtin | 详情表有 "Global Trade Identification Number 08906081920485"（890 = 印度 GS1）；进口品还有 "UPC 733739001047" | **新加**：读这两行，跨国合并的主键之一（§3） |
| 产地 / 进口商 | 美国不读 | 每个商品都有 Country of Origin、Manufacturer、Packer、Importer（印度法规强制） | 新加，放 `attrsRaw`，用来判断"进口品"和卖家结构 |

不确定、需要第一期验证的：ScraperAPI 印度地区是否可用及单价；验证页遇到率；`%RDA` 标签的模型表现；Ayurveda 产品标签能不能被读成配方。

---

## 2. 印度特有的问题

**标签语言。** 5 个页面上没有一个天城文（Devanagari）字符；Carbamide Forte 6 张图全是英文，营养表也是英文。印度法规允许英文或印地文，补剂几乎都是英文。可能出现印地文的是 Ayurveda 类（Baidyanath、Dabur），但成分名一般用拉丁字母写（Ashwagandha、Guduchi、Shilajit）。Windows OCR 是英文模型，遇到天城文段只会是乱码；视觉模型能读。第一期统计"标签有天城文"的比例，超过 5% 再处理。

**FSSAI 标识。** 页面文字里没有 FSSAI 号（两个商品都没有），只在包装图上（绿色 FSSAI 标 + 14 位许可证号；还有素食绿点）。Ayurveda 产品是 AYUSH 许可（"Mfg. Lic. No."），不是 FSSAI。第一期不抓 FSSAI 号；以后要的话让视觉模型顺带读出来，作为可选字段。标签上的 "NOT FOR MEDICINAL USE"、"Nutraceutical / Health Supplement" 类别字样同理。

**价格含税。** 印度标价和 M.R.P. 都含 GST（页面写 "Inclusive of all taxes"），全国统一；美国价格不含销售税。交付时必须标明（§3），否则跨国比价会错。另有 "₹5.42 per count" 单价，不取。

**规格写法。** "120 count (Pack of 1)"、"Net Quantity: 120.0 Count"、"1 kg (2.2lbs)"、"Item Weight 90 Grams"，公制为主。现有补齐步骤（健康功能 / 剂型 / 规格）是文字模型从标题和要点里抽，写法不同不影响；`Net Quantity` 行可以直接作为规格证据。

**卖家结构。** 三类：
- Amazon 自营（"Amazon Retail"）或品牌自营——本土品牌为主。
- 美国品牌的**进口商**：NOW 那个是 "USA Supplements Direct" 卖、"Delivered by Amazon"、Importer 填 "baljit nutrition stores pvt ltd"，页面写 "labelled to United States standards"。同一 ASIN 可能多个进口商跟卖，价格波动大（这个 MRP ₹6,379，售价 ₹2,493）。
- 品牌在印度本地生产的国际品牌（Centrum、Ensure 等）：**ASIN 和美国不同**，配方也可能不同。

**范围（要 owner 定）。** Diet & Nutrition 里混着蛋白粉、肌酸、Ayurveda 草药、Isabgol 纤维、Chyawanprash、婴儿奶粉、成人营养奶粉。建议：补剂 + 运动营养 + Ayurveda 草药补剂收；婴儿配方奶粉、营养奶粉饮料（Ensure、PediaSure、Lactogen）不收。用 `nonSupplementCategories` 和面包屑子类目拦，规则同美国。

---

## 3. 数据模型

### 3.1 爬虫这边：每个亚马逊站点一个渠道 ID

现在 listing 的身份是 `(channel, listing_id, variant_id)`，`channel = 'amazon'`，`listing_id = ASIN`。这个键贯穿 `html_capture`（7 天复用窗口）、`formula_link`、`listing_state_observation`、队列、历史、`product_sync`。**ASIN 跨站点会重复**（实测 B0019LWV92 在 .com 和 .in 都是它），如果印度也用 `amazon`，印度商品会直接复用美国存档的 HTML、覆盖美国的上下架状态。

两个做法：

| | A. 新渠道 `amazon-in`（推荐） | B. 仍是 `amazon`，加 site 维度 |
|---|---|---|
| 改动 | 每张表的 channel CHECK 加一个值（现行约束在 027/028/029/032/061，一个迁移）；`MARKETPLACE_CHANNELS`、`DeliveryRun.channel` 等联合类型加值；约 29 个文件里写死的 `"amazon"` 改成"是不是亚马逊系"判断 | `html_capture`、`formula_link`、`listing_state`、队列、历史、`product_sync` 的唯一键和索引都要加 site 列，回填历史 |
| 风险 | 小，现有美国数据一行不动 | 大，碰所有表的主键 |
| 扩到 12 国 | `amazon-uk`、`amazon-de`… 同一个 adapter 工厂生成 | 同样要改 |

做法 A 的实现：`packages/channels/amazon` 改成工厂 `amazonMarketplaceAdapter(site)`，站点配置只有这些——

```ts
{ channel: "amazon-in", origin: "https://www.amazon.in", countryCode: "IN", currency: "INR",
  currencySymbols: ["₹", "INR"], datePatterns: ["d MMMM yyyy"], postalCode: /\b\d{6}\b/,
  nonSupplementCategories: [...印度表], scraperApiCountry: "in" }
```

选择器、图片、变体、BSR、徽标、验证页代码共用一份（§1 里"直接用"的部分）。

**配方复用。** 把 `amazon-in` 也声明为 `formulaFamily: "amazon-asin"`（Whole Foods 已经这么做）：同一个 ASIN 的美国配方直接复用，进口美国品不再 OCR。B0019LWV92 这种页面写着"按美国标准标签"，复用是对的。本地生产的国际品牌 ASIN 不同，不会误复用。第一期抽 20 个复用的，人工核对包装图。

**GTIN。** 新读 "Global Trade Identification Number"/"UPC" 行，写进 `attrsRaw` 和交付的 `gtin`（多个值时都保留在 `attrsRaw.gtins`，`gtin` 取第一个）。

### 3.2 跨国合并的规则

合并在 Supply Smart（产品归它管），爬虫只给证据和一个建议。判断顺序：

1. **同一 ASIN**（不同站点）→ 同一产品，自动合并。
2. **GTIN 重合**（统一成 GTIN-14 比较）→ 同一产品，自动合并。
3. **同品牌 + 同配方指纹**（成分名 + 每份剂量 + 剂型）+ 规格一致 → 候选，进人工审核；不自动合。
4. 都不满足 → 不合并，作为新产品挂在品牌下，只带 `IN` 一个国家。

品牌：本土品牌（Carbamide Forte、Wellcore、MuscleBlaze）是新品牌，走现有品牌建档（各渠道品牌全收的规则）；国际品牌（NOW）按现有品牌匹配挂到同一品牌下。印度的 `p_123` 品牌 ID 和美国是不是同一个**未确认**，不靠它合并。

合并不了的不用强合：国家筛选打开后，看美国的人看不到印度独有产品，品牌下就不会乱。这正是会议上要加国家筛选的原因。

### 3.3 Supply Smart 接口契约（只写字段，不改 Supply Smart）

观测 ingest 和 label 请求里每条 listing 加：

| 字段 | 例子 | 说明 |
|---|---|---|
| `channel` | `"amazon"` | 不变，零售商还是亚马逊 |
| `marketplace` | `"amazon.in"` | **新加**。爬虫内部渠道 `amazon-in` 在交付时映射成这里 |
| `countryCode` | `"IN"` | **新加**，ISO 3166-1。产品页的国家筛选用它 |
| `currency` | `"INR"` | 已有字段，过去恒 USD |
| `price` | `"650.00"` | 已有，印度是含税价 |
| `listPrice` | `"1075.00"` | 已有，印度是 M.R.P. |
| `extras.priceTaxIncluded` | `true` | **新加**，美国为 false |
| `extras.listPriceKind` | `"mrp"` | **新加**，美国为 `"strikethrough"` |
| `gtin` | `"08906081920485"` | 已有字段，印度页面多数能填 |
| `extras.importer` / `extras.countryOfOrigin` | `"baljit nutrition stores pvt ltd"` / `"India"` | 新加，可选 |
| `productUrl` | `https://www.amazon.in/dp/B08CZ916RD` | 已有 |
| `externalId` | `"B08CZ916RD"` | 不变 |

Supply Smart 那边需要：

- listing 的唯一键里带上 `marketplace`（否则 B0019LWV92 的印度 listing 会落到美国那条上）。**这是契约里唯一的硬要求。**
- 产品的"售卖国家" = 它下面在架 listing 的 `countryCode` 去重；产品页的国家筛选按这个过滤，默认 US。
- 价格展示按 `currency` 显示原币，换算由 Supply Smart 决定。
- `marketplace` 缺省时按 `amazon.com` 处理，老数据不用回填。

备选：Supply Smart 不改唯一键，而是在 `channel` 枚举里加 `amazon_in`。12 国就是 12 个枚举值，筛选还得再从 channel 推国家，不推荐。

---

## 4. 范围和量

### 4.1 怎么拿品牌和商品清单

1. **畅销榜找品牌**：Diet & Nutrition（`1374489031`）和它的叶子节点（维生素、矿物质、鱼油、蛋白、草药…约 30–40 个）每个榜单前 100 名（2 页）。约 80 个请求，拿到 2,000–3,000 个 ASIN 和品牌名，并按上榜次数给品牌排序。
2. **类目搜索的品牌筛选栏**：`/s?rh=n:<节点>` 左栏 Brand 列出 `p_123` ID，补全长尾品牌。每个节点 1–2 个请求。
3. **已有国际品牌**：Supply Smart 里已有的品牌在 amazon.in 搜一次，有 `p_123` 就建 source。
4. 对每个品牌 source 跑现有品牌扫描（`/s?rh=p_123:<id>`，48 条/页，7 页上限 = 336 个/品牌），商品进队列，后面完全走现有产品流水线。

### 4.2 数量估计（没有付费抓取，量级估计，第一期实测后修正）

| | 第一期（Top 50 品牌） | 全量（约 300 个有量的品牌） |
|---|---|---|
| 商品数（含规格） | 约 4,000–6,000 | 约 25,000–40,000 |
| 其中同 ASIN 可复用美国配方（进口美国品） | 约 10–20% | 约 15–25% |
| 页面请求（品牌扫描 + 商品页 + 验证页升级/规格补抓，×1.2） | 约 6,000–7,500 | 约 35,000–50,000 |
| ScraperAPI credits（5/页；验证页 30/次另算） | 约 3–4 万 | 约 18–25 万 |
| 费用（按 $0.5–0.75 / 千个 Amazon 页估） | 约 $5 以内 | 约 $20–40 |

ScraperAPI 不是瓶颈；瓶颈是标签阶段（OCR + Codex 视觉/文字），和美国一样。

### 4.3 在哪跑、多久

- 商品页和品牌扫描（HTTP）跑在 **Server 一**（pipeline-worker + ScraperAPI 车道，容量 40）；OCR 在 Windows；文字/视觉模型在 Server 一。只有遇到 `/stores/` 页的品牌才用 **Server 二** 浏览器。
- 抓页面：6,000 页在 40 并发下 1 小时以内。
- 标签：09-16 实测满负荷约 7,000 个新产品/天；和正在跑的各渠道轮次共用 Codex 槽位，按 30–50% 算 2,000–3,500 个/天。第一期 **2–3 天**，全量 **10–15 天**。之后每轮重抓只抓页面（配方只提一次），一轮全量页面费用约 $20、几小时。

---

## 5. 分期

### 第一期：印度 Top 50 品牌（最小可用）

做什么：
1. adapter 工厂 + `amazon-in` 渠道（§3.1）、印度类目表、INR/MRP/日期/PIN/GTIN 解析。
2. 迁移：各表 channel CHECK 加 `amazon-in`；写死 `"amazon"` 的地方改成亚马逊系判断。
3. 私有配置：ScraperAPI `channels.amazon-in.countryCode = "in"`、`allowedOrigins` 加 amazon.in（先 1 个请求核对地区和单价）。
4. 品牌：畅销榜 + 已有国际品牌选 50 个（建议约 30 个本土 + 20 个国际），建 source，跑品牌扫描。
5. 交付：按 §3.3 加字段发到 Supply Smart **测试库**；正式库等 Supply Smart 唯一键改好再发。

验证标准：
- **页面字段**：随机 30 个商品对照页面，价格/MRP/币种/评分/评论数/徽标/BSR/上架日期/GTIN 一致率 ≥ 95%。
- **配方**：30 个本土品牌商品对照包装图，成分和剂量都对 ≥ 90%；Review 率不高于美国当前水平。
- **复用**：20 个同 ASIN 复用美国配方的，人工核对包装图一致。
- **不串数据**：美国 `amazon` 渠道的 `html_capture`、`listing_state`、`product_sync` 在第一期期间没有一行来自 amazon.in。
- **Supply Smart 测试库**：同一 ASIN 的美国和印度 listing 是两条；国家筛选选 US 时产品数不变，选 IN 能看到印度产品。
- 统计：验证页遇到率、每页实际 credits、天城文标签比例、`%RDA` 标签解析情况，写回本文。

### 第二期：印度全量

按 §4.1 扩到所有有量的品牌，跟各渠道一起进周轮次。可选：视觉模型顺带读 FSSAI 许可证号。

### 之后扩其他国家的顺序（建议）

1. **英文站**：英国（amazon.co.uk）、加拿大（.ca）、澳大利亚（.com.au）、新加坡（.sg）。页面结构同、标签英文，只换站点配置（币种、日期格式 `d MMMM yyyy`/`MMMM d, yyyy`、邮编、类目表）。加拿大和美国共享 ASIN 多，复用率高。
2. **欧盟**：德国先（品类最全），再法国、意大利、西班牙。欧盟站 ASIN 大量互通，德国做完后其他三国大部分配方能复用。难点：标签是德/法/意/西文、小数点用逗号、价格含 VAT——标签视觉模型要输出英文成分名并保留原文作证据，这是新能力，单独设计。
3. **墨西哥、巴西**：西语/葡语，巴西是独立目录、补剂少。
4. **日本**：日文标签、"栄養成分表示"格式、ASIN 基本不和美国互通，最难，放最后。

---

## 待 owner 决定

1. 印度收录范围：运动营养、Ayurveda 收不收；婴儿奶粉 / 营养奶粉排除（§2 末，推荐如上）。
2. Supply Smart 用 `marketplace` + `countryCode` 字段（推荐）还是加 `channel` 枚举（§3.3）。
3. 印度月销量没有徽标时：照美国规则给 25（现有代码自然结果），还是留空。推荐照美国给 25，和 Supply Smart 现有展示一致。
