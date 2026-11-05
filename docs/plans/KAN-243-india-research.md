# KAN-243 印度亚马逊调研（爬虫侧）：营养标签与市场

2026-11-04。纯调研，没改生产代码、没部署、没建任务、没往 Supply Smart 推数据。
在 11-03 设计稿（分支 `design/KAN-243-india` a64b5a2d，`docs/plans/KAN-243-india-amazon-design.md`，下称「设计稿」）基础上补调研，不重复它已写清的部分。
Supply Smart 侧方案：supply-smart-mono `feat/KAN-243-sales-region`（test d1da4798）`docs/plans/KAN-243-sales-region.md`（只读）。

## 0. 结论

1. **印度保健品标签主要有三种版式，没有一种叫 Supplement Facts（进口美国货除外）。** 20 个畅销品里：
   - **FSSAI「Nutritional Information」表**：12 个（60%）。列是 `Qty./Serving` + `%RDA`，常带 `per 100 g` 列，上半是能量/蛋白/糖/脂肪/钠，下半是活性成分；
   - **「Composition / Each … contains」**：4 个（20%）。AYUSH（Ayurvedic Proprietary Medicine）或药品许可的产品，成分写拉丁学名 + 药用部位 + 每单位用量；
   - 美国 Supplement Facts（进口美国品）1 个（5%）；只有单一配料、没有表 1 个（5%）；图库里根本没有标签 2 个（10%，Centrum、Himalaya）。
2. **标签只在图片里。** 20 个页面没有一个在文字里有完整成分表。只有 1 个（Kapiva Shilajit）在 `#important-information` 里写全了「每克含量」。现有文字路径（要求出现 "Supplement Facts"）对印度 100% 判为不完整，全部走图片路径。
3. **图片路径能读，但入口和解析规则是美国口径，不改会大量漏掉或读错：**
   - 挑图关键词表没有 "Nutritional Information"、"Composition"、"RDA"。实测 10 张标签图里有 4 张不会被选中；
   - 新的照抄+解析（KAN-253）把不带 `%` 的 RDA 数字（`0.20`、`100`）当成第二个用量列；
   - 视觉提示词只说 Supplement/Nutrition Facts 和 %DV。
4. **数据结构大部分能对上**：
   - serving size、每份用量、`**`（RDA 未设定）都能直接映射；
   - `%RDA` 可以放进现有 `dailyValue` 字段，但要标明口径（印度 ICMR-NIN RDA，不是美国 FDA DV）；
   - 要新加或决定的：多列 RDA（男/女、1 袋/2 袋）、per 100 g 列的基准、Ayurveda 的学名/药用部位/「每 100 g 由…制成」这种原料投料量（不是每份含量）、FSSAI/AYUSH 许可证号和类别字样（第一期建议不抽）。
5. **市场侧**：
   - ScraperAPI 对 amazon.in 5/5 成功，每页 5 credits，`country_code=in` 我们的套餐能用（解决了设计稿的未决项），没遇到验证页；
   - 现有 Amazon 解析器在 25 个印度页面上：BSR、销量徽标、图库 100% 正常，价格、上架日期 100% 为空（设计稿已预计）；
   - 另发现价格区第一个非空 `.a-offscreen` 是**单价**（₹6.25/片），不能拿来当售价。
6. **和 Supply Smart 对齐**：Supply Smart 用 `country_code` 做键，爬虫只需在**每次提交**（item、label 的 listing、listing-state 的 listing、run）带上 `marketplace: "amazon.in"`，并保证一个 run 只有一个站点。
   - 要改的是 `product-delivery/wire.ts`、`product-sync`（mapping/plan/send）、`listings`（listing-state）这三块，外加约 15 处写死 `channel === "amazon"` 的判断（§6）；
   - 设计稿 §3.2 规则 3 和 §3.3 唯一键的写法已过时（§6.2）。

---

## 1. 样本与方法

| 项 | 数量 | 说明 |
|---|---|---|
| amazon.in 页面 | **28**（上限 30） | Ego Lite（本机）23 个：畅销榜 2、类目搜索 1、商品页 20；ScraperAPI 5 个商品页 |
| 商品 | 20 | Diet & Nutrition / Vitamins 畅销榜里挑：国际品牌（Centrum、NOW）、印度本土（Tata 1mg、HealthKart 的 HK Vitals/MuscleBlaze、Carbamide Forte、Good Monk、HealthyHey、Be Bodywise、Little Joys、Wellcore、Nakpro、Naturaltein）、Ayurveda（Himalaya、Dabur、Baidyanath、Kapiva ×2、Organic India） |
| 图库原图 | 173 张 | 从 `m.media-amazon.com` 取现有解析器选出的 hiRes 图（不是 amazon.in 页面） |
| OCR | 10 张 | Server 一 → Windows OCR（PP-OCRv5，`192.168.68.74:8081/ocr`），与生产同一服务 |

- **归档**：
  - ScraperAPI 的 5 个原件逐字节存进 R2 `supply-smart-test/research/kan243-india/scraperapi/<ASIN>-<cc>-<time>.html`，旁边是 `.json`（URL、时间、字节数、SHA-256、`sa-credit-cost`），每个都回读校验 SHA-256 后才解析；
  - 副本在 Server 一 `~/kan243-research/`；
  - Ego 页面（浏览器 DOM，不是付费下载）和图片只在会话临时目录，不进 git；
  - 准入：amazon.in 此前没有任何抓取历史，每个 ASIN 只请求一次。
- **页面清理**：Ego 任务空间 `kan243 india research` 已 `finish({keep:[]})`，复查列表里已不存在。
- **没做**：没跑视觉模型（Codex 回放要先定模型/并发），所以「能不能读出来」的判断来自我看原图 + 生产 OCR 输出 + 对现有代码规则的静态核对。

---

## 2. 印度营养标签

### 2.1 法规依据（包装上实际引用的 + 公开资料）

| 产品类别 | 法规 | 标签上表现 |
|---|---|---|
| 一般预包装食品 | FSS (Labelling and Display) Regulations, 2020 | 营养信息（能量、蛋白、碳水、总糖、添加糖、总脂、饱和/反式脂、钠），per 100 g/100 ml 或 per serve，加 per-serve **%RDA**；素食绿点/非素食棕点；FSSAI 标志 + 14 位许可证号 |
| 保健品 / 营养品 / 特殊膳食 | FSS (Health Supplements, Nutraceuticals, FSDU, FSMP, … Prebiotic and Probiotic Food) Regulations, 2022（取代 2016 版） | 名称旁写类别：**HEALTH SUPPLEMENT** / **NUTRACEUTICAL** / **FOOD FOR SPECIAL DIETARY USE**；**NOT FOR MEDICINAL USE**；每份营养素 + %RDA；"Not to exceed the recommended daily usage"；RDA 按 ICMR-NIN 2020（FSSAI 2022-02 指示，特定人群用对应人群 RDA） |
| Ayurveda / Siddha / Unani | Drugs and Cosmetics Act 1940 / Rules 1945 第 161 条（AYUSH） | **Ayurvedic (Proprietary) Medicine**；全部成分 + 植物**学名** + **药用部位** + 用量；`Mfg. Lic. No.`（州 AYUSH 许可，如 `RJ 711-AYU`）；经典方注明出处（Dabur：`R.T.S VA S.P.S – Awaleha Prakarana`） |
| 药品许可的维生素 | Drugs and Cosmetics Rules（药典品 `IP`） | `Composition: Each film coated tablet contains: Methylcobalamin IP 1500 mcg, Excipients q.s.`，`Mfg. Lic. No.` |

样本标签自己也写了依据，例：Tata 1mg Omega 3 脚注 "% RDA calculated based on FSS (Labelling & Display Regulations), 2020. #% of RDA calculated based on RDA for women involved in sedentary work as per ICMR-NIN, 2020."

### 2.2 版式和占比（20 个）

| 版式 | 个数 | 占比 | 标题写法 | 列 / 结构 | 例子（原图） |
|---|---|---|---|---|---|
| **A. FSSAI 营养信息表** | 12 | 60% | `Nutritional Information (Approx.)`、`NUTRITIONAL INFORMATION (Approx. Values)`、`Nutrition Information`、`NUTRITIONAL FACTS (Approximate Values)`、`Gummies Nutritional Information`；1 个无标题（Little Joys 只有表头 `Nutrients`） | `Nutrients │ Qty./Serving │ %RDA`。上半营养素（kcal、g、mg），下半活性成分（mg/mcg/CFU），活性成分的 RDA 常是 `**`。其中 5 个有 per 100 g 列，2 个有两列 RDA | Tata 1mg Mg [信息图](https://m.media-amazon.com/images/I/61zJ8PpK51L._SL1000_.jpg)、[背标](https://m.media-amazon.com/images/I/81IZjDI-VmL._SL1500_.jpg)；HealthyHey [`%RDA Men │ %RDA Women`](https://m.media-amazon.com/images/I/71vjMWrR2LL._SL1500_.jpg)；HK Vitals [`Qty/Serving(8g) │ Qty/100g │ %RDA`](https://m.media-amazon.com/images/I/71e-TqpasxL._SL1500_.jpg)；Good Monk [`Per sachet │ %RDA for 1 sachet │ %RDA for 2 sachets`](https://m.media-amazon.com/images/I/61FW2VMjdaL._SL1080_.jpg)；Nakpro [`per 100g │ per 45g │ %RDA` + 维生素/矿物质两张并排小表](https://m.media-amazon.com/images/I/810j3vuM+DL._SL1500_.jpg)；Tata 1mg Omega 3 [营养素 + "Two soft gelatin capsule contains (approx.)" 两段](https://m.media-amazon.com/images/I/81ps4lhJ3yL._SL1500_.jpg) |
| **B. Composition / Each … contains** | 4 | 20% | `Composition:`、`INGREDIENTS: Each 30ml is made from:`、`Ingredients: Each 1g contains:`、`COMPOSITION: Each 100g is prepared from:` | 一段文字，不是表。`名称 (学名) 部位 [形态] 用量`，结尾 `Excipients q.s.` / `Water Q.S.` | Kapiva Shilajit [Each 1g contains: Shilajit (Asphaltum) Exd. 333.33mg …](https://m.media-amazon.com/images/I/61IroGyhlWL._SL1200_.jpg)；Kapiva Dia Free [Amla (Emblica officinalis) Fresh Fr. (swaras) 17.91ml …](https://m.media-amazon.com/images/I/81Mozycwd0L._SL1500_.jpg)；Dabur Chyawanprash [Each 100g is prepared from: Patala (Stereospermum suaveolens, St. Bk.) …](https://m.media-amazon.com/images/I/81QsYaYYQEL._SL1500_.jpg)；Carbamide Forte B12 [Each film coated tablet contains: Methylcobalamin IP 1500 mcg](https://m.media-amazon.com/images/I/71o3iPJtrcL._SL1428_.jpg) |
| C. 美国 Supplement Facts | 1 | 5% | `Supplement Facts` | 美国版式 | NOW Glutathione（进口，"labelled to United States standards"）[背标](https://m.media-amazon.com/images/I/71dLS5ZcpEL._SL1500_.jpg) |
| D. 只有配料，没有表 | 1 | 5% | `Ingredients:` | 单一配料 + `Serving Size: 5 g` | Baidyanath Isabgol [英文侧标](https://m.media-amazon.com/images/I/61+pq9Pz2mL._SL1500_.jpg)、[印地文侧标](https://m.media-amazon.com/images/I/61qix9-aMpL._SL1500_.jpg) |
| E. 图库和 A+ 都没有标签 | 2 | 10% | — | Centrum Women（只有正面和营销图，标签在盒子上没拍）；Himalaya Ashwagandha（背面只拍到厂址和 "Ayurvedic Medicine"） | — |

两个跨类的情况：

- **同一 ASIN，两种监管身份。** Kapiva Dia Free（B07DR8G2YP）页面写 "You may receive either pack"：一种包装是 Ayurvedic Proprietary Medicine（版式 B，`Mfg. Lic. No. RJ 711-AYU`），另一种是 `13.5 FOOD FOR SPECIAL DIETARY USE`（版式 A，[`NUTRITIONAL FACTS (Approx.)` per 30 ml / per 100 ml / %RDA](https://m.media-amazon.com/images/I/61IIC7hQVjL._SL1254_.jpg)）。上表按版式 B 计。
- **同一商品，图之间标题不一致。** Carbamide Forte B12 的营销图写 [`Supplement Facts` + `Nutritional information (Approx. Values) / Each serving contains`](https://m.media-amazon.com/images/I/61pphZ26QjL._SL1000_.jpg)，真实背标是 `Composition`。印度本土品牌在营销图里模仿美国版式的情况存在，以背标为准。
- **新旧两版都放在图库里。** Little Joys 同时放了 "New version RDA as per 4–6 years" 和 "Old version RDA as per 1–3 years" 两张表，用量也不同（如维生素 D 7.5 mcg 对 15 mcg）。现有的「多张图配方冲突 → Review」规则会拦住它，这是对的。

**其他统计：**

| 项 | 结果 |
|---|---|
| 类别字样（NUTRACEUTICAL / HEALTH SUPPLEMENT / FOOD FOR SPECIAL DIETARY USE / Ayurvedic (Proprietary) Medicine） | 20 个里 17 个能在图上看到 |
| FSSAI 许可证号 | 图上可见 14 个；页面文字里 0 个（HealthyHey 的要点里有 "FSSAI" 字样，没有号码） |
| 天城文（印地文）标签段 | 2 个（Baidyanath 一整面印地文、Dabur 正面有印地文）。两者都另有英文成分段。和设计稿判断一致：不影响第一期 |
| 素食绿点 | 18/20（NOW 是美国标签，Tata Omega 3 是非素食棕三角） |

### 2.3 标签在页面文字里还是图片里

| 位置 | 有完整成分表 | 只有成分名 / 配料清单 | 说明 |
|---|---|---|---|
| `#important-information` → Ingredients | **1/20**（Kapiva Shilajit：每克含量写全） | 14/20 | 例："Magnesium Glycinate"、"Psyllium Husk"、"Biotin. Zinc and Multivitamins (Vitamin A, C & E)"；MuscleBlaze 写 "Please see the label image for ingredient information" |
| 详情表 `Ingredients` / `Generic Name` 行 | 0 | 13/20 | 常常不准："Ginseng"（Himalaya Ashwagandha）、"STRAWBERRY"（Little Joys），不能当证据 |
| A+ 内容 | 0 | — | 文字多是营销；看了 Centrum、Himalaya 的 A+ 图也没有标签 |
| 图库图片 | **17/20** | — | 背标实拍 13 个，信息图重排的表 6 个（有重叠） |

所以印度商品和美国 Amazon 大部分商品一样，**配方只能来自图片**；页面文字最多给配料清单。

### 2.4 现有 OCR / 视觉流程能不能读

**OCR（生产 PP-OCRv5，10 张）：**

| 图 | 读到标题 | 用量数字 | 备注 |
|---|---|---|---|
| Tata 1mg Mg 信息图 | ✔ `Nutritional Information (Approx.)` | 全对 | 干净信息图 |
| Tata 1mg Omega 3 背标 | ✔ | 基本对 | 两瓶并排的照片，表约 500 px 宽也能读 |
| HealthyHey 背标 | ✔ | 活性成分对，营养素行乱 | 曲面瓶 |
| Good Monk | ✔ | 大部分对；`Vitamin B12` 读成 `Vitamin 812` | 1080 px 小字 30 行 |
| HK Vitals 背标 | ✔（`NTRITIONALINFORMATION`） | 营养素对，配料段乱 | 三张并排小表 |
| MuscleBlaze 背标 | ✔ | 数字有，行列对不齐 | 最密的一张 |
| Kapiva Shilajit 成分 | ✔ `Ayurvedic Proprietary Medicine` | 全对 | 版式 B |
| Carbamide B12 背标 | ✔ `Composition` | 全对 | 版式 B |
| Dabur 背标 | ✔ `COMPOSITION` | 学名大多对，长段被拆成碎词 | 版式 B，曲面 |
| Baidyanath 侧标 | ✗（印地文面全是乱码） | — | 英文面另一张 |

结论：印度标签都是英文、拉丁字母，OCR 本身能用。难的是曲面瓶上的小字和多张并排小表，美国也有同样问题，由视觉模型照抄、OCR 只做挑图和数字核对。

**挑图关键词（`DefaultKeywordPolicy`）：** 用这 10 张的 OCR 文字跑现有规则（整词、不分大小写）：

| | 选中 | 没选中 |
|---|---|---|
| 现有关键词（Supplement Facts、Nutrition Facts、Ingredients、Other Ingredients、Amount Per Serving、Daily Value、Servings Per Container） | 6（全部靠 "Ingredients" / "Servings Per Container" 碰上） | **4**：Tata Mg 信息图（只有 Nutritional Information + %RDA）、Carbamide B12 Composition、Dabur Composition、Baidyanath |
| 加上 Nutritional Information、Nutrition Information、Nutritional Facts、Composition、RDA | 9 | 1（Baidyanath 印地文面，本来就不该选） |

**视觉模型：** 没跑（见 §1）。下面是对照提示词和解析规则的静态判断，第一期要用真实图片回放验证：

- 照抄提示词（`label-visual-wire/4`）只说 "Supplement Facts / Nutrition Facts panel"、"each %DV column"、"Serving Size / Servings Per Container"。对版式 A，模型大概率照抄，但没告诉它 `%RDA` 是 DV 列；对版式 B（一段文字，不是表），提示词让它找表，可能返回空 panel 或把整段塞进 otherIngredients。
- 照抄之后的代码解析（`transcript-cells.ts`）认 DV 必须带 `%`。印度表的 RDA 列只印数字（`0.20`、`100`、`2.31`），会被当成**第二个用量列**。这是确定会出错的点，见 §4。

---

## 3. 和现有成分表结构（`label-extraction/1`）的映射

现有结构：`formula { servingSize, servingsPerContainer, columns[{ heading, rows[{ kind, name, amount, dailyValue, amountStatus, parentRowIndex }] }] }` + `otherIngredients { heading, items[] }`。Supply Smart 的 `label-normalize.ts` 按这个结构解析（`parseDailyValue` 已接受不带 `%` 的数字和 `**`；每列有自己的份量基准，`alternate_basis`）。

| 印度标签内容 | 例子 | 映射 | 结论 |
|---|---|---|---|
| Serving size | `Serving size: 2 tablets (2.44 g)`、`1 Level Scoop (8g)`、`Serve Size: 2.38 g (1 sachet)` | `servingSize` | **直接** |
| Servings per container | `Servings per container: 30`、`Servings Per Pack: 22` | `servingsPerContainer` | 直接（解析规则要认 "Per Pack"） |
| 每份用量列 | `Qty./Serving`、`Amount Per Serving`、`Per sachet`、`per 45g` | `columns[0]`，`heading` 存原文 | **直接** |
| per 100 g / 100 ml 列 | `Qty/100g`、`Per 100ml` | 第二列，`heading` 原文；Supply Smart 当 `alternate_basis` | 能放。Supply Smart 要能从 `Qty/100g` 读出基准，待验证（`COLUMN_HEADING_UNPARSED` 风险）。**建议爬虫只交付每份列**，per 100 g 列保留在证据里（下游只关心每份剂量） |
| %RDA | `0.20`、`100`、`27.50` | `row.dailyValue` | 字段能放，**语义不同**：印度 RDA（ICMR-NIN，按人群）≠ 美国 FDA %DV，不能跨国比较。要加口径标记（§7 问题 2） |
| `**` / `*`（RDA 未设定） | `**` | `dailyValue` = `**` | 直接（同美国 `†`，Supply Smart 解析为 `not_established`） |
| 两列 RDA | `%RDA Men │ %RDA Women`；`%RDA for 1 sachet │ for 2 sachets` | 现在每行只有一个 `dailyValue` | **对不上**。建议取第一列 RDA，其余保留在证据里，不新加字段 |
| 营养素行 | `Energy 6.00 kcal`、`Protein 1.00 g`、`Total Sugar`、`Added Sugar`、`Sodium` | `kind: nutrient` | 直接（和美国 Nutrition Facts 一样） |
| 活性成分 | `Magnesium bisglycinate 2000 mg`、`Elemental Magnesium 440mg` | `nutrient` | 直接。"Elemental Magnesium" 是同一成分的折算量，和美国 "(as …)" 同样处理 |
| 分段小标题 | `Two soft gelatin capsule contains (approx.):`、`ADDED VITAMINS AND MINERALS`、`TYPICAL AMINO ACID PROFILE` | `group_header` 或续排 | 能放；氨基酸谱是否收按美国现行规则 |
| Composition 每单位用量 | `Each film coated tablet contains: Methylcobalamin IP 1500 mcg` | `servingSize` = `1 tablet`（来自 "Each … contains"）+ 行 | 能放，但现在 `servingSize` 必须是印出的 Serving Size 值。要允许 "Each X contains" 作为份量基准 |
| `Excipients q.s.` / `Water Q.S.` | — | `otherIngredients` 一项 | 能放，标题是 `Composition`，现有 `isIngredientHeading` 会判非法（§4） |
| Ayurveda 学名 + 部位 + 形态 | `Ashwagandha Extract (Withania somnifera) Rt. 133.33mg`、`Amla (Emblica officinalis) Fresh Fr. (swaras) 17.91ml` | `name` 存整段原文 | 能放（原文不丢）。拆成 `botanicalName` / `plantPart`（Rt. 根、Fr. 果、Lf. 叶、St. Bk. 茎皮、Rz. 根茎、Sd. 种子、Pl. 全草）/ 形态（Ext.、c. powder、swaras）是**新字段**，第一期建议不拆 |
| 「每 100 g 由…制成」 | Dabur：`Each 100g is prepared from: …` | — | **对不上**：这是投料量（多少生药熬成 100 g 膏），不是成品每份含量。建议只当成分清单（名称），不当剂量 |
| Hindi 段 | Baidyanath 侧标 | — | 不读，用英文段 |
| 类别字样 | HEALTH SUPPLEMENT / NUTRACEUTICAL / FSDU / Ayurvedic Proprietary Medicine | 无 | 新字段（可选）。有用：能区分食品类保健品和 AYUSH 药品 |
| FSSAI 许可证号 / AYUSH `Mfg. Lic. No.` | `10019051003050`、`RJ 711-AYU` | 无 | 新字段（可选），第一期不抽 |
| 素食 / 非素食标志 | 绿点 / 棕三角 | 无 | 新字段（可选），视觉判断，第一期不抽 |
| `NOT FOR MEDICINAL USE`、RDA 脚注、过量说明 | — | `exclusions`（footnote/metadata） | 能放；解析器要认识这些脚注（§4） |

---

## 4. 现有 label 流程里写死美国口径的地方

按「不改就会漏 / 读错」排序。行号是 `research/KAN-243-india`（origin/main a80c05f7；29289be5 只改了 blend 行，不影响这些位置）。

| # | 位置 | 美国口径 | 印度后果 | 改法 |
|---|---|---|---|---|
| 1 | `packages/v3-contracts/src/vision.ts:12-14` `DefaultKeywordPolicy` | 只有 Supplement/Nutrition Facts、Daily Value、Amount Per Serving… | 实测 4/10 标签图不被选中（§2.4） | 加 `Nutritional Information`、`Nutrition Information`、`Nutritional Facts`、`Composition`、`RDA`；关键词表变化会改 `keywordCompatibility` 指纹，属于新策略版本 |
| 2 | `packages/processing/src/label/transcript/transcript-cells.ts:10` `DAILY_VALUE` | DV 必须带 `%` | RDA 列 `0.20`、`100` 被当作第二个用量列，**用量读错** | 按列头判断：列头是 `%RDA` / `% RDA*` / `#%RDA` 的整列是 DV 列，不看单元格有没有 `%`。注意 `label-visual-answer/4` 在解码时重新解析存下的照抄，解析规则一改，已存的美国答案也会跟着变：改动要么只对新列头生效，要么先对已存答案做新旧回放 |
| 3 | 同文件 `:16-17` `SKIP`、`:23-24` `HEADER_CELL`、`:12-15` 份量行 | 不认 `Nutritional Information`、`Nutrients`、`Qty./Serving`、`%RDA`、`Qty/100g`、`Servings Per Pack`、`Serve Size` | 表头行被当成成分行；份量数读不到 | 补这些写法 |
| 4 | `packages/processing/src/label/transcript/transcript-answer.ts:31` `EXCLUDED` | 标题/脚注只认美国写法 | `% RDA calculated based on ICMR-NIN 2020…`、`NOT FOR MEDICINAL USE` 不被识别为脚注 | 补印度脚注 |
| 5 | `packages/processing/src/vision/protocol/label-transcript-wire.ts:46-56,64` 照抄 / 复读提示词 | "Supplement Facts / Nutrition Facts panel"、"%DV column" | 版式 B（一段文字）不知道怎么抄；RDA 列没被说明 | 新协议版本（提示词进指纹，不能原地改）：加 Nutritional Information、`%RDA` 列、`Composition / Each … contains` 段落 |
| 6 | `packages/processing/src/vision/protocol/label-vision.ts:24,33,42-49`（`retainDailyValueHeading` 只认 `% Daily Value`）、`packages/v3-vision/src/label-extraction.ts:7` | 旧的结构化视觉提示词 | 2026-11-04 起图片已切到照抄+解析（`label-visual-wire/4`，29289be5），旧路径只在回退时用 | 印度只走照抄路径，旧提示词不改 |
| 7 | `packages/channels/amazon/src/facts.ts:4-5` `FACTS_HEADING`、`:54-58` `labelRequirements` | 文字完整必须有 "Supplement Facts" 和 "Serving Size" | 印度文字永远不完整（这本身对）。但 Kapiva Shilajit 这种文字里已有 "Each 1g contains" 全量的，用不上 | 第一期不改（只有 1/20），以后可加印度的 "Each … contains" 文字规则 |
| 8 | `packages/v3-contracts/src/label-extraction.ts:61-67` `isIngredientHeading` | 配料标题必须含 "ingredient" | `Composition:` 当配料标题会触发 `LABEL.INGREDIENT_HEADING_INVALID` 进 Review | 允许 `Composition` |
| 9 | `packages/processing/src/text/protocol/label-headings.ts:17,23,34`、`anchored-exclusions.ts:5`、`label-footnotes.ts:2-25`、`formula/label-text-lines.ts:23`、`assembly/packaging.ts:28` | 文字解码器的标题、份量、DV 脚注 | 印度文字路径基本用不到（§2.3），但 `packaging.ts` 的份量对账会读印度标签的 Serving Size 行 | 只改 `packaging.ts` 的份量行写法（Per Pack、Serve Size）；其余随第 7 项再说 |
| 10 | `packages/v3-contracts/src/label-agreement.ts:318`、`label-typography.ts:12`、`label-quality.ts:47` | 认 "amount per serving %DV" 轴 | 印度 `Qty./Serving │ %RDA` 轴不被识别，影响多图一致性比较 | 补写法 |
| 11 | `packages/v3-contracts/src/label-rules/daily-value-only-row.ts` | 只在 Nutrition Facts 语境放过「只有 %DV 没用量」的行 | 印度表里少见（活性成分 RDA 多是 `**`） | 不用改，第一期观察 |

不用改的：`assessLabelCandidate` 不要求 "Supplement Facts" 标题；`**` 的处理（`NONE`）已经有；Drug Facts 分支不会被印度标签误触发。

**范围外但相关**（商品字段，设计稿 §1 已列，本次用 25 个真实页面复核）：

| 字段 | 结果 | 补充 |
|---|---|---|
| 价格 | 25/25 为空（`amount()` 只认 `$`） | **新发现**：`priceToPay` 的 `.a-offscreen` 是空格，第一个非空 `.a-offscreen` 是单价（`₹6.25` per count、Kapiva `₹5,495` 是每 100 g 价，比售价 ₹1,099 还高）。改的时候必须只读 `priceToPay` 的 whole+fraction，不能取「第一个非空价格」 |
| 上架日期 | 25/25 为空（`d MMMM yyyy`） | — |
| 配送 PIN | 6 位，现在为空 | `country_code=us` 出口也返回印度站点和 Mumbai 400001，价格仍是 ₹ |
| BSR、徽标、图库、评分 | 25/25 正常 | — |

---

## 5. 印度市场其它项

| 项 | 结果 |
|---|---|
| 类目结构 | Health & Personal Care › **Diet & Nutrition**（`1374489031`）下有 Family Nutrition（`4264049031`）、Sports Supplements（`1374491031`）、**Vitamins, Minerals & Supplements**（`1374492031`）、Weight Management（`1374493031`）。VMS 下 27 个叶子（Herbal Supplements、Minerals、Vitamins、Probiotics、Essential Fatty Acids & Oils、Collagen、Amino Acids…）。**Ayurveda 另有一棵树**：Dabur Chyawanprash 的面包屑是 Health & Personal Care › Health Care › **Alternative Medicine › Ayurveda** › Chyawanprash，但它也在 Diet & Nutrition 畅销榜上。只按 Diet & Nutrition 拿品牌会漏掉一部分 Ayurveda |
| 规模 | Diet & Nutrition 类目搜索显示 "over 50,000 results"；Brand 栏前列：MuscleBlaze、Carbamide Forte、Kapiva、Optimum Nutrition、NAKPRO、Wellcore、Horlicks、TATA 1MG、HK Vitals。"Country of Origin" 筛选有 India / United States / Hong Kong。设计稿 §4.2 的量级估计不变 |
| BSR | 根类目是 **Health & Personal Care**（美国是 Health & Household），子榜如 "#2 in Magnesium"。样本 #33 到 #9,183。美国月销量曲线不能套用（设计稿已述） |
| 销量徽标 | 20/20 有，写法同美国："10K+ bought in past month"、"4K+…"（样本是畅销榜，偏高） |
| 价格 / MRP | 售价和 M.R.P. 都含税（页面 "Inclusive of all taxes"）。同一 NOW ASIN 上午 Ego 看到 MRP ₹6,379，下午 ScraperAPI 是 ₹4,999、售价 ₹2,129：多个进口商跟卖，buy box 不同，MRP 会随卖家变 |
| 品牌目录 | `p_123` 品牌 ID 可用（如 MuscleBlaze `372854`、Kapiva `341461`、TATA 1MG `591255`）；本次没再抓品牌搜索页（页面额度留给标签），设计稿 §4.1 的方法不变 |
| ScraperAPI | 5/5 HTTP 200，`sa-credit-cost: 5`（和美国 Amazon 同价），3.2–6.8 秒，无验证页，`sa-final-url` 无跳转。`country_code=in` 可用。5 个页面 25 credits |

---

## 6. 和 Supply Smart 契约对齐

Supply Smart 已上测试环境的做法：

- 唯一键 `(channel, country_code, external_id)`；`marketplace` 只作显示和来源；只认白名单（`amazon.in → IN/INR`）；`amazon.com` 存成 NULL；
- item 不带 `marketplace` 就用 run 的，item 和 run 的国家不一致时该 item 判 `marketplace_invalid`；
- `full` run 只判本国缺席；listing-state 和 label 的 listing 不带 `marketplace` 就落到美国 listing。

### 6.1 爬虫要改的地方（模块级）

| 要求 | 改哪里 | 内容 |
|---|---|---|
| ① 每次提交都带 `marketplace` | `packages/app/src/product-delivery/wire.ts`（`DeliveryRun`、`DeliveryListing`、`DeliveryLabel`） | 加 `marketplace?: string`。只发 `marketplace`，不另发 `countryCode`（Supply Smart 从白名单推出，少一个会不一致的字段） |
| | `packages/app/src/product-sync/marketplace-mapping.ts:12-29`（`marketplaceItem`） | item 填 `marketplace`；`clientRef` 的哈希（`:22`）加上 marketplace，避免同 ASIN 美印两边撞 |
| | `marketplace-mapping.ts:32-105`（`marketplaceLabel`、`linkedLabel`、`labelListingWithoutCommerce`） | label 的 `listing` 保留 `marketplace`。注意 label 请求体按白名单剥字段（10-27 教训），新字段要在剥离逻辑里显式保留，并做整请求测试 |
| | `packages/app/src/product-delivery/listing-date.ts:19,60,75`、`sales-estimate.ts:79` | `channel !== "amazon"` 判断改成「亚马逊系」，否则印度 label 请求会漏剥 `salesRank` 等 |
| | `packages/app/src/listings/ports.ts:39-58`、`listing-delivery.ts:23-80` | `ListingStateItem.listing` 加 `marketplace`；按 (channel, marketplace) 分批；run 也带 |
| ② run 带 `marketplace`、一个 run 一个站点 | `packages/app/src/product-sync/sync-send.ts:50-60`（`partialRun`）、`sync-plan.ts` | run 写 `marketplace`；分批时按站点分组，绝不混发 |
| | `packages/adapters/src/product-delivery/product-observation-writer.ts` | `marketplace_invalid` 结果当失败记下原因，不重试 |
| ③ 只用白名单站点 | 渠道注册处（设计稿 §3.1 的 `amazonMarketplaceAdapter(site)` 配置） | 爬虫内部渠道 → `marketplace` 是一张固定表（`amazon-in → amazon.in`），不从 URL 推。表里的值必须先在 Supply Smart `lib/marketplace.ts` 里有 |
| ④ 印度只推测试库 | product-sync 私有配置 | 加 `allowedMarketplaces`（生产默认只 `amazon.com`），印度用指向测试库的单独发送配置。这是配置和防呆，不是代码分支 |
| 内部渠道 ID（设计稿 §3.1 做法 A） | DB channel CHECK：`database/v3/028/029/032/061` 等；`MARKETPLACE_CHANNELS`（`product-sync/marketplace-model.ts:14`）；约 30 个文件里的 `"amazon"` 字面量，其中判断式 15 处（`brand-scans/*`、`product-delivery/*`、`adapters/product-sync/marketplace-projection.ts:38`、`marketplace-listing-date.ts:69`、`channels/core/src/capture/existing-original.ts:21`、`other-offer-retry.ts:18`、`v3-contracts/src/channel-plan.ts:26`、`v3-product/src/amazon-catalog-workflow.ts:22`、`adapters/postgres/run-acceptance.ts:64`） | 逐个判断该是「仅美国」还是「亚马逊系」。`existing-original`（HTML 复用）和 `other-offer-retry` 应是亚马逊系 |

### 6.2 设计稿和 Supply Smart 最终方案的不一致

| 设计稿 | Supply Smart 实际 | 处理 |
|---|---|---|
| §3.3「listing 唯一键里带上 `marketplace`」 | 键是 `country_code`，`marketplace` 只作展示和来源 | 爬虫照发 `marketplace`，效果一样。设计稿改写法 |
| §3.3 每条 listing 同时发 `marketplace` 和 `countryCode` | 两者都可选，都给时必须一致 | 只发 `marketplace` |
| §3.3 只写了 item 和 label | run（`crawlRun.start`）和 listing-state 也要带；一个 run 一个站点 | 按 §6.1 ①② |
| §3.2 规则 3「同品牌 + 同配方指纹 → 候选，人工审核」 | v1 不做；不同国家之间不按「同品牌同名」合并，对不上就新建只在印度卖的产品 | 删掉规则 3；爬虫不发合并建议 |
| §3.3 备选「`channel` 枚举加 `amazon_in`」 | 不采用 | 删掉 |
| §5 第一期验证「国家筛选选 US 时产品数不变」 | Supply Smart 已实现，默认 US | 保留，作为测试库验收项 |
| 未提 | Supply Smart 会从 `sourceUrl` 的域名推国家；listing-state 没有 sourceUrl | 不依赖推断，三处都显式带 `marketplace` |
| 未提 | Signals / 公司页 / Daily picks 还读所有国家 | Supply Smart 那边要在印度进生产前改 Signals。爬虫侧照「只推测试库」执行 |

---

## 7. 待决问题（给总控问用户）

1. **第一期印度标签收哪几种版式？**
   - A（推荐）：版式 A（Nutritional Information，60%）和版式 B 里「Each X contains」的单位含量（Kapiva Shilajit、B12 这种）都读成配方；Dabur 这种「每 100 g 由…制成」的经典方只收成分名、不收剂量（按 10-25 规则，只有成分也是可用产品）；E 类（图里没有标签）照美国现行规则进 Review。
   - B：只做版式 A，Ayurveda 全部只收成分名。
2. **%RDA 放哪？**
   - A（推荐）：放进现有 `dailyValue`，label 上加一个口径标记（`dailyValueBasis: "IN_RDA"`，由 marketplace 决定），多列 RDA 只交第一列。Supply Smart 的解析已经能读，只需展示时不和美国 %DV 混比。
   - B：新开 `rda` 字段，`dailyValue` 印度留空。改动两边都更大。
3. **FSSAI/AYUSH 许可证号、类别字样（Health Supplement / Nutraceutical / Ayurvedic Medicine）、素食标志要不要抽？**
   - A（推荐）：第一期不抽，原图都在证据里，以后让视觉模型顺带读出作为可选字段；
   - B：第一期就抽，类别字样对区分「食品类保健品 vs AYUSH 药品」有用，但要新字段 + Supply Smart 接收。

## 8. 下一步（等决定后）

- 用这 20 个商品的原图跑一次视觉照抄回放（先定模型/effort/并发），验证 §4 第 2、3、5 项改动后的版式 A/B 读取率；
- 按 §6.1 改交付层，用测试库验收（同 ASIN 美印两条 listing、国家筛选）。

## 9. 多国家标签格式：第一部分已实现（2026-11-05）

用户 11-05 定的做法：站点只影响标签这一步，规则写成「标签格式」配置，以后加日本、加拿大只需加配置和样例表。

**结构**（`packages/v3-contracts/src/label-formats.ts`）：
- 每种格式一份，名字带版本：`us-facts/1`、`in-nutritional-information/1`、`in-composition/1`。一份格式包括挑图关键词、各列表头的角色（每份用量 / 固定基准用量如每 100 g / 百分比列及其口径 `us_dv` 或 `in_rda`）、表头行、跳过行、份数行、「Each … contains」、「prepared from」，以及给视觉照抄提示词追加的几行。
- 站点到格式的对应写在 `MARKETPLACE_LABEL_FORMATS`：`amazon.com` 只用美国格式；`amazon.in` 用美国格式加两种印度格式，因为印度站也卖进口美国货。
- 哪一列算 %DV、哪一列算 %RDA，看印出来的表头，不看站点。

**怎么一路传下去**：
- 标签任务（`LabelPlanInputSchema` / `LabelTaskSchema`）上多一个可选的 `labelFormats`。
- 挑图时按这些格式选关键词表，用新版本 `label-keywords/2`，表里写明格式。
- 选中结果本来就带着关键词表，所以视觉照抄的提示词和照抄后的代码解析直接从选中结果里取格式。
- 照抄答案里存一份 `formats`，以后重新解码时还按同样的格式读。

**印度表怎么读**（`label/transcript/format-panel.ts`）：
- 按 `columnHeaders` 认列：用每份用量那一列，没有就用每 100 g 那一列；百分比只取第一列，男女两列 RDA 时取男。
- 表头行、「Nutritional Information」标题、「*RDA not established」脚注都去掉。
- 「Servings Per Pack」读成每瓶份数；「Each capsule contains」读成份量。
- 「Each 100 g is prepared from」这种生药投料量不按配方读，交回原来的整张读图协议处理。
- 某一行对不上表头时，同样交回原来的协议。
- 读出来的那一列带上 `dailyValueHeading`，内容是印出来的百分比表头原文（如 `%RDA`），一路带到交付给 Supply Smart 的 label 里。

**美国不变**（都有测试）：
- 没有 `labelFormats` 时，以及格式只有美国一种时：关键词表就是原来的 `label-keywords/1`，提示词逐字节相同，答案里没有 `formats`，挑图 activity 的入参也和原来一样，所以 Temporal 回放不受影响。
- 读图、文字、ingredient-presence 三套模型配置的指纹都和 main 相同。`dailyValueHeading` 不进任何发给模型的输出格式。
- 全量单测和干净 main 相比没有多挂一个。main 上原本就挂的有两类：指纹测试的期望值本身已过时；`tools/diag-corpus` 本地测试数据不在 git 里。

**还没做**：
- 还没有渠道会设置 `labelFormats`，要等 amazon.in 渠道接进来（`amazon-in` 渠道、ScraperAPI `country_code=in`、价格用 `priceToPay`）。
- 交付层还要每次提交都带 `marketplace`，按站点分 run。
- 重新处理已存来源（`saved-source-tasks.ts`）还是用美国关键词表重新核对。等印度有已存来源后要跟着带上格式。
- 页面 HTML 文字表那条路还只认美国格式。印度页面基本不印完整的表，先不动。
- Supply Smart 侧：`dailyValueHeading` 的接收和按口径分开存放，由 Supply Smart 的 worktree `KAN-243-india-label` 在做。他们上线前，我们发过去的这个字段会被他们的 `z.object` 静默丢掉，不会报错。
- 日文、法文：关键词还只许英文字母，要等对应格式加进来时再放开，并按语言换匹配方式。

## 10. 第二部分计划：接 amazon.in 渠道 + 跨站判同（待用户批准，2026-11-05）

本节只是计划，批准前不写代码。依据：设计稿 `docs/plans/KAN-243-india-amazon-design.md`（worktree `bs-kan243-india-design`）§3.1 / §5 第一期，本文 §4 / §6.1，以及和 Supply Smart 定下的跨站判同契约 v2.3（Supply Smart 侧草案 `KAN-243-crossMarket-contract-draft.md`）。

### 10.1 已经定的

- 渠道用设计稿做法 A：新渠道 `amazon-in`，现有美国数据一行不动。
- 交付每次都带 `marketplace`，一个 run 只有一个站点。印度先只推 Supply Smart **测试库**。
- 同 ASIN 在别国已有挂牌时，由爬虫判断是不是同一个东西（`same` / `different` / `unsure`），结论放在 batch item 的 `crossMarket` 上，标签请求不带。Supply Smart 只在第一次建挂牌时按结论执行。
- 两个方向都要判：谁后建谁带结论。所以美国的新 ASIN 交付前也要先查。
- 判断用的 Codex 模型和读标签的一样，复用同一份配置（用户 11-05）。
- 爬虫手里没有美国侧的对比材料时，先去 amazon.com 重新抓一次。这次抓取作为新观测存档，照常走 24 小时准入，抓到后再判断；抓不到或页面不可用才发 `unsure`（用户 11-05）。
- Supply Smart 库里现在没有印度数据，不用处理存量（用户 11-05）。

### 10.2 要做的（按层）

| # | 层 | 内容 | 复用 |
|---|---|---|---|
| 1 | channels/amazon | `amazonMarketplaceAdapter(site)` 工厂。站点配置包括：`channel`、`origin`、国家、币种、货币符号、日期格式（`d MMMM yyyy`）、邮编（6 位）、非保健品类目表、ScraperAPI `country_code`。价格只读 `priceToPay` 的 whole+fraction，不取「第一个非空价格」（§4 范围外表）。新读 GTIN / UPC 行。 | 选择器、图库、变体、BSR、徽标、验证页处理全部共用美国代码 |
| 2 | channels → label | `amazon-in` 的标签任务按 `MARKETPLACE_LABEL_FORMATS["amazon.in"]` 设置 `labelFormats` | 第一部分已做的格式机制 |
| 3 | database 迁移 | 各表 channel CHECK 加 `amazon-in`（027/028/029/032/061 一处迁移） | — |
| 4 | 全仓 | 写死 `"amazon"` 的 15 处判断，逐个定是「仅美国」还是「亚马逊系」（§6.1 末行）。HTML 复用、`other-offer-retry`、label 请求剥 `salesRank` 这类属于亚马逊系 | — |
| 5 | product-sync / listings | `marketplace` 写进 run、item、label listing、listing-state；`clientRef` 哈希加上 marketplace；按站点分 run；`marketplace_invalid` 记成失败、不重试；按站点选 Supply Smart 目标（见 10.2a） | §6.1 ①–④；label 请求体剥字段时显式保留 marketplace，并加整请求测试（10-27 教训） |
| 6 | 跨站判同（新步骤） | 见 10.3 | Codex app-server 客户端、标签模型配置、R2 证据读取 |
| 7 | 重新处理已存来源 | `saved-source-tasks.ts` 重新核对时带上这个来源的格式 | 第一部分 |

### 10.2a 正式库和测试库（2026-11-05 核实）

爬虫现在只连一个 Supply Smart：Server 一 的 `worker.private.json` 和 `api.private.json`（`manual-releases/deploy-r46`）用同一份私有文件 `manual-releases/brand-enrichment/.env.brand-enrichment`。文件里只有一组地址和一个密钥，指向正式环境 `https://app.supplysmart.net/api/rpc` 和 `https://app.supplysmart.net/api/database/rpc`。商品推送、上下架状态、品牌补全、每周报告都走这一个连接（`packages/adapters/src/supply-smart/brand-enrichment-secrets.ts`）。

要做到「印度先推测试库、美国照旧推正式库」，做法如下：
- 商品推送的配置按站点选目标：`amazon.com` 用现在这份正式库文件，`amazon.in` 用一份新的测试库私有文件（地址和测试库密钥，只经 SCP 放到服务器）。配置里没写的站点一律不推。
- 跨站判同那一步的查询（`getCrossMarketListings`），跟着这个站点的推送目标走。
- 品牌补全和每周报告不变，仍只连正式库。
- 印度验收通过后，只要把 `amazon.in` 的目标改成正式库，不改代码。

不新增外部库：这些都是站点配置、映射和流程编排，现有框架（Temporal、zod、Codex 客户端）已经够用。

### 10.3 跨站判同步骤

放在商品处理完成之后、交付之前。它是产品流水线里的一步，结论存进爬虫库，交付层只负责把存下的结论映射到 `crossMarket`。判断不放在 product-sync 里，因为 product-sync 只做映射和发送。

1. 交付前一次批量查询 Supply Smart `product.getCrossMarketListings({ channel, externalIds })`，一次 1–200 个。查不到别国挂牌 → 不带字段，照常交付。
2. 查到了 → 找对比材料：
   - 先用爬虫自己存的那个市场的采集记录，包括原始 HTML、图库和配方；
   - 没有 → 给那个市场排一次商品抓取（新观测），这条商品的交付先缓，等抓取有结果再判断；
   - 抓不到或页面不可用 → `unsure`。
3. 判断：
   - **确定性规则**，只会给出 `same`。候选有两条，要先在真实样本上验证才能用：
     - 两边标签图是同一个 Amazon 图片 ID；
     - 两边配方逐行一致（成分名归一化后相同、剂量和单位相同、份量相同）。
   - 其余交给 Codex。它看两边的标签图、标题、品牌，以及印度页面上的进口商或生产商信息，给出 `same` / `different` / `unsure` 和原因码。
4. 结论存一条记录：结论、比对的挂牌 `listingId`、方法、模型、原因码、对比材料快照的 R2 引用、时间。结论不覆盖，重新判断时写新记录。

### 10.4 要用户决定

1. **印度商品要不要复用美国配方？** 设计稿 §3.1 原来打算让 `amazon-in` 和 Whole Foods 一样用 `formulaFamily: "amazon-asin"`，同 ASIN 直接复用美国配方，不再 OCR。有了判同以后，二者必须一致，否则判成 `different` 的印度商品会挂着美国配方。
   - A（推荐）：先判同，`same` 才复用美国配方；`different` / `unsure` 照常读印度标签。这样省掉进口货的 OCR，也不会把美国配方错挂到本地版上。代价是判同要提到读标签之前，只能用图和标题判断，配方逐行比对这条规则就用不上了。
   - B：一律先读印度标签再判同。规则能用，但进口货也要多跑一遍 OCR 和视觉。
2. **第一期范围**：按设计稿第一期做 Top 50 品牌（约 30 个本土 + 20 个国际），只推测试库，可以吗？
3. **Mini 上真实验证要花的 ScraperAPI 额度。** 按 AGENTS.md，先 1 个请求核对地区和单价，再跑 20 个商品端到端（每页 5 credits），然后才是品牌扫描。品牌扫描的量开跑前另报。

### 10.5 顺序和验收

1. 渠道和迁移（10.2 第 1–4 项）→ 单测加 1 个真实请求。
2. 交付层（第 5 项）→ 整请求测试；美国请求逐字节不变。
3. 跨站判同（第 6 项）。Supply Smart 的只读查询和 `crossMarket` 接收同时开工，用测试库联调。
4. 20 个商品端到端推测试库，按设计稿第一期的验证标准验收：页面字段 ≥ 95%、配方 ≥ 90%、美国渠道的表里没有一行来自 amazon.in、同 ASIN 美印两条挂牌各归其位。
5. 每一步结束都跑 `pnpm check` 并做独立审查，修完再进下一步。不部署、不重启 worker、不推正式库，这几件都要另行批准。

### 10.6 实现记录（2026-11-05）

用户在 11-05 改选 10.4 第 1 项的 **B**：印度标签照常读，在交付前判同。原因是 A 的判同发生在读标签之前，那时只能拿整套印度图库去比，视觉调用的成本和读一遍标签差不多，A 想省的部分省不下来。印度商品不复用美国配方，`amazon-in` 有自己的配方族。

- 第 1 步（`c4fcacac`）：`amazon-in` 渠道、迁移 071、按站点生成 adapter。
- 第 2 步（`24023919`）：按 Supply Smart 渠道 `amazon` 加 `marketplace: "amazon.in"` 交付；`productSync.targets` 按站点选目标库；按目标库的域名重新查公司；印度不套美国销量曲线。
- 第 3 步：跨站判同（`packages/app/src/cross-market/`，迁移 072 `cross_market_check`，只追加）。
  - 只在有目标库、带判同检查的站点生效（`amazon-in`），在 product-sync 发送前做。
  - 先用目标库的 `getCrossMarketListings` 批量查同 ASIN 在别国的挂牌。查不到就不带字段。
  - 查到了：取爬虫自己存的那个站点（`amazon`）同 ASIN 的已采集商品。两边配方逐行一致、份量相同 → `same`（`rule`）；否则交给标签模型（`processing.codex.vision` 的模型和强度）做一次不带工具的文字判断，输入是两边的标题、品牌、份量、配方行和其他成分，结论是 `same`、`different` 或 `unsure`，原因码从固定列表里选。
  - 爬虫没有对方站点的材料：用同一个爬虫品牌在那个站点的 source 排一次抓取（每个 ASIN 只排一次），这条印度商品先不发，最多等 3 天。
  - 没法判断时**不带字段**，原因记在爬虫自己的记录里。没法判断的情况包括：没有 source 可排、3 天内没等到、对方商品没有标签。不带字段在 Supply Smart 的行为和 `unsure` 相同。爬虫不会发一个没有模型判断、却标着 `method: "codex"` 的 `unsure`。
  - 判同结论只放在 batch item 上，标签请求不带（`deliveryLabel` 显式剥掉）。

**还没做 / 要注意：**
- 反方向（美国新 ASIN 交付前先查印度挂牌）还没接。现在印度只在测试库，正式库里没有印度挂牌，而且正式库还没部署 `getCrossMarketListings`。等 amazon.in 上正式库时，再给 `amazon` 目标加上同样的检查。
- 判断用的材料里还没有印度页面上的进口商、生产商信息（它们在商品详情区，不在已采集的标签里）。
- 爬虫品牌在 amazon.com 没有 source 的本土品牌，排不了美国抓取，只能不带字段。

## 证据位置

- ScraperAPI 原件：R2 `supply-smart-test` 桶 `research/kan243-india/scraperapi/`（5 个 `.html` + `.json`，已回读校验）；Server 一 `~/kan243-research/scraperapi/`。
- OCR 结果：Server 一 `~/kan243-research/ocr/*.json`。
- Ego 页面 DOM、173 张图、拼图：会话临时目录（不进 git）。
- 参考：
  - [FSS Nutra Regulations 2022 草案](https://foodsafetyworks.com/news/fssai-draft-regulations-fss-nutra-regulations-2022)
  - [India health supplement regulation（ChemLinked）](https://food.chemlinked.com/foodpedia/india-health-supplement-regulation)
  - [FSSAI 2022-02 RDA 指示](https://mail.fssai.gov.in/upload/media/FSSAI_NEws_RDA_17_02_2022.pdf)
  - [Labelling & Display Regulations 2020 解读](https://freyrsolutions.com/blog/decode-the-fssais-new-labeling-display-regulations)
  - [Ayurvedic drug labelling（Mondaq）](https://mondaq.co.uk/india/healthcare/1043160/labelling-requirements-of-ayurvedic-drugs)
