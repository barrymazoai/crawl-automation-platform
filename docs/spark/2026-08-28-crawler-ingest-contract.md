# 07 — 爬虫入库契约：`ingestObservationBatch` 与 AI 抽取规范

> 面向爬虫 / Mac mini 处理节点。真源在本仓库 `packages/database-api/src/schemas/product-ingest-schema.ts`，
> 本文是它的人话版。规则背景见 [06-cross-channel-identity.md](06-cross-channel-identity.md)。
> 状态：已上线代码（SUPPLYSMAR-318，2026-08-28）；存量数据的清洗回填另行统一处理，本文只管**新观测**。

## 0. 一句话

爬虫只提交「**看到了什么**」+「**本轮是否完整枚举**」。身份解析（这是哪个 product / 要不要新建）、状态转换（上架 / 下架）、事件派生（首见 / 新挂牌 / 价格变动）全部在库内完成。爬虫**不要**自己判断同品、不要自己拼 `variant_key`、不要直接调任何「建事件 / 置 inactive」的接口。

## 1. 调用顺序

```
POST /rpc/product/ingestObservationBatch     ← 一批 ≤ 200 个 SKU，每个 item 独立成败
POST /rpc/product/verifyObservationBatch     ← 只读回读；verified == expected 且 problems=[] 才算入库成功
POST /rpc/product/completeCrawlRun           ← 只有 run.scope='full' 且回读通过才调；partial 调了也不会下架
```

所有 procedure 都挂在 product-server 的 oRPC 下：`POST /rpc/product/<name>`，body 为 JSON。

## 2. `ingestObservationBatch`

### 2.1 请求

```jsonc
{
  "run": {
    "runId": "gnc-optimum-2026-08-28T01",     // 你的批次 ID。幂等键：重试同一 run 复用同一行
    "channel": "gnc",                         // 小写渠道名；"database" / "unknown" 会被拒
    "scope": "partial",                       // "full" | "partial"（见 §5）
    "siteKey": "optimumnutrition.com",        // 可选。per-site 渠道（dtc / 品牌官网）的站点域名 eTLD+1
    "companyDomain": "optimumnutrition.com",  // 可选。品牌页 / 官网所属公司的官网域名；item 没给 domain 时也用它
    "startedAt": "2026-08-28T01:00:00Z",      // 本轮开始时间（缺席判定的分界）
    "source": "crawl-automation:gnc-optimum-2026-08-28T01"   // 进 snapshot.source
  },
  "items": [ /* ≤ 200 个，见 2.2 */ ]
}
```

- **`scope: "full"` 必须带 `companyDomain` 或 `siteKey`**，否则 400。裸 channel 级 full 会把别家的 listing 一起判缺席。
- `siteKey` 不传时由 `channel + companyDomain` 推导；marketplace 渠道（amazon / gnc / iherb / walmart / costco / target / cvs / vitacost / swanson / wholefoods / chewy / tiktok）恒为 NULL，传了也忽略。**不在这个名单里的渠道一律按 per-site 处理**，必须给得出站点域名。

### 2.2 单个 item

```jsonc
{
  "clientRef": "gnc:379969",                  // 必填。你的句柄，回读用。不是去重键：同 run 重复 ref 后写覆盖台账
  "domain": "optimumnutrition.com",           // 可选，缺省 run.companyDomain。产品所属**品牌**的官网域名，不是零售商域名
  "productName": "Gold Standard 100% Whey Vanilla Cream 4 lb",   // 必填。渠道页标题或清洗后的完整品名
  "productUrl": "https://www.gnc.com/.../379969.html",           // 可选。商品详情页
  "titleRaw": "GNC 页面原始标题",              // 可选。归属修正依据，原样

  // ── listing 锚点（至少一个能用）──
  "externalId": "379969",                     // 渠道内稳定 ID：ASIN / GNC SKU / Shopify variant id。有则**必传**
  "sourceUrl": "https://www.gnc.com/.../379969.html?variant=...",   // 渠道页 URL；没 externalId 时靠它规范化后做锚点
  "siteKey": "brand.com",                     // 可选，覆盖 run.siteKey（一个 run 混多个站点时才需要）

  // ── 观测（本次看到的数字）──
  "capturedAt": "2026-08-28T01:23:45Z",       // 必填。**实际看到页面的时间**，不是清洗或入库时间
  "price": "74.99", "currency": "USD", "listPrice": "89.99",
  "rating": 4.7, "reviewCount": 1000, "salesRank": 1234,
  "inStock": true,                            // false 只表示缺货，**不表示下架**
  "unitsSold": 500, "unitsSoldPeriod": "trailing_30d",   // 周期必须配：trailing_30d | monthly | lifetime | unknown
  "extras": { "categoryPath": ["Protein","Whey"], "subscribePrice": "67.49", "prime": true },   // 渠道异构字段，随便放
  "listedAt": "2024-03-01T00:00:00Z", "listedAtSource": "amazon_dfa",   // 渠道声明的上架时间；只补空不覆盖

  // ── 语义（走现有词表）──
  "productForm": "Powder",                    // 剂型原文
  "healthFunctions": ["Muscle Recovery"],
  "mainIngredients": ["Whey Protein Isolate", { "name": "Lecithin", "substance": "Soy Lecithin" }],

  // ── 身份（AI 抽取，见 §3）──
  "gtin": "048107252779",                     // 8 / 12 / 13 / 14 位数字。页面能拿到就传（GNC 的 UPC 就是它）
  "baseName": "Gold Standard 100% Whey",      // AI 抽：产品线名
  "variant": { "flavor": "Vanilla Cream", "size": "4 lb", "form": "Powder" },   // AI 抽：变体原文，strict
  "variantConfidence": 92,                    // AI 自评 0–100；< 70 当未解析
  "variantSource": "ai_extract",              // ai_extract | channel_attrs | manual
  "attrsRaw": { "flavor": "Vanilla Cream", "size": "4 lb", "upc": "048107252779" },   // 渠道结构化字段原文，只存证据不参与判断

  // ── 图片 + 成分表 ──
  "images": [
    { "clientRef": "front-1", "url": "https://.../front.jpg", "role": "gallery" },
    { "clientRef": "facts-1", "url": "https://.../379969_lbl.pdf#page=1", "role": "facts" }
  ],
  "facts": {                                  // 可选。有标签 OCR 结果才传
    "sourceImageRef": "facts-1",              // 引用 images[].clientRef，入库后解析成真实 imageId
    "capturedAt": "2026-08-28T01:23:45Z",     // 缺省 = item.capturedAt
    "source": "crawl-automation:...:label_ocr",   // 缺省 = `${run.source}:facts`
    "confidence": 95,
    "servingSize": 1, "servingUnit": "scoop", "servingsPerContainer": 64, "netContent": "4 lb",
    "rows": [
      { "name": "Protein", "amountValue": 24, "amountUnit": "g", "dvPercent": 48, "position": 0, "isActive": true },
      { "name": "Proprietary Blend", "position": 1 },
      { "name": "Leucine", "amountValue": 5.5, "amountUnit": "g", "position": 2, "parentPosition": 1 }   // blend 子行
    ]
  }
}
```

字段级要求：

| 字段 | 必填 | 备注 |
|---|---|---|
| `clientRef` | ✅ | 同 run 内唯一才有意义；重复会覆盖 |
| `productName` | ✅ | 老的 name+company 兜底还在用它 |
| `capturedAt` | ✅ | ISO 8601 带时区 |
| `externalId` **或** `sourceUrl` | ✅ 至少一个 | 两个都没有 → item 失败 `no_anchor`。**有稳定 ID 必须传 ID**，别只传 URL |
| `domain` / `run.companyDomain` | ✅ 至少一个 | 是**品牌**的域名。GNC 上的 ON 产品，domain 是 `optimumnutrition.com` 不是 `gnc.com` |
| `variant` | 推荐 | strict：只允许 §3.2 列出的 7 个键，多一个键整个请求 400 |
| `gtin` | 推荐 | 跨渠道最硬的证据，页面有就传 |
| `baseName` | 推荐 | 没有它这条观测不进 family，退回老的 name+company 精确匹配 |

### 2.3 响应

```jsonc
{
  "runId": "...", "crawlRunId": "uuid",
  "counts": { "received": 48, "ok": 47, "failed": 1, "created": 12, "matched": 35, "needsReview": 3 },
  "results": [{
    "clientRef": "gnc:379969",
    "status": "ok",                            // ok | failed
    "productId": "uuid", "listingId": "uuid", "companyId": "uuid",
    "matchedBy": "variant_key",                // external_id | url | gtin | variant_key | name_company | created
    "identity": {
      "familyId": "uuid",
      "variantKey": "flavor=vanilla_cream|form=powder|size=1814.369g",   // 库算的，你不用管
      "state": "resolved",                     // legacy | resolved | variant_unresolved | needs_review
      "confidence": 90, "reasons": ["variant_key_hit"],
      "review": null, "reviewId": null,        // 判不准时这里有 {kind, matchedProductId, reasons}
      "familyCandidate": false
    },
    "observation": { "listingId": "uuid", "listingCreated": false, "snapshotInserted": true, "latestUpdated": true, "events": ["listing_new"] },
    "observationSkipped": null,                // no_channel | no_anchor
    "facts": { "formulaId": "uuid", "factsHash": "sha256", "observationInserted": true },
    "images": [{ "clientRef": "facts-1", "url": "...", "imageId": "uuid" }],
    "error": null                              // 失败时 { code: company_not_found | no_anchor | facts_failed | internal, message }
  }]
}
```

`matchedBy` 的含义：

| 值 | 意思 |
|---|---|
| `external_id` / `url` | 这条 listing 以前见过，直接是同一个 product。**变体信息此时不参与判断** |
| `gtin` | GTIN 命中已有 product（跨渠道复用） |
| `variant_key` | 同 family 内变体 key 精确命中（跨渠道复用） |
| `name_company` | 走了老的兜底（没传 baseName，或公司解析不出来） |
| `created` | 新建 product |

`identity.state`：

| 值 | 意思 | 你要做什么 |
|---|---|---|
| `resolved` | 变体解析成功 | 无 |
| `variant_unresolved` | `variant` 没传 / 有维度解析失败 / `variantConfidence < 70`；product 已建、挂在 family 下，但**永不自动合并** | 看 `identity.review.reasons` 里的 `unresolved: form,size` 修抽取 |
| `needs_review` | 有候选但被否决（GTIN 冲突 / 剂型冲突 / 配方冲突 / family 里有未解析的兄弟）；观测已落库、写了一条待审 | 无需处理；库侧审核 |
| `legacy` | 走了老路径 | 说明没传 baseName |

### 2.4 事务与幂等

- **每个 item 独立**：一个坏 item 只让它自己 `failed`，其余照常。
- **重放安全**：同一观测（同 listing + `capturedAt` + `run.source`）再发一遍不会重复写 snapshot、不会重复发事件；同一份 facts（同 `capturedAt` + `source` + listing）不会重复写观测。所以网络重试直接重发整批即可。
- **迟到观测可以发**：`capturedAt` 比库里最新的旧，会落快照但不会把「最新价」倒回去。
- item 之间串行处理，200 个约 20–60 秒，HTTP 超时给足。

## 3. AI 抽取规范（Mac mini 侧）

库侧**不调 LLM**。你负责把标题 / 页面结构化字段变成下面两样，库负责确定性归一与拼 key。

### 3.1 `baseName` —— 产品线名

从标题里**去掉**口味、规格、剂量、装数、包数、剂型、品牌前缀之后剩下的部分。

| 标题 | `baseName` |
|---|---|
| `Optimum Nutrition Gold Standard 100% Whey Protein Powder, Vanilla, 4 lb` | `Gold Standard 100% Whey` |
| `OLLY Blackberry Zen Restful Sleep Gummy, 10 CT` | `Blackberry Zen Restful Sleep` |
| `Natural Factors RxOmega-3 Ultra Strength 2,150 mg Fish Oil, 60 Softgels` | `RxOmega-3 Ultra Strength` |
| `THORNE Women's Multi 50+, 180 Capsules` | `Women's Multi 50+` |

规则：
- 保留会区分产品线的词：`Ultra Strength`、`50+`、`Gold`、`Plus`、`Kids`（它们是产品线不是变体）。
- 品牌词留不留都行——库会按公司名剥掉**开头**的品牌前缀；但不要把品牌塞到中间。
- 同一个产品线在不同渠道要抽出**同一个** `baseName`（大小写、标点、空格无所谓，库做字形归一）。这是跨渠道合并的第一把钥匙：抽不一致 = 两个 family = 永远合不上。
- 抽不出来就**不传**，不要编。不传的后果只是走老路径，传错的后果是建错 family。

### 3.2 `variant` —— 变体维度原文

只允许这 7 个键，**strict**，多一个键请求整个 400：

| 键 | 传什么 | 例 | 库如何归一 |
|---|---|---|---|
| `flavor` | 口味原文 | `"Vanilla Cream"` | 只做字形归一：`vanilla_cream`。**不做语义合并**，`Vanilla Cream` ≠ `Vanilla` |
| `size` | 净含量 / 装数原文，或 `{value, unit}` | `"4 lb"` `"120 Count"` `"16 fl oz"` `{"value":4,"unit":"lb"}` | 重量→g、体积→ml、计数→count |
| `servings` | 每容器份数 | `64` 或 `"64 Servings"` | 整数 |
| `pack` | 多联包数量 | `"Pack of 2"` `2` | 整数。**不传不等于 1** |
| `strength` | 单份剂量档 | `"1000 mg"` `"5,000 mcg"` `"1000 IU"` | mg 系换算到 mg；IU / CFU 保留原单位 |
| `edition` | 产品线修饰词（只在它确实区分 SKU 时） | `"Gold"` `"Kids"` | 字形归一 |
| `form` | 剂型 | `"Capsules"` `"Softgel"` `"Powder"` | 封闭词表归一（capsule / tablet / softgel / gummy / chewable / powder / liquid / oil / spray / lozenge / stick_pack / sachet / soft_chew / tea / bar / pellet / gel / cream）。表外 → 该维度解析失败 |

硬规则：
- **每个维度要么给干净的单值，要么不给**。`"Liquid,Capsule,Softgels"`、`"Item weight400.0 grams"` 这类脏值会让**整条**观测判为未解析（宁可 NULL 也不产生错 key）。
- **只传页面上明确写了的维度**。缺口味就不传 flavor，不要猜 `"Unflavored"`。「省略」本身是身份的一部分——`form=capsule` 和 `form=capsule|flavor=vanilla` 是两个 SKU。
- 渠道有结构化字段（GNC 的 flavor / size、Shopify 的 variant options）优先用它们，`variantSource: "channel_attrs"`；只有标题可用时才让 AI 抽，`variantSource: "ai_extract"`。
- `variantConfidence` 如实给。低于 70 库当未解析处理——**宁可进 review 也不要产错 key**。
- Amazon 现有 `label` / `pack` 两个老字段：`label` 里的是剂型（Capsule / Powder…），放 `form`；`pack` 是 Unit Count（`"90 Count"` / `"14.8 Ounce"`），放 `size`。它们不再直接进库参与判断，原文可以放 `attrsRaw`。

### 3.3 `gtin`

GNC 页面的 `mpn` / UPC、Amazon 详情页偶尔露出的 UPC / EAN 都是它。8 / 12 / 13 / 14 位纯数字，别带空格连字符。**这是唯一能跳过变体判断直接确认同品的证据**，能抓就抓。

### 3.4 `facts.rows`

- `name` 标签原文；`amountValue` + `amountUnit` 照录（`mg` / `mcg` / `g` / `IU` / `CFU` / `%`），库做换算；没剂量就不传 amount（proprietary blend 子行常见）。
- `position` 从 0 起按标签顺序；blend 子行用 `parentPosition` 指向父行的 position。
- `isActive: false` 标 Other Ingredients。
- **都没剂量的成分表也要传**，但库会把它标成「无剂量证据」——它能建配方，但不会被当成跨渠道判同品的强证据。

## 4. `verifyObservationBatch`

```jsonc
// 请求
{ "runId": "gnc-optimum-2026-08-28T01",
  "clientRefs": ["gnc:379969"],                // 可选，缺省整个 run
  "expect": [{ "clientRef": "gnc:379969", "price": "74.99", "imageCount": 2, "factsHash": "sha256" }] }   // 可选
// 响应
{ "found": true, "run": { "status": "open", "scope": "partial", "itemsReceived": 48, "itemsOk": 47, "itemsFailed": 1, "itemsNeedsReview": 3 },
  "verified": 47, "expected": 48,
  "items": [{ "clientRef": "...", "recorded": true,
              "ledger": { "status": "ok", "matchedBy": "variant_key", "identityState": "resolved", "variantKey": "...", "error": null },
              "product": { "id": "...", "familyId": "...", "variantKey": "...", "identityState": "resolved", "formulaId": "...", "gtin": "..." },
              "listing": { "id": "...", "status": "active", "lastSeenAt": "...", "latestSnapshotAt": "...", "latestPrice": "74.99", "latestCurrency": "USD", "imageCount": 2 },
              "latestFormulaHash": "sha256",
              "mismatches": [{ "field": "price", "expected": "74.99", "actual": "72.99" }],
              "problems": [] }],                // not_recorded | ledger_failed | product_missing | listing_missing | needs_review | facts_not_latest
  "problems": ["run_not_completed"],
  "readbackHash": "sha256" }
```

门禁：**`verified == expected` 且每个 item 的 `problems` 为空** 才能进 full-crawl 收口和本地临时文件清理。`needs_review` 也算 problem——有待审项的 run 不要声明 full。

## 5. `completeCrawlRun` 与 full / partial

```jsonc
{ "runId": "gnc-optimum-2026-08-28T01", "completedAt": "2026-08-28T02:00:00Z", "status": "completed" }   // status: completed | aborted
// → { "found": true, "replayed": false, "scope": "full", "status": "completed", "deactivated": 3, "deactivatedListingIds": ["..."], "problems": [] }
```

- scope / company / site / `startedAt` **全部取库里 run 的记录**，请求里不用也不能再传。
- `partial` 或 `aborted`：只标完成，**一条都不下架**。
- `full`：run 的 company（或 site）范围内、`lastSeenAt < run.startedAt` 且本轮没见到的 listing 置 inactive，各发一条 `delisted`。
- 同一 run 再调 → `replayed: true`，不重复下架、不重复发事件。

**只有同时满足才能声明 `full`**：输入是可定义边界的品牌页 / 店铺目录 / 官网全目录；分页 / Load More / 品牌导航程序化耗尽；没命中数量上限；没有 challenge / 登录墙 / 区域错误；所有变体都成为独立 item；`verifyObservationBatch` 全部通过且无 `needs_review`。任一不满足就是 `partial`。当前 Amazon Brand Store、GNC 品牌页和 Swanson 品牌筛选页共用同一门禁；单品页和普通搜索页永远 partial。DTC 也只有全目录门禁通过才可 full。

## 6. 不要做的事

- 不要自己判断「这是不是同一个产品」再决定传不传——每个变体都作为独立 item 发，库来判。
- 不要自己拼 `variant_key` 或传 `variantKey` 字段（schema 里没有，会 400）。
- 不要把零售商域名当 `domain`（GNC 上的产品 domain 不是 `gnc.com`）。
- 不要在 `variant` 里塞 7 个键以外的东西（`upc` → `gtin`，`category` → `extras`，其余 → `attrsRaw`）。
- 不要调 `completeFullCrawl`（老接口，无 run 记录）、`markStaleListings`（库内定时任务）。
- 不要因为 `inStock: false` 就不发这条观测——缺货也是观测，只有 full crawl 的缺席才是下架。

## 7. 与老接口的关系

`product.enrich` / `product.submitFacts` 仍可用（老管线不改也不会出错），但它们没有 run / 台账 / 图片 clientRef 回传 / 独立回读；新管线一律走本文的三个接口。

## 8. 一个最小完整示例（GNC，partial）

```jsonc
POST /rpc/product/ingestObservationBatch
{
  "run": { "runId": "gnc-on-20260828-1", "channel": "gnc", "scope": "partial",
           "companyDomain": "optimumnutrition.com", "startedAt": "2026-08-28T01:00:00Z",
           "source": "crawl-automation:gnc-on-20260828-1" },
  "items": [{
    "clientRef": "gnc:379969",
    "productName": "Gold Standard 100% Whey Vanilla Cream 4 lb",
    "externalId": "379969", "sourceUrl": "https://www.gnc.com/whey-protein/379969.html",
    "capturedAt": "2026-08-28T01:23:45Z",
    "price": "74.99", "currency": "USD", "inStock": true,
    "productForm": "Powder", "mainIngredients": ["Whey Protein Isolate"],
    "gtin": "048107252779",
    "baseName": "Gold Standard 100% Whey",
    "variant": { "flavor": "Vanilla Cream", "size": "4 lb", "form": "Powder" },
    "variantConfidence": 95, "variantSource": "channel_attrs",
    "attrsRaw": { "flavor": "Vanilla Cream", "size": "4 lb", "upc": "048107252779" },
    "images": [{ "clientRef": "facts-1", "url": "https://www.gnc.com/dw/379969_lbl.pdf", "role": "facts" }],
    "facts": { "sourceImageRef": "facts-1", "confidence": 95, "servingSize": 1, "servingUnit": "scoop", "servingsPerContainer": 64,
               "rows": [{ "name": "Protein", "amountValue": 24, "amountUnit": "g", "position": 0 }] }
  }]
}
→ verifyObservationBatch { "runId": "gnc-on-20260828-1" }   // verified == expected && problems=[] ?
→ completeCrawlRun { "runId": "gnc-on-20260828-1", "status": "completed" }   // partial：只标完成
```
