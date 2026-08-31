# 统一渠道观测、跨渠道同品归并与 Listing 生命周期接口需求

日期：2026-08-28  
状态：分析稿，供 Product DB / Database API 实现评审  
范围：Amazon、GNC、后续固定 Sales Channel，以及 DTC 官网

## 1. 结论

Amazon、GNC、其他零售渠道和 DTC 应共用一套产品观测模型。DTC 不是另一套数据结构，只是一个需要额外站点命名空间的特殊 Sales Channel。

当前 Jakarta 已经具备 `product`、`product_channel`、`listing_snapshot`、`formula`、`formula_observation` 和 `product_change_event` 等核心结构，也已有 `product.enrich`、`product.submitFacts`、`product.completeFullCrawl`、`product.markStaleListings` 四个接口。但是，若要让自动爬虫安全地完成跨渠道入库、上新/下架判断和同品归并，还缺少以下关键能力：

1. 一个同时接收 Listing、快照、图片、语义和可选 Facts 的统一批量观测接口。
2. DTC 站点命名空间，避免不同官网的相同站内 ID 在 `(channel, external_id)` 上撞号。
3. 跨渠道同品解析：品牌相同、完整配方相同、form 相同、名字相似且规格不冲突时，把新 Listing 挂到已有 `product`，而不是每个渠道创建一个重复产品。
4. 可审计、无损、事务化的产品合并能力，处理先建临时产品、后取得 Facts 的场景。
5. Full crawl 运行记录与作用域，保证缺席判定只影响本次真正完整枚举的品牌/店铺/官网范围。
6. Facts 观测的数据库级幂等键，以及图片 ID 的可靠回传/引用。
7. 批量回读验收接口，不能只以“API 返回 200”判断入库成功。
8. `listedAt`、GTIN、SKU、`listing_snapshot.extras`、品牌原文等现有模型需要但当前写入契约没有完整承接的字段。

最重要的边界是：爬虫只提交“看到了什么”和“本轮是否完整枚举”，数据库负责身份解析、当前态物化、状态转换和事件派生。不要向爬虫暴露“直接创建 listing_new 事件”或“直接把 Listing 改成 inactive”之类的底层写接口。

## 2. 统一概念

### 2.1 Product

`product` 是 SKU 粒度的实体，是跨渠道共享的物理商品身份。

- 同一个物理 SKU 同时出现在 Amazon、GNC 和品牌官网：一条 `product`，三条 `product_channel`。
- 不同口味、剂量、净含量、瓶数或包装规格：分别是独立 `product`。
- 明确属于同一产品系列的不同 SKU：通过 `product_family` 关联，不应直接合并。

### 2.2 Listing / Product Channel

`product_channel` 是某个产品在某个销售渠道上的具体挂牌页面。

- Amazon 的稳定锚点是 ASIN。
- GNC 的稳定锚点是 GNC SKU。
- DTC 的稳定锚点必须包含站点命名空间，例如 `motherspromise.com:shopify_variant:123456`；不能只写 `channel=dtc, externalId=123456`。
- 同一产品可以有多条 Listing；同一渠道也可能有多个合法 Listing。

### 2.3 Listing Snapshot

`listing_snapshot` 是一次页面观测，只追加，不覆盖：

- `captured_at` 是实际看到页面的时间，不是清洗或入库时间。
- 幂等键是 Listing + `captured_at` + `source`，重试不能产生重复快照。
- 价格、评分、评论数、库存、销量都属于 Listing 的时间轴。
- `in_stock=false` 只代表缺货，不代表 Listing 下架。

### 2.4 Formula Observation

`formula` 是内容寻址的不可变配方；`formula_observation` 是某次从标签中观察到该配方的事实。

跨渠道同品判断所说的“成分一模一样”，在自动合并路径中应解释为完整 `formula_id` / `facts_hash` 相同，即结构化成分、每份剂量和 serving 语义相同，而不只是成分名称集合相同。仅成分集合相同可能把 `Biotin 5,000 mcg` 与 `10,000 mcg` 错合。

现有 formula 哈希不包含 `servings_per_container`，因此即使 formula 相同，也必须额外检查净含量、每容器份数、pack、flavor 等 SKU 规格冲突。

### 2.5 Change Event

`product_change_event` 是由观测派生的查询缓存，不是爬虫直接提交的事实：

| 事件 | 正确来源 |
|---|---|
| `first_seen` | 第一次创建最终产品身份 |
| `listing_new` | 已有产品第一次出现新的渠道 Listing |
| `price_up` / `price_down` | 同一 Listing 的相邻价格观测 |
| `formula` | 同一产品的相邻配方观测 |
| `delisted` | 成功完成的 full crawl 中，已知 Listing 在同一作用域缺席 |
| `succession` | `product.succeeded_by_id` |

重新看到 `stale` / `inactive` Listing 时，Listing 应恢复为 `active`。如果产品界面需要明确展示“重新上架”，应新增 `relisted` 事件；如果不需要，恢复 active 但不发新事件也可以。这个选择应由 Product DB 定义，不能由各爬虫自行决定。

## 3. 跨渠道同品判断

### 3.1 匹配顺序

按以下顺序解析最终 `product_id`：

1. **已有 Listing 精确命中**：渠道 + 站点命名空间 + external ID。
2. **规范化 URL 命中**：仅作为没有稳定 ID 时的兜底。
3. **GTIN 精确命中**：GTIN 相同且品牌无冲突时是强证据；仍需防止脏 GTIN。
4. **跨渠道内容匹配**：品牌相同 + 完整 formula 相同 + canonical form 相同 + 名字相似 + SKU 规格无冲突。
5. 无法高置信匹配：创建临时独立产品并输出待审候选，不允许静默合并。

SKU 不能作为跨渠道唯一匹配键。Amazon ASIN、GNC SKU、品牌方 SKU 的命名空间不同，零售商也可能自建 SKU。

### 3.2 “品牌相同”的定义

不能只检查最终 `company_id`。Jakarta 会把没有独立业务数据的 Sub-brand 通过 `brand_of` 解析到母公司；同一母公司的两个不同品牌不应因此被视为品牌相同。

观测接口至少需要同时保存：

- `companyId`：数据库解析后的归属公司；
- `brandRaw`：页面原始品牌名；
- `brandKey`：标准化后的品牌键，或明确的 Sub-brand ID。

自动归并要求 `brandKey` 相同，或数据库存在明确等价关系。只有母公司相同但品牌不同，只能进入候选，不自动合并。

### 3.3 名称相似与冲突护栏

可沿用 Jakarta 现有去重文档的口径：

- 归一化同名：高置信。
- trigram 相似度不低于 0.8，或一个标题包含另一个：进入高置信判断。
- 名称的一方省略品牌、剂型或规格，不视为冲突。
- 两边都出现但值不同的剂量、口味、数量、净含量、pack、年龄/人群、版本词，视为明确冲突。

建议自动合并门槛：`same=true && confidence>=90`。低于门槛只生成审核候选。

### 3.4 Form 判断

form 必须使用数据库 canonical form ID 或确定无歧义的 canonical name 比较，不能直接比较模型输出的自由文本。

- 两边 form 集合相同且非空：满足自动判断条件。
- 任一方没有 form，或某产品同时挂了多个互相冲突的 form：进入审核。
- product form 当前是只增不减的 M2M 关系；因此接口需要返回 canonical form ID，并避免低置信结果污染 form 集合。

### 3.5 合并与 Family 的边界

| 情况 | 动作 |
|---|---|
| 同一物理 SKU 出现在不同渠道 | 合为一个 `product`，增加 Listing |
| formula 相同，但 30 servings 与 60 servings 冲突 | 两个 `product`，可归同一 family |
| formula 相同，但 flavor 不同 | 两个 `product`，可归同一 family |
| 品牌相同、名字相似，但 formula 不同 | 不合并 |
| 品牌不同，即使 formula 相同 | 不自动合并 |
| 只有成分名称集合相同，没有剂量/serving 证据 | 只做候选，不自动合并 |

## 4. 当前 Jakarta 已有能力与缺口

| 能力 | 当前状态 | 主要缺口 |
|---|---|---|
| `product.enrich` | 已有 | Listing 快照可写，但跨渠道只按同名+公司兜底；缺 GTIN、品牌键、listedAt、extras；图片只返回数量 |
| `product.submitFacts` | 已有 | 能写 formula/observation，但没有数据库级重试幂等键；`imageId` 无法从 enrich 响应可靠取得；不触发跨渠道归并 |
| `product.completeFullCrawl` | 已有 | 作用域只有 channel + 可选 companyId；没有 run/scope 观测记录和完整性证明 |
| `product.markStaleListings` | 已有 | 适合作为数据库内部定时任务，不应由每个爬虫任意调用 |
| 产品跨渠道候选解析 | 缺失 | 当前新渠道容易新建重复 product |
| 产品无损合并 API | 缺失 | 只有历史 SQL 脚本，未形成正式 Drizzle schema / DAO / oRPC 契约 |
| Family 写入 API | 缺失 | 当前本项目通过直连 SQL 处理 family |
| 批量回读验收 | 缺失 | 当前只能自行直查数据库 |
| crawl scope/run 事实 | 缺失 | 无法完整重建多轮下架/复活历史，也无法安全区分不同品牌页/官网范围 |

另外，线上写入逻辑与事件重建脚本目前存在语义漂移：价格事件在线阈值为 2%，重建脚本为 3%；在线 `delisted.occurredAt` 使用 full crawl 完成时间，重建脚本只能使用 `last_seen_at`。如果事件表被定义为可重建缓存，这两处必须统一，并补充足够的 crawl-run 事实。

## 5. 建议对外接口

### 5.1 `product.ingestObservationBatch`（P0，新）

这是 Mac mini 清洗/处理节点写 Product DB 的主入口。建议一个请求最多 50～100 个 SKU，每个 item 独立事务或独立结果，避免一个坏产品回滚整批。

示意输入：

```json
{
  "schemaVersion": "3.0",
  "run": {
    "runId": "uuid",
    "source": "crawl-automation:<runId>",
    "channel": "gnc",
    "siteKey": "gnc.com",
    "scopeKey": "gnc:brand:optimum-nutrition",
    "scopeType": "brand",
    "crawlScope": "full",
    "startedAt": "ISO-8601"
  },
  "observations": [
    {
      "idempotencyKey": "<runId>:gnc:379969",
      "listing": {
        "externalId": "379969",
        "sourceUrl": "https://www.gnc.com/.../379969.html",
        "titleRaw": "渠道原始标题",
        "sku": "379969",
        "gtin": "048107252779",
        "brandRaw": "Optimum Nutrition",
        "brandKey": "optimum-nutrition",
        "listedAt": null,
        "listedAtSource": null,
        "attrs": {
          "flavor": "Vanilla Cream",
          "size": "4 lb"
        }
      },
      "product": {
        "companyId": "uuid-or-null",
        "domain": "optimumnutrition.com",
        "name": "Gold Standard 100% Whey — Vanilla Cream 4 lb",
        "form": "powder",
        "healthFunctions": [],
        "mainIngredients": []
      },
      "snapshot": {
        "capturedAt": "ISO-8601",
        "price": "74.99",
        "currency": "USD",
        "listPrice": null,
        "rating": 4.7,
        "reviewCount": 1000,
        "salesRank": null,
        "inStock": true,
        "unitsSold": null,
        "unitsSoldPeriod": null,
        "extras": {
          "categoryPath": ["Protein", "Whey Protein"]
        }
      },
      "images": [
        {
          "clientRef": "front-1",
          "url": "https://...",
          "role": "gallery"
        },
        {
          "clientRef": "facts-1",
          "url": "https://.../379969_lbl.pdf#page=1",
          "role": "facts"
        }
      ],
      "facts": {
        "idempotencyKey": "<runId>:gnc:379969:facts",
        "sourceImageRef": "facts-1",
        "capturedAt": "ISO-8601",
        "source": "crawl-automation:<runId>:label_ocr",
        "confidence": 95,
        "servingSize": 1,
        "servingUnit": "scoop",
        "servingsPerContainer": 64,
        "netContent": "4 lb",
        "rows": [
          {
            "name": "Protein",
            "amountValue": 24,
            "amountUnit": "g",
            "dvPercent": null,
            "position": 0,
            "isActive": true,
            "parentPosition": null
          }
        ]
      },
      "familyHint": {
        "parentExternalId": "group-id",
        "name": "Gold Standard 100% Whey",
        "label": "Vanilla Cream · 4 lb",
        "evidence": "explicit"
      }
    }
  ]
}
```

接口内部顺序应是：

1. 解析 company + brand；
2. 规范化 form 和 Facts，得到 `formulaId/factsHash`；
3. 先查已有 Listing，再执行跨渠道同品解析；
4. 确定最终 `productId` 后创建/更新 Listing；
5. 追加 snapshot、formula observation、图片和关系；
6. 同事务维护 latest、daily、status 和 change events；
7. 返回逐项回读所需的稳定 ID 与身份判断。

示意输出：

```json
{
  "runId": "uuid",
  "results": [
    {
      "idempotencyKey": "<runId>:gnc:379969",
      "status": "recorded",
      "productId": "uuid",
      "listingId": "uuid",
      "companyId": "uuid",
      "formulaId": "uuid-or-null",
      "factsHash": "sha256-or-null",
      "identity": {
        "decision": "existing_listing|cross_channel_match|gtin_match|new_product|needs_review",
        "matchedProductId": "uuid-or-null",
        "confidence": 100,
        "reasons": []
      },
      "observation": {
        "snapshotInserted": true,
        "formulaObservationInserted": true,
        "latestUpdated": true,
        "statusBefore": "inactive",
        "statusAfter": "active",
        "events": ["listing_new"]
      },
      "images": [
        {
          "clientRef": "facts-1",
          "imageId": "uuid",
          "listingId": "uuid"
        }
      ],
      "problems": []
    }
  ]
}
```

### 5.2 `product.verifyObservationBatch`（P0，新）

入库后的独立回读门禁。输入 runId 或一组 `(channel, siteKey, externalId)`，输出：

- `productId`、`listingId`、`companyId`；
- Listing 当前 `status`、`firstSeenAt`、`lastSeenAt`、`latestSnapshotAt`；
- 最新 snapshot 是否存在且关键字段一致；
- formula observation / formula 是否存在；
- SKU、GTIN、form、family 是否一致；
- 身份判断是否为 `needs_review`；
- `missing`、`problems` 和确定性的 `readbackHash`。

只有 `verified == expected` 且 `problems=[]`，管线才可进入 full-crawl 收口和本地文件清理。

### 5.3 `product.completeCrawlRun`（P0，替代/升级 `completeFullCrawl`）

示意输入：

```json
{
  "runId": "uuid",
  "channel": "gnc",
  "siteKey": "gnc.com",
  "scopeKey": "gnc:brand:optimum-nutrition",
  "scopeType": "brand",
  "companyId": "uuid",
  "startedAt": "ISO-8601",
  "completedAt": "ISO-8601",
  "crawlScope": "full",
  "proof": {
    "paginationExhausted": true,
    "productLimitHit": false,
    "challengeSeen": false,
    "discoveredCount": 48,
    "observedCount": 48,
    "verifiedCount": 48,
    "failedCount": 0,
    "needsReviewCount": 0,
    "listingSetHash": "sha256"
  }
}
```

数据库必须先核对该 run 已记录并验证的 Listing 数量，再执行缺席判定。返回值应包含：

- `replayed`：是否为同一 run 的幂等重放；
- `scopeListingCount`；
- `deactivatedListingIds`；
- `events`；
- `problems`。

对于品牌页和 DTC 官网，`companyId`、`scopeKey` 必须必填。仅按 channel 全量下架的能力应限制为内部管理员接口。

### 5.4 `company.resolveProductOwner`（P0，新或补足现有查询）

固定 Sales Channel 页面展示的是产品品牌，而不是零售商本身。GNC 商品不能因为页面域名是 `gnc.com` 就一律归给 GNC 公司。

输入应支持 `brandRaw`、品牌官网 domain、channel、sourceUrl；输出应为：

- 唯一 `companyId`；
- `brandKey` / Sub-brand ID；
- canonical domain；
- `matchedBy`；
- ambiguous candidates。

无法唯一解析时返回 `needs_review`，不得随意创建公司或归到零售渠道公司。

### 5.5 `product.getProcessingVocabulary`（P0，可由已有接口组合）

Mac mini 语义处理需要只读获取：

- canonical forms；
- health functions；
- ingredient categories/groups 的必要匹配信息；
- vocabulary revision/hash。

响应必须可缓存，并带 revision，保证同一 run 使用同一版词表。

### 5.6 `product.upsertFamilyMemberships`（P1，新）

只接收有明确页面证据的 family 关系。输入为公司、family 名、成员 product/listing、family label、外部 parent ID 和 evidence。接口应幂等，并在 family 冲突时返回审核，不能靠产品名自动归组。

### 5.7 `product.previewMerge` / `product.mergeProducts`（P0 内部接口）

用于“先创建临时产品，后取得 Facts 才确认同品”的场景。

`previewMerge` 返回 survivor、loser、全部将改挂的子表数量、唯一键冲突和建议动作。`mergeProducts` 必须：

1. 单事务运行；
2. 有 idempotency key；
3. 搬运 Listing、snapshot 关联、formula observation、图片、sales、M2M 关系、family、change events 等所有子数据；
4. 保留最完整的 SKU/GTIN/名称和语义字段；
5. 写正式 `product_merge_log` 和身份判断证据；
6. 合并后重算或修正 `first_seen` / `listing_new` 等派生事件；
7. 返回不变量校验结果。

这个接口只能由数据库内部身份解析器或人工审核调用，不对普通爬虫开放。

## 6. 需要补充的数据结构/约束

### 6.1 DTC Listing 命名空间

推荐给 `product_channel` 增加 `site_key` / `merchant_key`，唯一键改为：

```text
(channel, site_key, external_id)
```

Amazon/GNC/Swanson 属于 marketplace，`site_key` 恒为 NULL；品牌级 full crawl 使用 `channel + companyDomain` 限定作用域。DTC 使用规范化官网域名作为 `siteKey`。若暂时不改表，调用方必须把 domain 编入 DTC `externalId`，但这只是兼容方案。

### 6.2 Crawl Run 与 Scope 观测

至少需要保存：

```text
crawl_run(
  run_id, channel, site_key, scope_key, scope_type, company_id,
  started_at, completed_at, crawl_scope, status,
  discovered_count, observed_count, verified_count,
  completeness_proof, listing_set_hash
)

crawl_run_listing(run_id, listing_id, observed_at)
```

这样才能审计某次下架判断、保证重放幂等，并重建“下架—复活—再次下架”的历史。只保存 `product_channel.status=inactive` 不足以重建历史事件。

### 6.3 Formula Observation 幂等

`formula_observation` 当前只有普通索引，没有唯一幂等约束。建议新增稳定 `observation_key`，并设唯一索引；或者使用不会受 NULL 语义影响的等价唯一键。

仅以 `(product_id, formula_id, observed_at)` 去重也不充分，因为同一时刻可能有不同 Listing/来源的独立证据。

### 6.4 Brand、SKU、GTIN 与 Listed At

- `brandRaw/brandKey` 必须进入 Listing 身份证据，不能处理后丢失。
- SKU 应成为观测接口的一等字段；短期可落 `product_channel.attrs.sku`。
- GTIN 应写 `product.gtin`，并保留来源；GNC 当前抓到的 UPC 不能只藏在 attrs。
- `listedAt` 和 `listedAtSource` 已存在于 `product_channel`，需要补到写入接口。

### 6.5 Snapshot Extras

`listing_snapshot.extras` 已存在，但当前 enrich 契约没有透传。订阅价、促销标记、类目路径、Prime/会员价等渠道异构观测应进入 `extras`，不能丢失，也不应不断扩公共列。

### 6.6 图片溯源

当前 enrich 只返回创建图片数量，Facts 接口却要求 `imageId`。统一批量接口应通过 `clientRef` 在同一事务内解析并返回 `imageId`。

当前图片按 product + URL 去重会丢掉“同一图片 URL 也在另一渠道 Listing 出现”的多源关系。长期建议拆出 Listing-image 关联表，或至少允许一张图片关联多条 Listing。

### 6.7 Product Discontinued 当前态

`product.discontinued_at` 不应由单个 Listing 下架直接填写。建议由数据库派生：只有产品全部可信 Listing 均 inactive 时才可标记；任一 Listing 恢复 active 时清除或重新计算。stale 不能等价为 discontinued。

## 7. Full Crawl 安全门禁

只有同时满足以下条件，运行才可声明 `full` 并调用 `completeCrawlRun`：

1. 输入 URL 是可定义边界的官方品牌页、店铺目录或 DTC 全目录，不是任意搜索页/单商品页。
2. 所有分页或 Load More 已程序化耗尽。
3. 没有命中数量上限。
4. 没有 challenge、登录墙、区域错误或 HTTP 失败。
5. 所有发现的商品页和可售变体均成功处理。
6. 每个变体都成为独立 SKU 产品观测。
7. 入库逐项成功并通过独立回读。
8. 没有待人工审核项。
9. 本轮只对应一个明确的 company/brand scope。

任意一项不满足都只能是 `partial`，partial 运行不得触发缺席下架。

当前渠道判断：

- Amazon 普通品牌搜索仍受 7 页/306 条上限约束，只能 `partial`；输入 Brand Store 并程序化耗尽全部导航、Shop All 与变体时可升级为 `full`。
- GNC 品牌页只有在 Load More 完全耗尽、无 maxItems 截断、所有变体成功且回读通过后，才可升级为 `full`。
- DTC 只有全目录证据通过完整性门禁时为 `full`；单商品抓取、限制数量或中途中断均为 `partial`。

`crawlScope` 属于 run，不应交给模型按每个产品自由填写。

## 8. 推荐完整流程

```text
Browser / Fixed Adapter 抓取
  → 产出页面、图片、SKU/变体与程序化完整性证据
  → Mac mini OCR 并发 + Codex 语义结构化
  → resolveProductOwner + 固定词表版本
  → ingestObservationBatch
       ├─ 规范化 Facts / form
       ├─ 解析最终 product 身份
       ├─ 写 Listing + snapshot + formula observation + images
       └─ 派生 latest / daily / events
  → upsertFamilyMemberships（有显式 family 证据时）
  → verifyObservationBatch
  → 若且仅若 full 门禁通过：completeCrawlRun
  → 成功后清理云端与本地临时文件
```

处理过程中发生任何失败或 `needs_review`：保留复核产物，不调用 `completeCrawlRun`，不做下架判断。

## 9. 当前本项目的具体差距

当前 `apps/backend/src/supply-smart-ingest.ts` 通过原始 SQL 直写数据库，存在以下差距：

1. 新渠道 externalId 未命中时直接创建新 product，没有跨渠道 formula/brand/form/name 匹配。
2. 没有创建 `first_seen`、`listing_new`、价格变化、formula 变化等事件。
3. 没有维护 `listing_metric_daily`。
4. 没有调用或实现 full-crawl 收口，因此不会生成可靠 `delisted`。
5. 没有写 `listed_at/listed_at_source`、GTIN、snapshot extras。
6. Family 是本项目直接 SQL 维护，切到 API 后需要正式接口承接。
7. 回读只检查少量 product/listing/formula 字段，没有检查 snapshot、状态、事件和 crawl scope。
8. DTC externalId 还没有强制站点命名空间。

Amazon、GNC、Swanson 已改为共享 run 级程序化门禁：完整品牌目录可 full，单品、搜索、截断和未耗尽目录均为 partial。DTC 同样由全目录证据决定 full/partial。

在 Product DB 接口补齐前，不应在本项目继续复制完整的事件和 Listing 生命周期逻辑，否则两边会再次产生不同真源。

## 10. 验收测试清单

数据库接口至少应覆盖以下集成测试：

1. 同一 GNC 观测重复提交两次：snapshot、formula observation、事件均不重复。
2. 旧 capturedAt 的迟到观测可保存，但不能回退 latest 字段。
3. 同品牌、同 formula、同 form、相似名字、同规格的新渠道 Listing：复用 product，产生 `listing_new`，不产生第二个 `first_seen`。
4. 条件相同但 30/60 servings 冲突：不合并，分别创建 product，可进入同 family。
5. formula 相同但 form 不同：不自动合并。
6. formula 和名字相似但 brandKey 不同：不自动合并。
7. 两个 DTC 网站都有 externalId=`123`：生成两条不同 Listing，不撞唯一键。
8. `inStock=false`：Listing 保持 active。
9. partial crawl 缺少旧 Listing：不得下架。
10. full crawl 同 scope 缺少旧 Listing：只把该 scope 的对应 Listing 置 inactive，并产生一次 delisted。
11. 同一 full run 重放：不重复下架、不重复发事件。
12. 其他品牌/其他 DTC 站点 Listing 不受本次 full crawl 影响。
13. inactive Listing 再次被观测：恢复 active；是否产生 relisted 按统一规则验收。
14. Facts 的 source image 能通过 clientRef 回读到真实 imageId/listingId。
15. 合并 loser → survivor 后，Listing、snapshot、formula observation、图片、sales、family 和事件无孤儿、无丢失。
16. 事件重建结果与在线派生结果一致，包括价格阈值和 delisted 时间。

## 11. 不应提供给爬虫的接口

以下动作必须留在数据库事务内部：

- `createFirstSeenEvent`
- `createListingNewEvent`
- `createDelistedEvent`
- `setListingInactive`
- `setProductDiscontinued`
- 无审计的 `reassignListingProduct`

爬虫只能提交观测、完整性证明和显式 family 证据。事件与状态均由 Product DB 根据事实派生。

## 12. 参考真源

- Jakarta 产品结构：`packages/product-db/src/schema/product-schema.ts`
- Jakarta 观测写入：`packages/database-api/src/dao/product-dao.ts`
- Jakarta API schema：`packages/database-api/src/schemas/product-schema.ts`
- Jakarta 生命周期测试：`packages/database-api/test/liveness.test.ts`
- Jakarta 观测设计：`docs/product-db-v2/02-ingestion.md`
- Jakarta 既有去重规则：`docs/packages/product-db/reference/product-deduplication.md`
- 当前本项目直连入库：`apps/backend/src/supply-smart-ingest.ts`
- 当前 GNC 管线：`apps/backend/src/gnc/pipeline.ts`
- 当前 Amazon 管线：`apps/backend/src/amazon/pipeline.ts`
- 当前 DTC 管线：`apps/backend/src/dtc-pipeline.ts`
