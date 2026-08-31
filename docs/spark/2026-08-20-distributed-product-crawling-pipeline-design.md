# 分布式商品抓取流水线 v2

- 日期：2026-08-26
- 状态：实现中，代码契约已迁移
- 真源：本仓库代码与 `docs/product-crawl-pipeline.html`

## 目标

这套系统用程序控制队列、并发、租约、恢复、审核和清理。Codex 只承担两类需要理解能力的工作：Windows 上的陌生 DTC 网站抓取，以及 Mac 上的产品语义/标签 OCR 文本转换。

固定站点不再每次交给抓取 Skill。Amazon、GNC、Swanson 都使用仓库内固定 Adapter，只保留各自的目录、分页、变体和详情提取差异；之后共享 Product Unify、OCR、Observation RPC 与 full/partial 下架门禁。

## 节点与并发

| 节点 | 职责 | 硬并发 |
| --- | --- | --- |
| Railway | 控制面、PostgreSQL 队列、租约、审核、对象引用 | 不运行 Chrome/Codex/OCR |
| Windows Browser Node | DTC 网站；Codex Luna Medium + 可编程 Chrome + `crawl-products` Skill | 2 个站点 |
| Mac mini Worker | DTC process、Amazon/GNC/Swanson 固定 Adapter、Jakarta Observation RPC、清理 | 2 个 Job |
| OCR HTTP API | 接收单张图片并返回文字行与坐标 | 每个 Job 默认 4 张并发 |
| Mac Codex | Nutrition/功效/剂型/成分与 OCR Facts 文本转换 | 全局 2 个进程 |

Mac 两个 Job 共享同一个 Codex semaphore，所以两个 Job 同时运行时也不会把 Codex 进程放大到 4 个。OCR 是无状态接口，不是 Worker 队列，也没有 OCR Job 或 OCRBundle。

## 两条 DAG

### DTC

```text
capture [Windows/browser]
  -> process [Mac/process]
  -> ingest [Mac/ingest]
  -> cleanup [Mac/cleanup]
```

1. Windows 领取一个网站，拉取最新 Skill 代码并使用 `crawl-products`。
2. 每个可售变体作为独立 item；保留真实 SKU，缺失时 `sku=null`、`skuMissing=true`。
3. 每 25–50 个 item 原子发布一个 EvidenceBundleV1，并上传对象存储。
4. Mac 下载并校验 SHA256，解压一次。
5. 程序把全部图片并发送到 OCR API，结果写在图片旁的 `.ocr.json`。
6. Mac Codex 只读页面证据和 OCR 文本；它不再调用抓取 Skill，也不操作浏览器。
7. 结构校验通过后上传一个小型 `normalized` JSON，供 ingest Job 使用。
8. ingest 通过 Jakarta Product Server 写 Observation、回读、收口并再次回读；成功后 cleanup 删除云端产物和 Mac 整个 run 目录。

### 固定 Sales Channel（Amazon / GNC / Swanson）

```text
process [Mac/amazon|gnc|swanson]
  -> cleanup [Mac/cleanup]
```

Sales Channel process 在一个可恢复 Job 中完成完整流程，不上传 EvidenceBundle：

1. 输入必须是品牌全部商品页才能争取 `full`；单品页和普通搜索页只能 `partial`。
2. Amazon 遍历 Brand Store 导航并展开 ASIN variation family；GNC 耗尽 Load More 并展开 ProductGroup；Swanson 耗尽 Constructor 分页并展开 Shopify variation。
3. 每个 ASIN/SKU 都单独抓取，因此每个变体拥有自己的详情、图片和挂牌身份。
4. Adapter 输出页数、总数、耗尽、截断、发现数和处理数；共用代码据此决定 full/partial，模型无权决定。
5. 确定性提取器读取标题、品牌、价格、评分、库存、画廊和渠道结构化字段。
6. Nutrition 语义协议按最多 50 条切批；Mac 全局最多两个 Luna Medium 调用。
7. 程序下载完整画廊，并发调用 OCR API；OCR 文字进入 Facts 与语义解析。
8. Product Unify 统一 productName/baseName，并只输出允许的 strict variant key。
9. 结果通过 Jakarta Observation RPC 入库、回读和收口；每个渠道稳定 ID 独立入库。
10. `full` run 在同一 channel + company 范围内把本轮缺席 Listing 置 inactive 并产生 delisted；`partial` 永远不做缺席下架。
11. 完成后再次回读全部通过，cleanup 才删除本地快照、图片、OCR sidecar 和模型输出。

## 数据契约

最终中间结构是 `ProductBatchV2`：

```text
ProductBatchV2
  schemaVersion = 2.0
  products[]
    domain
    productName / productUrl
    channel / externalId / sourceUrl / capturedAt
    sku / skuMissing
    price / currency / rating / reviewCount / salesRank / inStock
    images[]
    healthFunctions[]
    mainIngredients[]
    productForm
    nutritionScope
    variantAttrs
    family
  facts[]
    channel / externalId / sourceUrl / capturedAt
    confidence
    servingSize / servingUnit / servingsPerContainer
    rows[]
```

写入边界：

- `product` / `product_channel` / `listing_snapshot`：SKU 粒度产品、挂牌身份和追加式观测。
- `product_image` / `product_*`：图片、功效、剂型和主要成分关系。
- `formula` / `formula_ingredient` / `formula_observation`：从 OCR Facts 面板解析出的结构化配方与时间轴。
- SKU 与 family 信息进入 listing `attrs`；`channel + externalId` 是挂牌幂等身份，存在 externalId 时禁止降级按 URL/标题合并。
- 每条写入后按 `(channel, externalId)` 回读产品、SKU 和 Formula；全部通过才允许 cleanup。

## 恢复与审核

控制面 PostgreSQL 是全局任务真源；每台执行机器的 SQLite 只保存租约、阶段、Codex thread 和本地 checkpoint。

Amazon Job 还会把这些可重放文件放在 run 目录：

- `pages/<ASIN>.html.br`
- `extracted/<ASIN>.json`
- `semantic.json`
- `images/<ASIN>/<index>.<ext>`
- `images/<ASIN>/<index>.<ext>.ocr.json`
- `images/<ASIN>/label.raw.json`
- `product-batch.json`
- `ingest-result.json` 或 review 报告

出现下列情况进入 `needs_review`，不执行 cleanup：

- CAPTCHA、不可读页面或没有稳定 ASIN/externalId。
- 品牌无法唯一映射到产品库公司域名。
- 多张图明确属于不同配方，无法映射到一个变体。
- OCR 命中 Facts 结构但解析不出合法成分行。
- 产品库公司匹配、listing 观测、Facts 录入或回读失败。
- DTC 变体/SKU/证据存在冲突。

人工选择 retry/resume 后继续同一个 Job 目录，复用快照、OCR sidecar 和模型输出。人工 abandon 只改变任务状态；物理清理仍应走明确的清理动作，避免误删审核证据。

## 文件生命周期

- DTC：Windows EvidenceBundle 上传并确认；Mac 保留下载副本直到 ingest 回读成功。
- Amazon：原始页面和图片始终只在 Mac 本地，不经过对象存储。
- `needs_review`：云端与 Mac 文件持续保留。
- 成功：cleanup 先删对象存储产物，再删 Mac run 目录；删除失败会重试，不回滚已经成功的业务入库。

## Skill 边界

- DTC `capture`：必须使用 `crawl-products` Skill，并在任务开始时拉取最新 Skill。
- DTC `process`：不得使用 Skill；按固定处理程序执行 OCR、语义转换和 Schema 门禁。
- Amazon `process`：不得使用 Skill；使用仓库内固定 Adapter。
- OCR：只识字，不判断 Benefits、Ingredients、Facts 的业务含义；Facts 候选先由程序检查 OCR 结构信号，再由 Luna 解析文字。
